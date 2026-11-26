import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import type { SpaceContext } from "./project.types.js";

const m = vi.hoisted(() => ({
  conn: { tag: "tx" },
  effectiveEntitlement: vi.fn(),
  lockClient: vi.fn(),
  activeStaff: vi.fn(),
  findMember: vi.fn(),
  countStaffSeats: vi.fn(),
  countAdmins: vi.fn(),
  addMember: vi.fn(),
  setMemberRole: vi.fn(),
  listMembers: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../access/client-access.js", () => ({ isAdmin: (u: { role: string }) => ["super_admin", "ops_admin"].includes(u.role), canAccessClient: vi.fn(), clientScope: vi.fn(), requireLinkableClient: vi.fn() }));
vi.mock("../../utils/file-storage.js", () => ({ deleteFile: vi.fn() }));
vi.mock("./client-space-hooks.js", () => ({ onEngagementActivated: vi.fn() }));
vi.mock("./client-spaces.js", () => ({ syncPrimaryMembers: vi.fn() }));
vi.mock("./project-access.js", () => ({ requireSpaceAdmin: vi.fn(), spaceRoleFor: vi.fn() }));
vi.mock("./entitlement.js", async (orig) => ({ ...(await orig<typeof import("./entitlement.js")>()), effectiveEntitlement: m.effectiveEntitlement }));
vi.mock("./project.repository.js", () => ({
  lockClient: m.lockClient,
  activeStaff: m.activeStaff,
  findMember: m.findMember,
  countStaffSeats: m.countStaffSeats,
  countAdmins: m.countAdmins,
  addMember: m.addMember,
  setMemberRole: m.setMemberRole,
  listMembers: m.listMembers,
}));

const svc = await import("./project.service.js");

const actor = { id: 1, role: "super_admin" } as unknown as AuthUser;
const clientSpace = { id: 10, key: "GLPL", kind: "client_primary", client_id: 5 } as unknown as SpaceContext;
const internalSpace = { id: 11, key: "INT", kind: "internal", client_id: null } as unknown as SpaceContext;
const user = (id: number, portal_role: string) => ({ id, full_name: `U${id}`, portal_role });

beforeEach(() => {
  vi.resetAllMocks();
  m.effectiveEntitlement.mockResolvedValue({ packageName: "Starter", staffPerWorkspace: 2, teamRoles: ["bookkeeper"] });
  m.findMember.mockResolvedValue(null);
  m.countStaffSeats.mockResolvedValue(2);
  m.listMembers.mockResolvedValue([]);
});

describe("addMembers package limits", () => {
  it("refuses a staff member beyond the seat limit", async () => {
    m.activeStaff.mockResolvedValue([user(2, "bookkeeper")]);
    await expect(svc.addMembers(actor, clientSpace, { user_ids: [2], role: "member" } as never)).rejects.toThrow("The Starter package allows 2 staff per workspace");
    expect(m.lockClient).toHaveBeenCalledWith(5, m.conn);
    expect(m.addMember).not.toHaveBeenCalled();
  });

  it("refuses a role the package doesn't include", async () => {
    m.activeStaff.mockResolvedValue([user(2, "cfo")]);
    await expect(svc.addMembers(actor, clientSpace, { user_ids: [2], role: "member" } as never)).rejects.toThrow("CFO isn't included in the Starter package");
  });

  it("refuses non-admins when the client has no package", async () => {
    m.effectiveEntitlement.mockResolvedValue(null);
    m.activeStaff.mockResolvedValue([user(2, "bookkeeper")]);
    await expect(svc.addMembers(actor, clientSpace, { user_ids: [2], role: "member" } as never)).rejects.toThrow("This client has no active package");
  });

  it("allows an ops admin at full seats, as a manual add", async () => {
    m.activeStaff.mockResolvedValue([user(3, "ops_admin")]);
    await svc.addMembers(actor, clientSpace, { user_ids: [3], role: "member" } as never);
    expect(m.addMember).toHaveBeenCalledWith(10, 3, "member", 1, m.conn, "manual");
  });

  it("does not count an existing member as a new seat", async () => {
    m.activeStaff.mockResolvedValue([user(2, "bookkeeper")]);
    m.findMember.mockResolvedValue({ user_id: 2, role: "member" });
    await svc.addMembers(actor, clientSpace, { user_ids: [2], role: "member" } as never);
    expect(m.addMember).toHaveBeenCalled();
  });

  it("keeps existing members after a downgrade but refuses the next add", async () => {
    m.countStaffSeats.mockResolvedValue(4);
    m.activeStaff.mockResolvedValue([user(2, "bookkeeper")]);
    await expect(svc.addMembers(actor, clientSpace, { user_ids: [2], role: "member" } as never)).rejects.toThrow("allows 2 staff per workspace");
  });

  it("applies no checks in internal spaces", async () => {
    m.activeStaff.mockResolvedValue([user(2, "cfo")]);
    await svc.addMembers(actor, internalSpace, { user_ids: [2], role: "member" } as never);
    expect(m.lockClient).not.toHaveBeenCalled();
    expect(m.effectiveEntitlement).not.toHaveBeenCalled();
    expect(m.addMember).toHaveBeenCalled();
  });
});

describe("changeMemberRole", () => {
  it("promoting to space admin doesn't change seats, so the limit still blocks the next add", async () => {
    m.findMember.mockResolvedValue({ user_id: 2, role: "member", full_name: "U2" });
    await svc.changeMemberRole(actor, clientSpace, 2, "admin");
    expect(m.setMemberRole).toHaveBeenCalledWith(10, 2, "admin", m.conn);
    expect(m.countStaffSeats).not.toHaveBeenCalled();
    m.findMember.mockResolvedValue(null);
    m.activeStaff.mockResolvedValue([user(4, "bookkeeper")]);
    await expect(svc.addMembers(actor, clientSpace, { user_ids: [4], role: "member" } as never)).rejects.toThrow("allows 2 staff per workspace");
  });
});
