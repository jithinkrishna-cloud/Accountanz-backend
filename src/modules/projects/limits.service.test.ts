import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import type { SpaceContext } from "./project.types.js";

const m = vi.hoisted(() => ({
  conn: { tag: "tx" },
  effectiveEntitlement: vi.fn(),
  insertOverride: vi.fn(),
  findActiveOverride: vi.fn(),
  revokeOverrideRow: vi.fn(),
  listActiveOverrides: vi.fn(),
  countActiveClientSpaces: vi.fn(),
  countStaffSeats: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("./entitlement.js", () => ({ effectiveEntitlement: m.effectiveEntitlement, isPortalAdminRole: (r: string) => r === "super_admin" || r === "ops_admin" }));
vi.mock("./project.repository.js", () => ({
  insertOverride: m.insertOverride,
  findActiveOverride: m.findActiveOverride,
  revokeOverrideRow: m.revokeOverrideRow,
  listActiveOverrides: m.listActiveOverrides,
  countActiveClientSpaces: m.countActiveClientSpaces,
  countStaffSeats: m.countStaffSeats,
}));

const ls = await import("./limits.service.js");
const { grantOverrideSchema } = await import("./project.validation.js");

const sup = { id: 1, role: "super_admin" } as unknown as AuthUser;
const ops = { id: 2, role: "ops_admin" } as unknown as AuthUser;
const space: SpaceContext = { id: 20, key: "GL", name: "Green Leaf", template: "kanban", client_id: 5, kind: "client_primary", archived_at: null, role: "admin" };
const ent = (ws: number | null) => ({ packageName: "Growth", workspaceLimit: ws, staffPerWorkspace: 5, teamRoles: [], base: { workspaces: 3, staff: 5 } });

beforeEach(() => {
  vi.resetAllMocks();
  m.insertOverride.mockResolvedValue(31);
  m.listActiveOverrides.mockResolvedValue([]);
  m.countActiveClientSpaces.mockResolvedValue(2);
  m.countStaffSeats.mockResolvedValue(1);
});

describe("grantOverride", () => {
  const input = { limit_type: "workspaces" as const, extra: 2, reason: "Seasonal audit work", expires_at: null };

  it("is Super admin only", async () => {
    await expect(ls.grantOverride(ops, space, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.insertOverride).not.toHaveBeenCalled();
  });

  it("validates reason, size and expiry in the schema", () => {
    expect(grantOverrideSchema.safeParse({ limit_type: "workspaces", extra: 2 }).success).toBe(false);
    expect(grantOverrideSchema.safeParse({ limit_type: "workspaces", extra: 2, reason: "  " }).success).toBe(false);
    expect(grantOverrideSchema.safeParse({ limit_type: "workspaces", extra: 100, reason: "Because" }).success).toBe(false);
    expect(grantOverrideSchema.safeParse({ limit_type: "workspaces", extra: 2, reason: "Because", expires_at: "2000-01-01" }).success).toBe(false);
    expect(grantOverrideSchema.safeParse({ limit_type: "workspaces", extra: 2, reason: "Because", expires_at: "2999-01-01" }).success).toBe(true);
  });

  it("writes the audit with before and after", async () => {
    m.effectiveEntitlement.mockResolvedValueOnce(ent(3)).mockResolvedValueOnce(ent(5));
    await ls.grantOverride(sup, space, input);
    expect(m.insertOverride).toHaveBeenCalledWith({ clientId: 5, limitType: "workspaces", extra: 2, reason: "Seasonal audit work", expiresAt: null, createdBy: 1 }, m.conn);
    const [, entry] = m.recordAudit.mock.calls[0];
    expect(entry.action).toBe("Workspace entitlement override granted");
    expect(entry.clientId).toBe(5);
    expect(entry.details).toContain("before 3 → after 5");
    expect(entry.details).toContain("Seasonal audit work");
  });

  it("conflicts when the client has no package", async () => {
    m.effectiveEntitlement.mockResolvedValue(null);
    await expect(ls.grantOverride(sup, space, input)).rejects.toMatchObject({ code: "CONFLICT", message: "This client has no active package" });
  });

  it("is not available for internal spaces", async () => {
    await expect(ls.grantOverride(sup, { ...space, client_id: null, kind: "internal" }, input)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("revokeOverride", () => {
  it("is Super admin only", async () => {
    await expect(ls.revokeOverride(ops, space, 31)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("404s on an unknown or already revoked override", async () => {
    m.findActiveOverride.mockResolvedValue(null);
    await expect(ls.revokeOverride(sup, space, 31)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revokes and audits before 5 to after 3", async () => {
    m.findActiveOverride.mockResolvedValue({ id: 31, limit_type: "workspaces", extra: 2, reason: "Seasonal", expires_at: null });
    m.effectiveEntitlement.mockResolvedValueOnce(ent(5)).mockResolvedValueOnce(ent(3));
    await ls.revokeOverride(sup, space, 31);
    expect(m.revokeOverrideRow).toHaveBeenCalledWith(31, 1, m.conn);
    const [, entry] = m.recordAudit.mock.calls[0];
    expect(entry.action).toBe("Workspace entitlement override revoked");
    expect(entry.details).toContain("before 5 → after 3");
  });
});

describe("getLimits", () => {
  it("is null for internal spaces", async () => {
    expect(await ls.getLimits(sup, { ...space, client_id: null, kind: "internal" })).toBeNull();
  });

  it("combines package, overrides, effective and usage", async () => {
    m.effectiveEntitlement.mockResolvedValue(ent(5));
    const r = await ls.getLimits(sup, space);
    expect(r).toEqual({ package_name: "Growth", base: { workspaces: 3, staff: 5 }, overrides: [], effective: { workspaces: 5, staff: 5 }, usage: { workspaces: 2, staff: 1 } });
  });

  it("shows override rows to portal admins", async () => {
    m.effectiveEntitlement.mockResolvedValue(ent(5));
    const row = { id: 9, limit_type: "workspaces", extra: 2, reason: "Paid add-on Rs 999", expires_at: null };
    m.listActiveOverrides.mockResolvedValue([row]);
    expect((await ls.getLimits(sup, space))?.overrides).toEqual([row]);
    expect((await ls.getLimits(ops, space))?.overrides).toEqual([row]);
  });

  it("hides override rows from other staff but keeps the effective limits", async () => {
    m.effectiveEntitlement.mockResolvedValue(ent(5));
    m.listActiveOverrides.mockResolvedValue([{ id: 9, limit_type: "workspaces", extra: 2, reason: "secret", expires_at: null }]);
    const r = await ls.getLimits({ id: 3, role: "bookkeeper" } as unknown as AuthUser, space);
    expect(r?.overrides).toEqual([]);
    expect(r?.effective).toEqual({ workspaces: 5, staff: 5 });
    expect(m.listActiveOverrides).not.toHaveBeenCalled();
  });
});
