import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AuthUser } from "../../types/auth.types.js";
import { accessState } from "./journl-access-task.types.js";

const m = vi.hoisted(() => ({
  insertTask: vi.fn(),
  updateTask: vi.fn(),
  lockTask: vi.fn(),
  lockOpenForAssignment: vi.fn(),
  findTask: vi.fn(),
  findResponsible: vi.fn(),
  recordAudit: vi.fn(),
  conn: { tag: "tx" },
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("./journl-access-task.repository.js", () => ({
  insertTask: m.insertTask,
  updateTask: m.updateTask,
  lockTask: m.lockTask,
  lockOpenForAssignment: m.lockOpenForAssignment,
  findTask: m.findTask,
  findResponsible: m.findResponsible,
}));

const service = await import("./journl-access-task.service.js");

const actor = { id: 1, role: "super_admin" } as unknown as AuthUser;
const conn = m.conn as unknown as PoolConnection;
const a = { id: 7, client_id: 22, user_id: 10 };
const queued = () => m.insertTask.mock.calls.map(([t]) => t.action);

beforeEach(() => {
  vi.clearAllMocks();
  m.insertTask.mockResolvedValue(50);
  m.lockOpenForAssignment.mockResolvedValue(null);
});

describe("queuing to-dos from assignment changes", () => {
  it("a new assignment with JournL access queues an add; without it, nothing", async () => {
    await service.onAssignmentCreated(actor, a, true, conn);
    await service.onAssignmentCreated(actor, { ...a, id: 8 }, false, conn);
    expect(m.insertTask).toHaveBeenCalledTimes(1);
    expect(m.insertTask).toHaveBeenCalledWith(expect.objectContaining({ clientId: 22, assignmentId: 7, userId: 10, action: "grant", createdBy: 1 }), m.conn);
  });

  it("turning access on queues an add, turning it off queues a removal", async () => {
    await service.onAccessToggled(actor, a, false, true, conn);
    await service.onAccessToggled(actor, a, true, false, conn);
    expect(queued()).toEqual(["grant", "revoke"]);
  });

  it("undoing a change that hasn't happened yet cancels the waiting to-do instead", async () => {
    m.lockOpenForAssignment.mockResolvedValue({ id: 40, action: "grant" });
    await service.onAccessToggled(actor, a, true, false, conn);
    expect(m.insertTask).not.toHaveBeenCalled();
    expect(m.updateTask).toHaveBeenCalledWith(40, expect.objectContaining({ status: "cancelled" }), m.conn);
  });

  it("ending an assignment with access queues verify-and-remove, or cancels an add that never happened", async () => {
    await service.onAssignmentEnded(actor, a, true, "assignment ended", conn);
    expect(queued()).toEqual(["verify_revoke"]);

    vi.clearAllMocks();
    m.lockOpenForAssignment.mockResolvedValue({ id: 41, action: "grant" });
    await service.onAssignmentEnded(actor, a, true, "assignment ended", conn);
    expect(m.insertTask).not.toHaveBeenCalled();
    expect(m.updateTask).toHaveBeenCalledWith(41, expect.objectContaining({ status: "cancelled" }), m.conn);
  });

  it("ending an assignment without access does nothing", async () => {
    await service.onAssignmentEnded(actor, a, false, "assignment ended", conn);
    expect(m.insertTask).not.toHaveBeenCalled();
    expect(m.lockOpenForAssignment).not.toHaveBeenCalled();
  });

  describe("hand-over", () => {
    const old = { id: 7, client_id: 22, user_id: 10, journl_access: true };
    const next = { id: 9, client_id: 22, user_id: 11, journl_access: true };

    it("both sides need a change: one update to-do naming both people", async () => {
      await service.onHandover(actor, old, next, conn);
      expect(m.insertTask).toHaveBeenCalledTimes(1);
      expect(m.insertTask).toHaveBeenCalledWith(expect.objectContaining({ action: "update", assignmentId: 9, userId: 11, previousUserId: 10 }), m.conn);
    });

    it("only the old person had access: verify-and-remove them", async () => {
      await service.onHandover(actor, old, { ...next, journl_access: false }, conn);
      expect(m.insertTask).toHaveBeenCalledWith(expect.objectContaining({ action: "verify_revoke", assignmentId: 7, userId: 10 }), m.conn);
    });

    it("the old person's access was never given: cancel it and just add the new person", async () => {
      m.lockOpenForAssignment.mockResolvedValue({ id: 42, action: "grant" });
      await service.onHandover(actor, old, next, conn);
      expect(m.updateTask).toHaveBeenCalledWith(42, expect.objectContaining({ status: "cancelled" }), m.conn);
      expect(queued()).toEqual(["grant"]);
    });
  });
});

describe("working a to-do", () => {
  it("moves through its statuses and records who completed it", async () => {
    m.lockTask.mockResolvedValue({ id: 50, client_id: 22, status: "pending", action: "grant" });
    await service.updateTask(actor, 50, { status: "completed", notes: "Added in JournL users screen" });
    expect(m.updateTask).toHaveBeenCalledWith(50, expect.objectContaining({ status: "completed", completedBy: 1, notes: "Added in JournL users screen" }), m.conn);
  });

  it("won't reopen a finished to-do", async () => {
    m.lockTask.mockResolvedValue({ id: 50, client_id: 22, status: "completed", action: "grant" });
    await expect(service.updateTask(actor, 50, { status: "pending" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("needs a reason to cancel", async () => {
    m.lockTask.mockResolvedValue({ id: 50, client_id: 22, status: "pending", action: "grant" });
    await expect(service.updateTask(actor, 50, { status: "cancelled" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("only an active admin can own it", async () => {
    m.findResponsible.mockResolvedValue(null);
    await expect(service.updateTask(actor, 50, { responsible_id: 99 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("accessState: access counts only once confirmed", () => {
  it.each([
    [true, null, "unconfirmed"],
    [true, "grant:pending", "pending_grant"],
    [true, "update:in_progress", "pending_grant"],
    [true, "grant:completed", "granted"],
    [true, "update:completed", "granted"],
    [false, "revoke:pending", "pending_removal"],
    [false, "verify_revoke:in_progress", "pending_removal"],
    [false, "revoke:completed", "none"],
    [false, null, "none"],
  ] as const)("on=%s, latest=%s → %s", (on, latest, expected) => {
    expect(accessState(on, latest)).toBe(expected);
  });
});
