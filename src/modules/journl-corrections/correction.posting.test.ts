import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { CorrectionRow, CorrectionStatus } from "./correction.types.js";

/**
 * Approve-and-post / post (Task 8). Everything is mocked: the gateway (no request can leave), the books reads, the
 * repository, and `transition`, which is replaced by an in-memory conditional update so the single-send gate and the
 * two-approver race behave as on the real DB (Task 5 proves the SQL itself).
 */

const m = vi.hoisted(() => ({
  load: vi.fn(),
  get: vi.fn(),
  ledgerKindOf: vi.fn(),
  canApprove: vi.fn(),
  requireApprove: vi.fn(),
  requirePrepare: vi.fn(),
  findActiveUser: vi.fn(),
  transition: vi.fn(),
  closedMonthsForOpening: vi.fn(),
  isPeriodClosed: vi.fn(),
  suspenseAmount: vi.fn(),
  suspenseGroupId: vi.fn(),
  branches: vi.fn(),
  getLedger: vi.fn(),
  journalVoucherType: vi.fn(),
  ledgerGroups: vi.fn(),
  assertWritesEnabled: vi.fn(),
  journlWrite: vi.fn(),
  openJournlSession: vi.fn(),
  notifyCorrectionOutcome: vi.fn(),
}));

vi.mock("./correction.service.js", () => ({ load: m.load, get: m.get, ledgerKindOf: m.ledgerKindOf }));
vi.mock("./correction.access.js", async (orig) => ({
  ...(await orig<typeof import("./correction.access.js")>()),
  canApprove: m.canApprove,
  requireApprove: m.requireApprove,
  requirePrepare: m.requirePrepare,
}));
vi.mock("./correction.repository.js", () => ({ findActiveUser: m.findActiveUser }));
vi.mock("./correction.state.js", () => ({ transition: m.transition }));
vi.mock("./correction.preview.js", async (orig) => ({
  ...(await orig<typeof import("./correction.preview.js")>()),
  closedMonthsForOpening: m.closedMonthsForOpening,
  isPeriodClosed: m.isPeriodClosed,
  suspenseAmount: m.suspenseAmount,
  suspenseGroupId: m.suspenseGroupId,
}));
vi.mock("./journl-books.js", async (orig) => ({
  ...(await orig<typeof import("./journl-books.js")>()),
  branches: m.branches,
  getLedger: m.getLedger,
  journalVoucherType: m.journalVoucherType,
  ledgerGroups: m.ledgerGroups,
}));
vi.mock("../integrations/journl.gateway.js", () => ({ assertWritesEnabled: m.assertWritesEnabled, journlWrite: m.journlWrite }));
vi.mock("../integrations/journl-data.service.js", () => ({ openJournlSession: m.openJournlSession }));
vi.mock("../notifications/notification.service.js", () => ({ notifyCorrectionOutcome: m.notifyCorrectionOutcome }));
vi.mock("../../database/connection.js", () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn() }));

const posting = await import("./correction.posting.js");
const { BILL_WISE_BLOCKED, closedMonthsMessage } = await import("./correction.preview.js");
const { SESSION_EXPIRED } = await import("./journl-books.js");

const preparer = { id: 7, fullName: "Rahul", email: "r@x.in", role: "bookkeeper" } as AuthUser;
const reviewer = { id: 8, fullName: "Meera", email: "m@x.in", role: "finance_manager" } as AuthUser;
const reviewer2 = { id: 9, fullName: "Anil", email: "a@x.in", role: "cfo" } as AuthUser;
const stranger = { id: 12, fullName: "Other", email: "o@x.in", role: "bookkeeper" } as AuthUser;
const ops = { id: 2, fullName: "Ops", email: "ops@x.in", role: "ops_admin" } as AuthUser;
const ctx = { requestId: "req-1", ipAddress: "1.2.3.4", endpoint: "POST /x" };
const CLIENT = 42;
const ID = 101;

/** A JWT-shaped owner token whose payload carries JournL user id 307. */
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const TOKEN = jwt({ id: 307, role: "company", exp: 9999999999 });

