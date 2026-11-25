import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({
  listActiveEngagements: vi.fn(),
  listClientTeam: vi.fn(),
  insertManualTask: vi.fn(),
  findEngagement: vi.fn(),
  findActiveUser: vi.fn(),
  activeTeamRoles: vi.fn(),
  isPeriodClosed: vi.fn(),
  recordAudit: vi.fn(),
  notifyTaskAssigned: vi.fn(),
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../notifications/notification.service.js", () => ({ notifyTaskAssigned: m.notifyTaskAssigned, notifyTaskSubmitted: vi.fn() }));
vi.mock("../closing/closing.repository.js", () => ({ isPeriodClosed: m.isPeriodClosed, closedClientIds: vi.fn() }));
vi.mock("../access/client-access.js", () => ({
  activeTeamRoles: m.activeTeamRoles,
  clientScope: vi.fn(),
  isAdmin: (u: AuthUser) => u.role === "super_admin" || u.role === "ops_admin",
  REVIEWER_TEAM_ROLES: ["finance_manager", "reviewer", "cfo"],
  TASK_MANAGER_ROLES: ["super_admin", "ops_admin", "finance_manager", "cfo"],
}));
vi.mock("./task.repository.js", () => ({
  listActiveEngagements: m.listActiveEngagements,
  listClientTeam: m.listClientTeam,
  insertManualTask: m.insertManualTask,
  findEngagement: m.findEngagement,
  findActiveUser: m.findActiveUser,
  listClientOptions: vi.fn().mockResolvedValue([]),
}));

const service = await import("./task.service.js");

const owner = { id: 90, role: "client_owner", fullName: "Owner" } as unknown as AuthUser;
const input = { title: "Reconcile bank", description: null, due_date: "2030-03-15", checklist: [] };
const team = [
  { user_id: 10, full_name: "Bo", team_role: "bookkeeper" },
  { user_id: 11, full_name: "Fi", team_role: "finance_manager" },
];

beforeEach(() => {
  vi.clearAllMocks();
  m.listActiveEngagements.mockResolvedValue([{ id: 5, package_name: "Standard" }]);
  m.listClientTeam.mockResolvedValue(team);
  m.insertManualTask.mockResolvedValue(77);
  m.isPeriodClosed.mockResolvedValue(false);
});

describe("client owner creates a task", () => {
  it("assigns the bookkeeper, has the finance manager review, and uses the title as the only step", async () => {
    const r = await service.createTaskForClient(owner, { clientId: 3, role: "owner" }, input);
    expect(r).toMatchObject({ id: 77, period: "2030-03" });
    expect(m.insertManualTask).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 3, engagementId: 5, assigneeId: 10, reviewerId: 11, clientVisible: true, checklist: [{ text: "Reconcile bank", done: false }] }),
      expect.anything(),
    );
    expect(m.notifyTaskAssigned).toHaveBeenCalledWith(77, owner);
  });

  it("client members can't create tasks", async () => {
    await expect(service.createTaskForClient(owner, { clientId: 3, role: "member" }, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.insertManualTask).not.toHaveBeenCalled();
  });

  it("needs an active engagement and both a doer and a reviewer", async () => {
    m.listActiveEngagements.mockResolvedValueOnce([]);
    await expect(service.createTaskForClient(owner, { clientId: 3, role: "owner" }, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    m.listClientTeam.mockResolvedValueOnce([team[0]]);
    await expect(service.createTaskForClient(owner, { clientId: 3, role: "owner" }, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(m.insertManualTask).not.toHaveBeenCalled();
  });

  it("refuses a closed month", async () => {
    m.isPeriodClosed.mockResolvedValueOnce(true);
    await expect(service.createTaskForClient(owner, { clientId: 3, role: "owner" }, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("staff create tasks", () => {
  it("an accountant not assigned to the client is refused", async () => {
    m.activeTeamRoles.mockResolvedValue([]);
    const bookkeeper = { id: 10, role: "bookkeeper" } as unknown as AuthUser;
    await expect(service.getTaskOptions(bookkeeper, 3)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
