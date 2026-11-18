import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import type { CorrectionStatus } from "./correction.types.js";

const m = vi.hoisted(() => ({ execute: vi.fn(), queryOne: vi.fn(), recordAudit: vi.fn(), rollback: vi.fn(), conn: { tag: "conn" } }));

vi.mock("../../database/connection.js", () => ({
  execute: m.execute,
  queryOne: m.queryOne,
  query: vi.fn(),
  pool: {},
  withTransaction: async (fn: (c: unknown) => unknown) => {
    try {
      return await fn(m.conn);
    } catch (e) {
      m.rollback();
      throw e;
    }
  },
}));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));

const { ALLOWED, transition } = await import("./correction.state.js");

const actor = { id: 7, role: "super_admin" } as AuthUser;
const ctx = { requestId: "req-1", ipAddress: "1.2.3.4", endpoint: "POST /x" };
const STATUSES = Object.keys(ALLOWED) as CorrectionStatus[];

const sqlOf = (call: unknown[]) => String(call[0]);
const eventInserts = () => m.execute.mock.calls.filter((c) => sqlOf(c).includes("INSERT INTO journl_correction_events"));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ALLOWED", () => {
  it("matches the specified machine", () => {
    expect(ALLOWED).toEqual({
      draft: ["pending_approval"],
      pending_approval: ["approved", "rejected", "draft"],
      approved: ["posting", "rejected"],
      posting: ["posted", "rejected", "unknown", "approved"],
      unknown: ["posted", "rejected"],
      posted: [],
      rejected: [],
    });
  });

  it("every transition outside ALLOWED throws and touches nothing", async () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (ALLOWED[from].includes(to)) continue;
        await expect(transition(1, from, to, actor, ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
    expect(m.execute).not.toHaveBeenCalled();
  });
});

describe("transition", () => {
  it("stale from -> 409 naming the current status, writes no event and no audit", async () => {
    m.execute.mockResolvedValueOnce({ affectedRows: 0 });
    m.queryOne.mockResolvedValueOnce({ status: "posting" });
    await expect(transition(5, "approved", "posting", actor, ctx)).rejects.toMatchObject({
      status: 409,
      message: "This correction was already posting",
    });
    expect(eventInserts()).toHaveLength(0);
    expect(m.recordAudit).not.toHaveBeenCalled();
  });

  it("success writes exactly one event and one audit row on the transaction connection", async () => {
    m.execute.mockResolvedValue({ affectedRows: 1 });
    m.queryOne.mockResolvedValueOnce({ id: 5, client_id: 9, status: "posting", payload: '{"a":1}', before_values: null, after_values: [] });
    const row = await transition(5, "approved", "posting", actor, ctx, { journl_session_owner: 3 }, "sending");
    expect(row.payload).toEqual({ a: 1 });
    expect(eventInserts()).toHaveLength(1);
    expect(eventInserts()[0]![1]).toEqual([5, "approved", "posting", 7, "sending", "req-1"]);
    const upd = m.execute.mock.calls[0]!;
    expect(sqlOf(upd)).toContain("SET status = ?, journl_session_owner = ? WHERE id = ? AND status = ?");
    expect(upd[1]).toEqual(["posting", 3, 5, "approved"]);
    expect(m.recordAudit).toHaveBeenCalledTimes(1);
    const [a, entry, db] = m.recordAudit.mock.calls[0]!;
    expect(a).toBe(actor);
    expect(db).toBe(m.conn);
    expect(entry).toMatchObject({
      action: "JournL correction posting",
      entityType: "JournlCorrection",
      entityId: "ACZ-5",
      clientId: 9,
      outcome: "success",
      requestId: "req-1",
      ipAddress: "1.2.3.4",
      endpoint: "POST /x",
    });
  });

  it("only whitelisted columns are set; unknown field names are ignored", async () => {
    m.execute.mockResolvedValue({ affectedRows: 1 });
    m.queryOne.mockResolvedValueOnce({ id: 5, client_id: 9 });
    await transition(5, "posting", "posted", actor, ctx, {
      journl_voucher_id: "V1",
      journl_message: "x".repeat(2000),
      ["status = 'posted', initiated_by"]: 1,
      payload: { hacked: true },
    } as never);
    const upd = m.execute.mock.calls[0]!;
    expect(sqlOf(upd)).toBe("UPDATE journl_corrections SET status = ?, journl_voucher_id = ?, journl_message = ? WHERE id = ? AND status = ?");
    expect((upd[1] as unknown[])[2]).toHaveLength(1000);
  });

  it("an audit failure propagates out of the transaction (rolls the status back)", async () => {
    m.execute.mockResolvedValue({ affectedRows: 1 });
    m.queryOne.mockResolvedValueOnce({ id: 5, client_id: 9 });
    m.recordAudit.mockRejectedValueOnce(new Error("audit down"));
    await expect(transition(5, "approved", "posting", actor, ctx)).rejects.toThrow("audit down");
    expect(m.rollback).toHaveBeenCalledTimes(1);
  });

  it("missing row -> 404", async () => {
    m.execute.mockResolvedValueOnce({ affectedRows: 0 });
    m.queryOne.mockResolvedValueOnce(null);
    await expect(transition(5, "approved", "posting", actor, ctx)).rejects.toMatchObject({ status: 404 });
  });
});