const journalRow = (over: Partial<CorrectionRow> = {}): CorrectionRow =>
  ({
    id: ID,
    client_id: CLIENT,
    connection_id: 9,
    journl_company_id: "218",
    journl_branch_id: 5,
    kind: "journal_entry",
    purpose: "correction",
    status: "approved",
    payload: {
      voucher_date: "2026-11-01",
      lines: [
        { ledger_id: 10, ledger_name: "Rent", side: "dr", amount_paise: 10050 },
        { ledger_id: 12, ledger_name: "Repairs", side: "dr", amount_paise: 2000 },
        { ledger_id: 11, ledger_name: "Cash", side: "cr", amount_paise: 12050 },
      ],
    },
    before_values: null,
    after_values: null,
    reason: "Reclass rent",
    initiated_by: preparer.id,
    approved_by: reviewer.id,
    approved_at: "2026-11-18 08:00:00",
    review_comment: null,
    journl_session_owner: 55,
    journl_voucher_id: null,
    rejected_by_source: null,
    journl_message: null,
    copied_from: null,
    created_at: "",
    updated_at: "",
    ...over,
  }) as CorrectionRow;

const openingRow = (over: Partial<CorrectionRow> = {}) =>
  journalRow({
    kind: "opening_balance",
    payload: { ledger_id: 20, ledger_name: "Office deposit", amount_paise: 50000, side: "dr" },
    before_values: [{ ledger_id: 20, ledger_name: "Office deposit", before_paise: 25000, after_paise: 25000 }],
    after_values: [{ ledger_id: 20, ledger_name: "Office deposit", before_paise: 25000, after_paise: -50000 }],
    ...over,
  });

const suspenseRow = (over: Partial<CorrectionRow> = {}) =>
  journalRow({
    kind: "opening_balance",
    purpose: "unresolved_tb_difference",
    payload: { ledger_id: 30, ledger_name: "Suspense A/c", amount_paise: 12345, side: "dr" },
    before_values: [{ ledger_id: 30, ledger_name: "Suspense A/c", before_paise: 0, after_paise: 0 }],
    after_values: [{ ledger_id: 30, ledger_name: "Suspense A/c", before_paise: 0, after_paise: -12345 }],
    reason: "Temporary adjustment: unresolved trial balance difference. Old system",
    ...over,
  });

/** The full ledger object JournL returns (with populated optional fields and join extras). */
const ledgerGet = (over: Record<string, unknown> = {}) => ({
  id: 20,
  code: "L0020",
  name: "Office deposit",
  groupId: 15,
  primaryGroupId: 15,
  groupName: "Indirect Expenses",
  serviceId: 3,
  taxId: 2,
  taxType: "GST",
  gstNumber: "29ABCDE1234F1Z5",
  panNumber: "ABCDE1234F",
  openingBalance: 250,
  transactionType: "payable",
  enableBillWise: 0,
  creditDays: 30,
  creditAmount: 1000,
  address1: "1 MG Road",
  country: 101,
  state: 17,
  bankName: "SBI",
  salesManId: null,
  branchId: 5,
  isDeleted: 0,
  createdBy: 307,
  updatedBy: null,
  updatedAt: null,
  serviceTypeName: "Rent",
  taxRate: 18,
  openingBillEntry: [],
  ...over,
});

/** In-memory row + conditional transition, like the real `WHERE id = ? AND status = ?`. */
let state: CorrectionRow;
let events: { from: CorrectionStatus; to: CorrectionStatus; note?: string }[];

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected a rejection");
};

const setRow = (r: CorrectionRow) => {
  state = { ...r };
};

