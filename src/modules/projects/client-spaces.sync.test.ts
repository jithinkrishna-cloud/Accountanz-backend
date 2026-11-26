import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AuthUser } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({
  findPrimarySpace: vi.fn(),
  listClientTeam: vi.fn(),
  listMembersWithSource: vi.fn(),
  addMember: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  countAdmins: vi.fn(),
  upsertSyncIssue: vi.fn(),
  resolveSyncIssues: vi.fn(),
  clientDisplayName: vi.fn(),
  effectiveEntitlement: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../audit/audit.service.js", () => ({ recordAudit: vi.fn() }));
vi.mock("../notifications/notification.service.js", () => ({ notifyWorkspaceSyncIssues: m.notify }));
vi.mock("./entitlement.js", () => ({
  effectiveEntitlement: m.effectiveEntitlement,
  isPortalAdminRole: (r: string) => r === "super_admin" || r === "ops_admin",
}));
vi.mock("./project.repository.js", () => ({
  findPrimarySpace: m.findPrimarySpace,
  listClientTeam: m.listClientTeam,
  listMembersWithSource: m.listMembersWithSource,
  addMember: m.addMember,
  setMemberRole: m.setMemberRole,
  removeMember: m.removeMember,
  countAdmins: m.countAdmins,
  upsertSyncIssue: m.upsertSyncIssue,
  resolveSyncIssues: m.resolveSyncIssues,
  clientDisplayName: m.clientDisplayName,
}));

const { syncPrimaryMembers } = await import("./client-spaces.js");

const conn = { tag: "tx" } as unknown as PoolConnection;
const actor = { id: 7, role: "super_admin" } as unknown as AuthUser;
const person = (id: number, portal_role = "bookkeeper") => ({ user_id: id, full_name: `User ${id}`, portal_role });
const member = (id: number, source: "manual" | "client_team" = "client_team", role: "admin" | "member" = "member", portal_role = "bookkeeper") => ({ user_id: id, role, source, portal_role });
const ent = (over: Record<string, unknown> = {}) => ({ packageName: "Pro", workspaceLimit: 1, staffPerWorkspace: null, teamRoles: ["bookkeeper", "finance_manager"], base: {}, ...over });

beforeEach(() => {
  vi.resetAllMocks();
  m.findPrimarySpace.mockResolvedValue({ id: 5, archived_at: null });
  m.listMembersWithSource.mockResolvedValue([]);
  m.listClientTeam.mockResolvedValue([]);
  m.effectiveEntitlement.mockResolvedValue(ent());
  m.countAdmins.mockResolvedValue(1);
  m.upsertSyncIssue.mockResolvedValue(true);
  m.clientDisplayName.mockResolvedValue("Green Leaf");
});

describe("syncPrimaryMembers", () => {
  it("returns empty when the client has no primary space", async () => {
    m.findPrimarySpace.mockResolvedValue(null);
    expect(await syncPrimaryMembers(actor, 1, conn)).toEqual({ added: [], removed: [], issues: [] });
    expect(m.listClientTeam).not.toHaveBeenCalled();
  });

  it("adds eligible team members as client_team up to the staff limit", async () => {
    m.effectiveEntitlement.mockResolvedValue(ent({ staffPerWorkspace: 2 }));
    m.listClientTeam.mockResolvedValue([person(1), person(2), person(3)]);
    const r = await syncPrimaryMembers(actor, 1, conn);
    expect(r).toEqual({ added: [1, 2], removed: [], issues: [{ userId: 3, reason: "staff_limit" }] });
    expect(m.addMember).toHaveBeenCalledWith(5, 1, "member", 7, conn, "client_team");
    expect(m.addMember).toHaveBeenCalledWith(5, 2, "member", 7, conn, "client_team");
    expect(m.upsertSyncIssue).toHaveBeenCalledWith(5, 3, "staff_limit", conn);
  });

  it("is idempotent", async () => {
    m.effectiveEntitlement.mockResolvedValue(ent({ staffPerWorkspace: 2 }));
    m.listClientTeam.mockResolvedValue([person(1), person(2), person(3)]);
    m.listMembersWithSource.mockResolvedValue([member(1), member(2)]);
    m.upsertSyncIssue.mockResolvedValue(false);
    const r = await syncPrimaryMembers(actor, 1, conn);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(m.addMember).not.toHaveBeenCalled();
    expect(m.removeMember).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("removes only client_team members who left the team", async () => {
    m.listMembersWithSource.mockResolvedValue([member(1), member(9, "manual")]);
    const r = await syncPrimaryMembers(actor, 1, conn);
    expect(r.removed).toEqual([1]);
    expect(m.removeMember).toHaveBeenCalledTimes(1);
    expect(m.removeMember).toHaveBeenCalledWith(5, 1, conn);
  });

  it("records role_not_included for a CFO on a package without cfo", async () => {
    m.listClientTeam.mockResolvedValue([person(1, "cfo")]);
    const r = await syncPrimaryMembers(actor, 1, conn);
    expect(r.added).toEqual([]);
    expect(r.issues).toEqual([{ userId: 1, reason: "role_not_included" }]);
  });

  it("records no_active_package for non-members when there is no entitlement", async () => {
    m.effectiveEntitlement.mockResolvedValue(null);
    m.listClientTeam.mockResolvedValue([person(1)]);
    const r = await syncPrimaryMembers(actor, 1, conn);
    expect(r.issues).toEqual([{ userId: 1, reason: "no_active_package" }]);
    expect(m.addMember).not.toHaveBeenCalled();
  });

  it("skips portal admins in the team", async () => {
    m.effectiveEntitlement.mockResolvedValue(ent({ staffPerWorkspace: 1 }));
    m.listClientTeam.mockResolvedValue([person(1, "super_admin"), person(2)]);
    const r = await syncPrimaryMembers(actor, 1, conn);
    expect(r).toEqual({ added: [2], removed: [], issues: [] });
  });

  it("future-dated assignment is not added and raises no issue", async () => {
    m.listClientTeam.mockResolvedValue([]); // the repo query only returns active assignments
    expect(await syncPrimaryMembers(actor, 1, conn)).toEqual({ added: [], removed: [], issues: [] });
    expect(m.upsertSyncIssue).not.toHaveBeenCalled();
  });

  it("lapsed assignment is removed on next sync", async () => {
    m.listMembersWithSource.mockResolvedValue([member(1)]);
    m.listClientTeam.mockResolvedValue([]);
    expect((await syncPrimaryMembers(actor, 1, conn)).removed).toEqual([1]);
  });

  it("promotes the first added member when the space has no Administrator", async () => {
    m.countAdmins.mockResolvedValue(0);
    m.listClientTeam.mockResolvedValue([person(1), person(2)]);
    await syncPrimaryMembers(actor, 1, conn);
    expect(m.setMemberRole).toHaveBeenCalledTimes(1);
    expect(m.setMemberRole).toHaveBeenCalledWith(5, 1, "admin", conn);
  });

  it("removing the last Administrator through sync does not throw", async () => {
    m.listMembersWithSource.mockResolvedValue([member(1, "client_team", "admin")]);
    m.countAdmins.mockResolvedValue(0);
    await expect(syncPrimaryMembers(actor, 1, conn)).resolves.toMatchObject({ removed: [1] });
    expect(m.setMemberRole).not.toHaveBeenCalled();
  });

  it("resolves issues for everyone not still blocked", async () => {
    m.effectiveEntitlement.mockResolvedValue(ent({ staffPerWorkspace: 1 }));
    m.listClientTeam.mockResolvedValue([person(1), person(2)]);
    await syncPrimaryMembers(actor, 1, conn);
    expect(m.resolveSyncIssues).toHaveBeenCalledWith(5, [2], conn);
  });

  it("notifies admins only for newly opened issues", async () => {
    m.effectiveEntitlement.mockResolvedValue(ent({ staffPerWorkspace: 1 }));
    m.listClientTeam.mockResolvedValue([person(1), person(2), person(3)]);
    m.upsertSyncIssue.mockImplementation(async (_s: number, userId: number) => userId === 3);
    await syncPrimaryMembers(actor, 1, conn);
    expect(m.notify).toHaveBeenCalledWith(5, "Green Leaf", [{ userName: "User 3", reason: "staff_limit" }]);
  });
});
