import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { StaffGroupMember, StaffGroupRow } from "./staff-group.types.js";

const m = vi.hoisted(() => ({
  findClientById: vi.fn(),
  findActiveDuplicate: vi.fn(),
  insertAssignment: vi.fn(),
  endAssignment: vi.fn(),
  listGroups: vi.fn(),
  findGroup: vi.fn(),
  lockGroup: vi.fn(),
  findByName: vi.fn(),
  findAccountants: vi.fn(),
  insertGroup: vi.fn(),
  updateGroup: vi.fn(),
  replaceMembers: vi.fn(),
  deleteGroup: vi.fn(),
  removeUserFromAllGroups: vi.fn(),
  onAssignmentCreated: vi.fn(),
  recordAudit: vi.fn(),
  conn: { tag: "tx" },
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../journl-access-tasks/journl-access-task.service.js", () => ({ onAssignmentCreated: m.onAssignmentCreated }));
vi.mock("../clients/client.repository.js", () => ({ findClientById: m.findClientById }));
vi.mock("../assignments/assignment.repository.js", () => ({
  findActiveDuplicate: m.findActiveDuplicate,
  insertAssignment: m.insertAssignment,
  endAssignment: m.endAssignment,
}));
vi.mock("./staff-group.repository.js", () => ({
  listGroups: m.listGroups,
  findGroup: m.findGroup,
  lockGroup: m.lockGroup,
  findByName: m.findByName,
  findAccountants: m.findAccountants,
  insertGroup: m.insertGroup,
  updateGroup: m.updateGroup,
  replaceMembers: m.replaceMembers,
  deleteGroup: m.deleteGroup,
  removeUserFromAllGroups: m.removeUserFromAllGroups,
}));

const service = await import("./staff-group.service.js");

const actor = { id: 1, role: "super_admin" } as unknown as AuthUser;

const member = (over: Partial<StaffGroupMember>): StaffGroupMember => ({
  user_id: 10,
  full_name: "Meera Joshi",
  email: "meera@example.test",
  team_role: "finance_manager",
  journl_access: false,
  assignable: true,
  ...over,
});

const group = (members: StaffGroupMember[]): StaffGroupRow => ({
  id: 5,
  name: "Team A",
  description: null,
  created_at: "2026-11-21",
  updated_at: "2026-11-21",
  members,
  clients: [],
});

const meera = member({});
const arun = member({ user_id: 11, full_name: "Arun Menon", team_role: "bookkeeper", journl_access: true });
const dates = { client_id: 22, valid_from: "2026-11-21", valid_to: null };
const input = { name: "Team A", description: null, members: [{ user_id: 10, team_role: "finance_manager" as const, journl_access: false }] };

beforeEach(() => {
  vi.clearAllMocks();
  m.findClientById.mockResolvedValue({ id: 22, status: "active", trade_name: "techo", legal_name: "Techo Pvt Ltd" });
  m.lockGroup.mockResolvedValue({ id: 5, name: "Team A" });
  m.findActiveDuplicate.mockResolvedValue(null);
  let next = 100;
  m.insertAssignment.mockImplementation(async () => next++);
  m.findByName.mockResolvedValue(null);
  m.findAccountants.mockResolvedValue([{ id: 10 }]);
  m.findGroup.mockResolvedValue(group([meera]));
});

describe("assignGroup", () => {
  it("creates one assignment per member, with each member's role and JournL setting, tagged with the group", async () => {
    m.findGroup.mockResolvedValue(group([meera, arun]));

    const r = await service.assignGroup(actor, 5, dates);

    expect(m.insertAssignment).toHaveBeenCalledTimes(2);
    expect(m.insertAssignment).toHaveBeenCalledWith(
      { client_id: 22, user_id: 10, team_role: "finance_manager", valid_from: "2026-11-21", valid_to: null, journl_access: false },
      m.conn,
      5,
    );
    expect(m.insertAssignment).toHaveBeenCalledWith(expect.objectContaining({ user_id: 11, team_role: "bookkeeper", journl_access: true }), m.conn, 5);
    // Each new assignment gets its JournL to-do decision (Arun has JournL access).
    expect(m.onAssignmentCreated).toHaveBeenCalledWith(actor, { id: 101, client_id: 22, user_id: 11 }, true, m.conn);
    expect(r).toMatchObject({ client_id: 22, client_name: "techo", skipped: [] });
    expect(r.created.map((c) => c.full_name)).toEqual(["Meera Joshi", "Arun Menon"]);
    // One entry per assignment plus one for the group.
    expect(m.recordAudit).toHaveBeenCalledTimes(3);
  });

  it("skips members already in that role on the client and members who can't be assigned, and reports why", async () => {
    const priya = member({ user_id: 12, full_name: "Priya Nair", team_role: "reviewer", assignable: false });
    m.findGroup.mockResolvedValue(group([meera, arun, priya]));
    m.findActiveDuplicate.mockImplementation(async (q: { user_id: number }) => (q.user_id === 10 ? { id: 1 } : null));

    const r = await service.assignGroup(actor, 5, dates);

    expect(m.insertAssignment).toHaveBeenCalledTimes(1);
    expect(r.created.map((c) => c.full_name)).toEqual(["Arun Menon"]);
    expect(r.skipped).toEqual([
      { full_name: "Meera Joshi", team_role: "finance_manager", reason: "already finance manager on this client" },
      { full_name: "Priya Nair", team_role: "reviewer", reason: "not an active, verified accountant" },
    ]);
  });

  it("refuses, creating nothing, when every member would be skipped", async () => {
    m.findActiveDuplicate.mockResolvedValue({ id: 1 });

    await expect(service.assignGroup(actor, 5, dates)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("Nobody was assigned") });
    expect(m.insertAssignment).not.toHaveBeenCalled();
  });

  it("rejects an exited client before opening a transaction", async () => {
    m.findClientById.mockResolvedValue({ id: 22, status: "exited", trade_name: null, legal_name: "Gone Ltd" });

    await expect(service.assignGroup(actor, 5, dates)).rejects.toBeInstanceOf(AppError);
    expect(m.lockGroup).not.toHaveBeenCalled();
  });

  it("refuses a group with no members", async () => {
    m.findGroup.mockResolvedValue(group([]));
    await expect(service.assignGroup(actor, 5, dates)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("editing a group never changes existing assignments", () => {
  it("update replaces members only", async () => {
    await service.updateGroup(actor, 5, input);

    expect(m.replaceMembers).toHaveBeenCalledWith(5, input.members, m.conn);
    expect(m.insertAssignment).not.toHaveBeenCalled();
    expect(m.endAssignment).not.toHaveBeenCalled();
  });

  it("delete removes the group only", async () => {
    await service.deleteGroup(actor, 5);

    expect(m.deleteGroup).toHaveBeenCalledWith(5, m.conn);
    expect(m.endAssignment).not.toHaveBeenCalled();
  });
});

describe("group validation", () => {
  it("rejects a name another group uses", async () => {
    m.findByName.mockResolvedValue({ id: 9 });
    await expect(service.createGroup(actor, input)).rejects.toMatchObject({ details: { fieldErrors: { name: [expect.any(String)] } } });
    expect(m.insertGroup).not.toHaveBeenCalled();
  });

  it("rejects members who aren't active accountants", async () => {
    m.findAccountants.mockResolvedValue([]);
    await expect(service.createGroup(actor, input)).rejects.toMatchObject({ details: { fieldErrors: { members: [expect.any(String)] } } });
  });
});

describe("removeFromAllGroups", () => {
  it("audits each group the person leaves", async () => {
    m.removeUserFromAllGroups.mockResolvedValue([{ id: 5, name: "Team A" }, { id: 6, name: "Team B" }]);

    const n = await service.removeFromAllGroups(actor, 10, "Meera Joshi, account disabled", m.conn as never);

    expect(n).toBe(2);
    expect(m.recordAudit).toHaveBeenCalledTimes(2);
    expect(m.recordAudit).toHaveBeenCalledWith(actor, expect.objectContaining({ entityId: 6, details: "Team B: Meera Joshi, account disabled" }), m.conn);
  });
});