beforeEach(() => {
  vi.resetAllMocks();
  events = [];
  setRow(journalRow());
  m.load.mockImplementation(async () => ({ ...state }));
  m.get.mockImplementation(async () => ({ ...state, ref: `ACZ-${state.id}`, events: [], can_edit: false, can_submit: false, can_review: false }));
  m.transition.mockImplementation(async (_id: number, from: CorrectionStatus, to: CorrectionStatus, _a: unknown, _c: unknown, fields: Partial<CorrectionRow> = {}, note?: string) => {
    await Promise.resolve(); // let concurrent callers interleave
    if (state.status !== from) throw AppError.conflict(`This correction was already ${state.status}`);
    state = { ...state, ...fields, status: to };
    events.push({ from, to, note });
    return { ...state };
  });
  m.requireApprove.mockImplementation(async (actor: AuthUser, _c: number, initiatedBy: number) => {
    if (actor.id === initiatedBy) throw new AppError("FORBIDDEN", "You can't approve your own correction");
    if (actor.role === "ops_admin") throw new AppError("FORBIDDEN", "no");
  });
  m.canApprove.mockImplementation(async (actor: AuthUser, _c: number, initiatedBy: number) => actor.id !== initiatedBy && actor.role !== "ops_admin" && actor.id !== stranger.id);
  m.requirePrepare.mockResolvedValue(undefined);
  m.findActiveUser.mockImplementation(async (id: number) => [preparer, reviewer, reviewer2].find((u) => u.id === id) ?? null);
  m.assertWritesEnabled.mockReturnValue(undefined);
  m.openJournlSession.mockResolvedValue({ token: TOKEN, companyId: "218", expiresAt: new Date(Date.now() + 3600_000) });
  m.branches.mockResolvedValue([{ id: 1, name: "BR001" }, { id: 5, name: "Pune" }]);
  m.getLedger.mockImplementation(async (_t: string, id: number) => (id === 20 ? ledgerGet() : id === 30 ? ledgerGet({ id: 30, name: "Suspense A/c", groupId: 9, primaryGroupId: 9, openingBalance: 0 }) : { id, name: `L${id}` }));
  m.ledgerKindOf.mockResolvedValue("general");
  m.journalVoucherType.mockResolvedValue({ voucherTypeId: 3, primaryVoucherTypeId: 3 });
  m.ledgerGroups.mockResolvedValue([{ id: 9, name: "Suspense A/c", isDeleted: 0 }]);
  m.suspenseGroupId.mockResolvedValue(9);
  m.suspenseAmount.mockResolvedValue({ amount_paise: 12345, side: "dr" });
  m.closedMonthsForOpening.mockResolvedValue([]);
  m.isPeriodClosed.mockResolvedValue(false);
  m.journlWrite.mockResolvedValue({ kind: "ok", data: { success: true, message: "Voucher added successfully", data: 9876 } });
  m.notifyCorrectionOutcome.mockResolvedValue(undefined);
});

afterEach(() => {
  // Send-once: no single test path may call journlWrite more than once.
  expect(m.journlWrite.mock.calls.length).toBeLessThanOrEqual(1);
});

const statuses = () => events.map((e) => `${e.from}->${e.to}`);

