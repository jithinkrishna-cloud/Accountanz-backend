import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import type { SpaceContext } from "./project.types.js";

const m = vi.hoisted(() => ({
  conn: { tag: "tx" },
  keyTaken: vi.fn(),
  clientExists: vi.fn(),
  lockClient: vi.fn(),
  countActiveClientSpaces: vi.fn(),
  insertSpace: vi.fn(),
  findSpace: vi.fn(),
  findPrimarySpace: vi.fn(),
  setArchived: vi.fn(),
  spaceDeletionInfo: vi.fn(),
  deleteSpaceRows: vi.fn(),
  listStatuses: vi.fn(),
  recordAudit: vi.fn(),
  effectiveEntitlement: vi.fn(),
  onEngagementActivated: vi.fn(),
  requireLinkableClient: vi.fn(),
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../../utils/file-storage.js", () => ({ deleteFile: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../access/client-access.js", () => ({ canAccessClient: vi.fn(), clientScope: vi.fn(), requireLinkableClient: m.requireLinkableClient }));
vi.mock("./client-space-hooks.js", () => ({ onEngagementActivated: m.onEngagementActivated }));
vi.mock("./client-spaces.js", () => ({ syncPrimaryMembers: vi.fn() }));
vi.mock("./entitlement.js", () => ({
  effectiveEntitlement: m.effectiveEntitlement,
  isPortalAdminRole: (role: string) => role === "super_admin" || role === "ops_admin",
}));
vi.mock("./project.repository.js", () => ({
  keyTaken: m.keyTaken,
  clientExists: m.clientExists,
  lockClient: m.lockClient,
  countActiveClientSpaces: m.countActiveClientSpaces,
  insertSpace: m.insertSpace,
  findSpace: m.findSpace,
  findPrimarySpace: m.findPrimarySpace,
  setArchived: m.setArchived,
  spaceDeletionInfo: m.spaceDeletionInfo,
  deleteSpaceRows: m.deleteSpaceRows,
  listStatuses: m.listStatuses,
}));

const svc = await import("./project.service.js");
const { createSpaceSchema } = await import("./project.validation.js");

const user = (role: string, id = 1) => ({ id, role }) as unknown as AuthUser;
const ops = user("ops_admin");
const staff = user("accountant", 9);
const growth = { packageName: "Growth", workspaceLimit: 3, staffPerWorkspace: 5, teamRoles: [], base: { workspaces: 3, staff: 5 } };
const project = { name: "Audit 2026", space_key: "AUD", template: "kanban" as const, kind: "client_project" as const, client_id: 5, description: null };
const space = (over: Partial<SpaceContext> = {}): SpaceContext => ({ id: 20, key: "AUD", name: "Audit 2026", template: "kanban", client_id: 5, kind: "client_project", archived_at: null, role: "admin", ...over });

const LIMIT_COPY = "The Growth package allows 3 client workspaces. Archive one or ask a Super admin for more room.";
const PRIMARY_COPY = "The primary client space is archived and restored automatically with the client's engagement";

beforeEach(() => {
  vi.resetAllMocks();
  m.keyTaken.mockResolvedValue(false);
  m.clientExists.mockResolvedValue(true);
  m.effectiveEntitlement.mockResolvedValue(growth);
  m.countActiveClientSpaces.mockResolvedValue(1);
  m.insertSpace.mockResolvedValue(99);
  m.findSpace.mockResolvedValue({ id: 99 });
  m.listStatuses.mockResolvedValue([]);
});

describe("createSpace for client projects", () => {
  it("refuses staff with the Staff create copy", async () => {
    await expect(svc.createSpace(staff, project)).rejects.toMatchObject({ code: "FORBIDDEN", message: "Ask an admin to create client spaces" });
    expect(m.insertSpace).not.toHaveBeenCalled();
  });

  it("refuses a client with no package", async () => {
    m.effectiveEntitlement.mockResolvedValue(null);
    await expect(svc.createSpace(ops, project)).rejects.toMatchObject({ code: "CONFLICT", message: "This client has no active package" });
  });

  it("refuses at the limit with the Workspace limit copy", async () => {
    m.countActiveClientSpaces.mockResolvedValue(3);
    await expect(svc.createSpace(ops, project)).rejects.toMatchObject({ code: "CONFLICT", message: LIMIT_COPY });
    expect(m.lockClient).toHaveBeenCalledWith(5, m.conn);
  });

  it("allows creation when archived spaces freed room (count excludes them)", async () => {
    m.countActiveClientSpaces.mockResolvedValue(2);
    await svc.createSpace(ops, project);
    expect(m.insertSpace).toHaveBeenCalledWith(project, "client_project", ops.id, ops.id, m.conn);
  });

  it("refuses new spaces when over the limit after a downgrade, without touching existing ones", async () => {
    m.countActiveClientSpaces.mockResolvedValue(4);
    await expect(svc.createSpace(ops, project)).rejects.toMatchObject({ message: LIMIT_COPY });
    expect(m.setArchived).not.toHaveBeenCalled();
  });

  it("never refuses an Unlimited package", async () => {
    m.effectiveEntitlement.mockResolvedValue({ ...growth, workspaceLimit: null });
    m.countActiveClientSpaces.mockResolvedValue(50);
    await svc.createSpace(ops, project);
    expect(m.insertSpace).toHaveBeenCalled();
  });
});

describe("createSpace for internal spaces", () => {
  it("rejects a client_id in the schema", () => {
    const r = createSpaceSchema.safeParse({ name: "Ops", space_key: "OPS", template: "kanban", client_id: 5 });
    expect(r.success).toBe(false);
  });

  it("defaults kind to internal and requires client_id for client_project", () => {
    const ok = createSpaceSchema.parse({ name: "Ops", space_key: "OPS", template: "kanban" });
    expect(ok.kind).toBe("internal");
    expect(createSpaceSchema.safeParse({ name: "Ops", space_key: "OPS", template: "kanban", kind: "client_project" }).success).toBe(false);
  });

  it("inserts as internal with no limit check", async () => {
    await svc.createSpace(staff, { ...project, kind: "internal", client_id: null });
    expect(m.insertSpace).toHaveBeenCalledWith(expect.anything(), "internal", staff.id, staff.id, m.conn);
    expect(m.effectiveEntitlement).not.toHaveBeenCalled();
  });
});

describe("delete and archive", () => {
  it("refuses to delete a primary space", async () => {
    await expect(svc.deleteSpace(ops, space({ kind: "client_primary" }), "AUD")).rejects.toMatchObject({ code: "CONFLICT", message: PRIMARY_COPY });
  });

  it("refuses to archive or unarchive a primary space", async () => {
    await expect(svc.archiveSpace(ops, space({ kind: "client_primary" }))).rejects.toMatchObject({ message: PRIMARY_COPY });
    await expect(svc.unarchiveSpace(ops, space({ kind: "client_primary" }))).rejects.toMatchObject({ message: PRIMARY_COPY });
  });

  it("archives a project space and audits it", async () => {
    await svc.archiveSpace(ops, space());
    expect(m.setArchived).toHaveBeenCalledWith(20, true, m.conn);
    expect(m.recordAudit).toHaveBeenCalledWith(ops, expect.objectContaining({ action: "Workspace space archived" }), m.conn);
  });

  it("unarchive at the limit is refused", async () => {
    m.countActiveClientSpaces.mockResolvedValue(3);
    await expect(svc.unarchiveSpace(ops, space({ archived_at: "2026-01-01" }))).rejects.toMatchObject({ code: "CONFLICT", message: LIMIT_COPY });
    expect(m.setArchived).not.toHaveBeenCalled();
  });

  it("unarchive with room restores and audits", async () => {
    await svc.unarchiveSpace(ops, space({ archived_at: "2026-01-01" }));
    expect(m.setArchived).toHaveBeenCalledWith(20, false, m.conn);
    expect(m.recordAudit).toHaveBeenCalledWith(ops, expect.objectContaining({ action: "Workspace space unarchived" }), m.conn);
  });

  it("requires a space admin to archive", async () => {
    await expect(svc.archiveSpace(staff, space({ role: "member" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("archives an internal space without a client lock", async () => {
    await svc.archiveSpace(staff, space({ kind: "internal", client_id: null }));
    expect(m.lockClient).not.toHaveBeenCalled();
    expect(m.setArchived).toHaveBeenCalled();
  });
});

describe("provisionPrimary", () => {
  it("is for portal admins only", async () => {
    await expect(svc.provisionPrimary(staff, 5)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns No package copy without an active engagement", async () => {
    m.effectiveEntitlement.mockResolvedValue(null);
    await expect(svc.provisionPrimary(ops, 5)).rejects.toMatchObject({ code: "CONFLICT", message: "This client has no active package" });
    expect(m.onEngagementActivated).not.toHaveBeenCalled();
  });

  it("creates the primary and is idempotent, returning the same space", async () => {
    m.findPrimarySpace.mockResolvedValue({ id: 77, archived_at: null });
    m.findSpace.mockResolvedValue({ id: 77 });
    const first = await svc.provisionPrimary(ops, 5);
    const again = await svc.provisionPrimary(ops, 5);
    expect(first).toEqual({ id: 77 });
    expect(again).toEqual({ id: 77 });
    expect(m.onEngagementActivated).toHaveBeenCalledWith(ops, 5, m.conn);
  });
});