describe("approveAndPost", () => {
  beforeEach(() => setRow(journalRow({ status: "pending_approval", approved_by: null, approved_at: null })));

  it("self-approval → 403 and nothing written", async () => {
    const e = await err(posting.approveAndPost(preparer, ID, undefined, ctx));
    expect(e.status).toBe(403);
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("ops_admin can't approve", async () => {
    expect((await err(posting.approveAndPost(ops, ID, undefined, ctx))).status).toBe(403);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("records approver, time and comment, then posts once", async () => {
    const out = await posting.approveAndPost(reviewer, ID, "  Looks right  ", ctx);
    expect(m.transition.mock.calls[0].slice(0, 3)).toEqual([ID, "pending_approval", "approved"]);
    expect(m.transition.mock.calls[0][5]).toMatchObject({ approved_by: reviewer.id, review_comment: "Looks right" });
    expect(m.transition.mock.calls[0][5].approved_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(statuses()).toEqual(["pending_approval->approved", "approved->posting", "posting->posted"]);
    expect(out.status).toBe("posted");
    expect(m.journlWrite).toHaveBeenCalledTimes(1);
  });

  it("no comment leaves review_comment untouched", async () => {
    await posting.approveAndPost(reviewer, ID, "   ", ctx);
    expect(m.transition.mock.calls[0][5]).not.toHaveProperty("review_comment");
  });

  it("two reviewers at the same moment → exactly one write, the other gets 409", async () => {
    const results = await Promise.allSettled([posting.approveAndPost(reviewer, ID, undefined, ctx), posting.approveAndPost(reviewer2, ID, undefined, ctx)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0].reason as AppError).status).toBe(409);
    expect((failed[0].reason as AppError).message).toMatch(/already approved/);
    expect(m.journlWrite).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("posted");
  });

  it("409 when it is no longer pending approval", async () => {
    setRow(journalRow({ status: "rejected" }));
    expect((await err(posting.approveAndPost(reviewer, ID, undefined, ctx))).status).toBe(409);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });
});

describe("post: who and when", () => {
  it("the preparer may post an approved correction", async () => {
    expect((await posting.post(preparer, ID, ctx)).status).toBe("posted");
  });

  it("someone who is neither preparer nor approver → 403, nothing sent", async () => {
    expect((await err(posting.post(stranger, ID, ctx))).status).toBe(403);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("ops_admin → 403", async () => {
    expect((await err(posting.post(ops, ID, ctx))).status).toBe(403);
  });

  it.each(["pending_approval", "posting", "posted", "unknown", "rejected"] as const)("only from approved (%s → 409, nothing sent)", async (s) => {
    setRow(journalRow({ status: s }));
    expect((await err(posting.post(reviewer, ID, ctx))).status).toBe(409);
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("two posts racing → one write, the other 409 at the gate", async () => {
    const results = await Promise.allSettled([posting.post(reviewer, ID, ctx), posting.post(preparer, ID, ctx)]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(m.journlWrite).toHaveBeenCalledTimes(1);
  });
});

describe("post: refusals before anything is sent", () => {
  it("writes disabled → 503, status stays approved", async () => {
    m.assertWritesEnabled.mockImplementation(() => {
      throw new AppError("UNAVAILABLE", "JournL corrections are disabled in this environment");
    });
    expect((await err(posting.post(reviewer, ID, ctx))).status).toBe(503);
    expect(state.status).toBe("approved");
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("owner session missing/expired before sending → stays approved with the refresh message, journlWrite never called", async () => {
    m.openJournlSession.mockRejectedValue(AppError.conflict("The JournL session has expired (JournL sessions last 8 hours). Ask the owner to sign in with JournL again."));
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("approved");
    expect(out.message).toBe("Waiting for the owner to refresh JournL");
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("session expiring during the pre-send reads → stays approved, nothing sent", async () => {
    m.branches.mockRejectedValue(AppError.conflict(SESSION_EXPIRED));
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("approved");
    expect(out.message).toBe(posting.WAITING_FOR_OWNER);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("a token without a JournL user id → stays approved, nothing sent", async () => {
    m.openJournlSession.mockResolvedValue({ token: jwt({ role: "company" }), companyId: "218", expiresAt: new Date(Date.now() + 3600_000) });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.message).toBe(posting.WAITING_FOR_OWNER);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("branch deleted in JournL → rejected / stale", async () => {
    m.branches.mockResolvedValue([{ id: 1, name: "BR001" }]);
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("rejected");
    expect(state.rejected_by_source).toBe("stale");
    expect(state.journl_message).toBe("Branch 5 no longer exists in JournL");
    expect(statuses()).toEqual(["approved->rejected"]);
    expect(m.journlWrite).not.toHaveBeenCalled();
    expect(m.notifyCorrectionOutcome).toHaveBeenCalledWith(ID);
  });

  it("preparer lost Correct access → rejected / stale, nothing sent", async () => {
    m.requirePrepare.mockRejectedValue(new AppError("FORBIDDEN", "You don't have Correct access"));
    const out = await posting.post(reviewer, ID, ctx);
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_journal");
    expect(out.status).toBe("rejected");
    expect(state).toMatchObject({ rejected_by_source: "stale", journl_message: "The preparer no longer has Correct access" });
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("preparer no longer an active user → rejected / stale", async () => {
    m.findActiveUser.mockImplementation(async (id: number) => (id === preparer.id ? null : reviewer));
    await posting.post(reviewer, ID, ctx);
    expect(state.journl_message).toBe(posting.PREPARER_LOST);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("approver no longer eligible → rejected / stale before any JournL read", async () => {
    m.canApprove.mockImplementation(async (a: AuthUser) => a.id === reviewer2.id);
    await posting.post(reviewer2, ID, ctx);
    expect(state).toMatchObject({ status: "rejected", rejected_by_source: "stale", journl_message: posting.APPROVER_LOST });
    expect(m.openJournlSession).not.toHaveBeenCalled();
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("client reconnected to a different JournL company → rejected / stale", async () => {
    m.openJournlSession.mockResolvedValue({ token: TOKEN, companyId: "999", expiresAt: new Date(Date.now() + 3600_000) });
    await posting.post(reviewer, ID, ctx);
    expect(state.journl_message).toBe(posting.OTHER_COMPANY);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("journal: a ledger deleted in JournL → rejected / stale", async () => {
    m.getLedger.mockImplementation(async (_t: string, id: number) => (id === 12 ? null : { id }));
    await posting.post(reviewer, ID, ctx);
    expect(state).toMatchObject({ status: "rejected", rejected_by_source: "stale" });
    expect(state.journl_message).toMatch(/^Repairs no longer exists in JournL/);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("journal: no Journal voucher type → rejected / stale", async () => {
    m.journalVoucherType.mockRejectedValue(AppError.conflict("JournL has no Journal voucher type for this company"));
    await posting.post(reviewer, ID, ctx);
    expect(state.journl_message).toBe(posting.NO_JOURNAL_TYPE);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });
});

describe("post: closed months (opening-balance corrections only)", () => {
  it("refused at post: 409 naming the months, stays approved, journlWrite 0 calls", async () => {
    setRow(openingRow());
    m.closedMonthsForOpening.mockResolvedValue(["2026-04", "2026-05"]);
    const e = await err(posting.post(reviewer, ID, ctx));
    expect(e.status).toBe(409);
    expect(e.message).toBe(closedMonthsMessage(["2026-04", "2026-05"], true));
    expect(e.message).toMatch(/April 2026, May 2026[\s\S]*Reopen those months in Accountanz, then post this correction; or reject it and prepare a new correction/);
    expect(e.message).not.toMatch(/Prepare again/);
    expect(state.status).toBe("approved");
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("Suspense adjustment refused the same way", async () => {
    setRow(suspenseRow());
    m.closedMonthsForOpening.mockResolvedValue(["2026-06"]);
    expect((await err(posting.post(reviewer, ID, ctx))).status).toBe(409);
    expect(state.status).toBe("approved");
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("allowed after the month is reopened", async () => {
    setRow(openingRow());
    m.closedMonthsForOpening.mockResolvedValueOnce(["2026-04"]);
    await err(posting.post(reviewer, ID, ctx));
    expect(m.journlWrite).not.toHaveBeenCalled();
    m.journlWrite.mockResolvedValue({ kind: "ok", data: { success: true, message: "Company Ledger Master updated successfully" } });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("posted");
    expect(m.journlWrite).toHaveBeenCalledTimes(1);
  });

  it("journal entries are unaffected by the opening block (only their voucher date's month counts)", async () => {
    m.closedMonthsForOpening.mockResolvedValue(["2026-04"]);
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("posted");
    expect(m.closedMonthsForOpening).not.toHaveBeenCalled();
    expect(m.isPeriodClosed).toHaveBeenCalledWith(CLIENT, "2026-11-01");
  });

  it("journal whose own month was closed after approval → 409, stays approved, nothing sent", async () => {
    m.isPeriodClosed.mockResolvedValue(true);
    const e = await err(posting.post(reviewer, ID, ctx));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/November 2026 is closed/);
    expect(state.status).toBe("approved");
    expect(m.journlWrite).not.toHaveBeenCalled();
  });
});

describe("post: the journal write", () => {
  it("body: Journal type ids, ref as invoiceNo, positive 2-dp amounts, Σdr total, stored branch, owner user id", async () => {
    await posting.post(reviewer, ID, ctx);
    expect(m.journlWrite).toHaveBeenCalledTimes(1);
    const [token, method, path, body] = m.journlWrite.mock.calls[0];
    expect(token).toBe(TOKEN);
    expect(method).toBe("POST");
    expect(path).toBe("transaction/create-journal");
    expect(body).toEqual({
      voucherType: "Journal",
      voucherTypeId: 3,
      primaryVoucherTypeId: 3,
      voucherDate: "2026-11-01",
      invoiceNo: "ACZ-101",
      description: "Reclass rent",
      totalAmount: 120.5,
      debits: [
        { ledgerId: 10, amount: 100.5, isDr: true },
        { ledgerId: 12, amount: 20, isDr: true },
      ],
      credits: [{ ledgerId: 11, amount: 120.5, isDr: false }],
      branchId: 5,
      createdBy: 307,
    });
    for (const l of [...body.debits, ...body.credits]) {
      expect(l.amount).toBeGreaterThan(0);
      expect(Number(l.amount.toFixed(2))).toBe(l.amount);
    }
  });

  it("ok → posted with the voucher id; the gate ran before the write; preparer told", async () => {
    m.journlWrite.mockImplementation(async () => {
      expect(state.status).toBe("posting"); // sent only after approved → posting
      return { kind: "ok", data: { success: true, data: 9876 } };
    });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("posted");
    expect(state.journl_voucher_id).toBe("9876");
    expect(statuses()).toEqual(["approved->posting", "posting->posted"]);
    expect(m.notifyCorrectionOutcome).toHaveBeenCalledWith(ID);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("JournL success:false / 4xx → rejected by journl with its message", async () => {
    m.journlWrite.mockResolvedValue({ kind: "rejected", status: 400, message: "Invalid voucher type for this endpoint." });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("rejected");
    expect(state).toMatchObject({ rejected_by_source: "journl", journl_message: "Invalid voucher type for this endpoint." });
    expect(out.message).toBe("Invalid voucher type for this endpoint.");
  });

  it("timeout → unknown, journlWrite called once (no retry)", async () => {
    m.journlWrite.mockResolvedValue({ kind: "unknown", reason: "JournL did not answer in time" });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("unknown");
    expect(state.journl_message).toBe("JournL did not answer in time");
    expect(m.journlWrite).toHaveBeenCalledTimes(1);
    expect(m.notifyCorrectionOutcome).toHaveBeenCalledWith(ID);
  });

  it("401 from JournL after sending → unknown (user decision), not approved", async () => {
    m.journlWrite.mockResolvedValue({ kind: "session", message: "Your JournL session has expired" });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("unknown");
    expect(statuses()).toEqual(["approved->posting", "posting->unknown"]);
    expect(m.journlWrite).toHaveBeenCalledTimes(1);
  });

  it("journlWrite throwing before its request goes out → back to approved, error surfaces", async () => {
    m.journlWrite.mockRejectedValue(new AppError("UNAVAILABLE", "JournL corrections are disabled in this environment"));
    expect((await err(posting.post(reviewer, ID, ctx))).status).toBe(503);
    expect(statuses()).toEqual(["approved->posting", "posting->approved"]);
  });
});

describe("post: the opening-balance write", () => {
  beforeEach(() => setRow(openingRow()));

  it("PUT body equals the GET object except openingBalance / transactionType / branchId / updatedBy", async () => {
    const read = ledgerGet();
    m.getLedger.mockResolvedValue(read);
    m.journlWrite.mockResolvedValue({ kind: "ok", data: { success: true } });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("posted");
    const [, method, path, body] = m.journlWrite.mock.calls[0];
    expect(method).toBe("PUT");
    expect(path).toBe("companyLedgerMaster/20");
    expect(body).toEqual({ ...read, openingBalance: 500, transactionType: "receivable", branchId: 5, updatedBy: 307 });
    expect(body.openingBillEntry).toEqual([]);
    const changed = Object.keys(body).filter((k) => JSON.stringify(body[k]) !== JSON.stringify((read as Record<string, unknown>)[k]));
    expect(changed.sort()).toEqual(["openingBalance", "transactionType", "updatedBy"]); // branchId equals the ledger's own
    expect(state.journl_voucher_id).toBeNull();
  });

  it("Cr opening sends transactionType payable, 2-dp rupees", async () => {
    setRow(openingRow({ payload: { ledger_id: 20, ledger_name: "Office deposit", amount_paise: 123456, side: "cr" } }));
    await posting.post(reviewer, ID, ctx);
    expect(m.journlWrite.mock.calls[0][3]).toMatchObject({ openingBalance: 1234.56, transactionType: "payable" });
  });

  it("customer ledger: preparer re-checked on f_customers", async () => {
    m.ledgerKindOf.mockResolvedValue("customer");
    await posting.post(reviewer, ID, ctx);
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_customers");
  });

  it("opening changed in JournL since preparation → rejected / stale with the verbatim text", async () => {
    m.getLedger.mockResolvedValue(ledgerGet({ openingBalance: 300 }));
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("rejected");
    expect(state).toMatchObject({ rejected_by_source: "stale", journl_message: "The ledger changed in JournL after this correction was prepared." });
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("side flipped in JournL → stale", async () => {
    m.getLedger.mockResolvedValue(ledgerGet({ transactionType: "receivable" }));
    await posting.post(reviewer, ID, ctx);
    expect(state.journl_message).toBe(posting.STALE_LEDGER);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("JournL already shows the new value → stale (must still differ)", async () => {
    setRow(openingRow({ before_values: [{ ledger_id: 20, ledger_name: "x", before_paise: -50000, after_paise: -50000 }] }));
    m.getLedger.mockResolvedValue(ledgerGet({ openingBalance: 500, transactionType: "receivable" }));
    await posting.post(reviewer, ID, ctx);
    expect(state.status).toBe("rejected");
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it.each([
    ["turned bill-wise", { enableBillWise: 1 }],
    ["gained opening bills", { openingBillEntry: [{ id: 1, billNo: "B1", amount: 250 }] }],
  ])("ledger %s since preparation → stale with the bill-wise text", async (_n, over) => {
    m.getLedger.mockResolvedValue(ledgerGet(over));
    await posting.post(reviewer, ID, ctx);
    expect(state.journl_message).toBe(BILL_WISE_BLOCKED);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("ledger moved to another branch → stale", async () => {
    m.getLedger.mockResolvedValue(ledgerGet({ branchId: 1 }));
    await posting.post(reviewer, ID, ctx);
    expect(state.journl_message).toBe(posting.STALE_LEDGER);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("ledger deleted → stale", async () => {
    m.getLedger.mockResolvedValue(null);
    await posting.post(reviewer, ID, ctx);
    expect(state).toMatchObject({ status: "rejected", rejected_by_source: "stale" });
    expect(m.journlWrite).not.toHaveBeenCalled();
  });
});

describe("post: the Suspense adjustment", () => {
  beforeEach(() => setRow(suspenseRow()));

  it("recomputed difference equal → one PUT with the stored amount", async () => {
    m.journlWrite.mockResolvedValue({ kind: "ok", data: { success: true } });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("posted");
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_general_ledgers");
    expect(m.journlWrite.mock.calls[0][3]).toMatchObject({ id: 30, openingBalance: 123.45, transactionType: "receivable", branchId: 5, updatedBy: 307 });
  });

  it("difference changed in JournL → stale", async () => {
    m.suspenseAmount.mockResolvedValue({ amount_paise: 12000, side: "dr" });
    await posting.post(reviewer, ID, ctx);
    expect(state).toMatchObject({ status: "rejected", rejected_by_source: "stale", journl_message: posting.STALE_DIFFERENCE });
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("books already balance now → stale", async () => {
    m.suspenseAmount.mockRejectedValue(AppError.conflict("The trial balance already balances"));
    await posting.post(reviewer, ID, ctx);
    expect(state.journl_message).toBe(posting.STALE_DIFFERENCE);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("ledger no longer in the Suspense group → stale", async () => {
    m.getLedger.mockResolvedValue(ledgerGet({ id: 30, groupId: 15, primaryGroupId: 15, openingBalance: 0 }));
    await posting.post(reviewer, ID, ctx);
    expect(state.status).toBe("rejected");
    expect(m.journlWrite).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("journlUserIdOf reads id, else userId, and never throws on junk", () => {
    expect(posting.journlUserIdOf(jwt({ id: 307 }))).toBe(307);
    expect(posting.journlUserIdOf(jwt({ userId: "12" }))).toBe(12);
    expect(posting.journlUserIdOf("not-a-jwt")).toBeNull();
  });

  it("toRupees: integer paise → positive 2-dp rupees", () => {
    expect(posting.toRupees(10050)).toBe(100.5);
    expect(posting.toRupees(1)).toBe(0.01);
    expect(posting.toRupees(999999999999)).toBe(9999999999.99);
  });
});

const { logger } = await import("../../utils/logger.js");

describe("fix round 1", () => {

  it("I1: recording the outcome fails after sending → logged with ref/outcome/voucher id (no token, no body), rethrown, row left in posting, never resent", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    m.transition.mockImplementation(async (_id: number, from: CorrectionStatus, to: CorrectionStatus) => {
      if (from === "posting") throw new Error("deadlock");
      if (state.status !== from) throw AppError.conflict(`This correction was already ${state.status}`);
      state = { ...state, status: to };
      return { ...state };
    });
    const e = await err(posting.post(reviewer, ID, ctx));
    expect(e.message).toBe("deadlock");
    expect(state.status).toBe("posting");
    expect(m.journlWrite).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const [fields] = spy.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(fields).toMatchObject({ correction: "ACZ-101", outcome: "ok", voucherId: "9876" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("Voucher added successfully");
    // A second post can't resend: the row is posting.
    expect((await err(posting.post(reviewer, ID, ctx))).status).toBe(409);
    spy.mockRestore();
  });

  it("I2: opening bill list missing from JournL's GET at post → rejected / stale, nothing sent", async () => {
    setRow(openingRow());
    const l = ledgerGet() as Record<string, unknown>;
    delete l.openingBillEntry;
    m.getLedger.mockResolvedValue(l);
    await posting.post(reviewer, ID, ctx);
    expect(state).toMatchObject({ status: "rejected", rejected_by_source: "stale", journl_message: "JournL didn't return the ledger's opening bills; correct it in JournL" });
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("I2: opening bill list not an array → rejected / stale", async () => {
    setRow(suspenseRow());
    m.getLedger.mockResolvedValue(ledgerGet({ id: 30, groupId: 9, primaryGroupId: 9, openingBalance: 0, openingBillEntry: "[]" }));
    await posting.post(reviewer, ID, ctx);
    expect(state.journl_message).toBe("JournL didn't return the ledger's opening bills; correct it in JournL");
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("writes disabled is checked before the approver/preparer re-checks (nothing changes state)", async () => {
    m.assertWritesEnabled.mockImplementation(() => {
      throw new AppError("UNAVAILABLE", "JournL corrections are disabled in this environment");
    });
    m.findActiveUser.mockResolvedValue(null); // approver and preparer both gone
    expect((await err(posting.post(reviewer, ID, ctx))).status).toBe(503);
    expect(state.status).toBe("approved");
    expect(m.findActiveUser).not.toHaveBeenCalled();
    expect(m.transition).not.toHaveBeenCalled();
  });

  it.each([
    ["30 s", 30_000],
    ["59 s", 59_000],
    ["already past", -1_000],
  ])("session expiring within 60 s (%s left) → stays approved with the refresh message, nothing sent", async (_n, left) => {
    m.openJournlSession.mockResolvedValue({ token: TOKEN, companyId: "218", expiresAt: new Date(Date.now() + left) });
    const out = await posting.post(reviewer, ID, ctx);
    expect(out.status).toBe("approved");
    expect(out.message).toBe(posting.WAITING_FOR_OWNER);
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("session with more than 60 s left is used", async () => {
    m.openJournlSession.mockResolvedValue({ token: TOKEN, companyId: "218", expiresAt: new Date(Date.now() + 90_000) });
    expect((await posting.post(reviewer, ID, ctx)).status).toBe("posted");
  });
});
