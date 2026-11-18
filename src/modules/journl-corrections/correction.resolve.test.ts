import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { CorrectionRow } from "./correction.types.js";

/** Check JournL, manual resolve, prepare again. Service-level with everything mocked; JournL writes must never happen. */

const m = vi.hoisted(() => ({
  requireClientAccess: vi.fn(),
  requirePrepare: vi.fn(),
  requireApprove: vi.fn(),
  canApprove: vi.fn(),
  insertDraft: vi.fn(),
  findCorrection: vi.fn(),
  events: vi.fn(),
  journlConnectionFor: vi.fn(),
  setDraftJournlContext: vi.fn(),
  transition: vi.fn(),
  previewJournal: vi.fn(),
  previewOpening: vi.fn(),
  previewSuspense: vi.fn(),
  assertOpeningMonthsOpen: vi.fn(),
  branches: vi.fn(),
  getLedger: vi.fn(),
  ledgerGroups: vi.fn(),
  openingEntryBranch: vi.fn(),
  findVoucherByRef: vi.fn(),
  openJournlSession: vi.fn(),
  journlWrite: vi.fn(),
  recordAudit: vi.fn(),
  conn: { tag: "tx" },
}));

vi.mock("../access/client-access.js", () => ({ requireClientAccess: m.requireClientAccess }));
vi.mock("./correction.access.js", async (orig) => ({
  ...(await orig<typeof import("./correction.access.js")>()),
  requirePrepare: m.requirePrepare,
  requireApprove: m.requireApprove,
  canApprove: m.canApprove,
}));
vi.mock("./correction.repository.js", () => ({
  insertDraft: m.insertDraft,
  findCorrection: m.findCorrection,
  events: m.events,
  journlConnectionFor: m.journlConnectionFor,
  setDraftJournlContext: m.setDraftJournlContext,
}));
vi.mock("./correction.state.js", () => ({ transition: m.transition }));
vi.mock("./correction.preview.js", () => ({ previewJournal: m.previewJournal, previewOpening: m.previewOpening, previewSuspense: m.previewSuspense, assertOpeningMonthsOpen: m.assertOpeningMonthsOpen }));
vi.mock("./journl-books.js", async (orig) => ({
  ...(await orig<typeof import("./journl-books.js")>()),
  branches: m.branches,
  getLedger: m.getLedger,
  ledgerGroups: m.ledgerGroups,
  openingEntryBranch: m.openingEntryBranch,
  findVoucherByRef: m.findVoucherByRef,
}));
vi.mock("../integrations/journl.gateway.js", async (orig) => ({ ...(await orig<typeof import("../integrations/journl.gateway.js")>()), journlWrite: m.journlWrite }));
vi.mock("../integrations/journl-data.service.js", () => ({ openJournlSession: m.openJournlSession }));
vi.mock("../notifications/notification.service.js", () => ({ notifyCorrectionSubmitted: vi.fn(), notifyCorrectionDecided: vi.fn() }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../integrations/journl-features.js", () => ({ JOURNL_FEATURE_LIST: [] }));
vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));

const svc = await import("./correction.service.js");

const preparer = { id: 7, fullName: "Rahul", email: "r@x.in", role: "bookkeeper" } as AuthUser;
const reviewer = { id: 8, fullName: "Meera", email: "m@x.in", role: "finance_manager" } as AuthUser;
const admin = { id: 1, fullName: "Admin", email: "a@x.in", role: "super_admin" } as AuthUser;
const ctx = { requestId: "req-1", ipAddress: "1.2.3.4", endpoint: "POST /x" };
const CLIENT = 42;

const lines = [
  { ledger_id: 10, ledger_name: "L10", side: "dr" as const, amount_paise: 10000 },
  { ledger_id: 11, ledger_name: "L11", side: "cr" as const, amount_paise: 10000 },
];
const row = (over: Partial<CorrectionRow> = {}): CorrectionRow =>
  ({
    id: 101,
    client_id: CLIENT,
    kind: "journal_entry",
    purpose: "correction",
    status: "unknown",
    initiated_by: preparer.id,
    reason: "Reclass",
    journl_branch_id: 5,
    payload: { voucher_date: "2026-11-01", lines },
    before_values: null,
    after_values: null,
    ...over,
  }) as CorrectionRow;
const opening = (over: Partial<CorrectionRow> = {}) =>
  row({
    kind: "opening_balance",
    payload: { ledger_id: 20, ledger_name: "Cash", amount_paise: 5000, side: "dr" },
    before_values: [{ ledger_id: 20, ledger_name: "Cash", before_paise: -1000, after_paise: -1000 }],
    after_values: [{ ledger_id: 20, ledger_name: "Cash", before_paise: -1000, after_paise: -5000 }],
    ...over,
  });

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected rejection");
};

beforeEach(() => {
  vi.resetAllMocks();
  m.requireClientAccess.mockResolvedValue(undefined);
  m.requirePrepare.mockResolvedValue(undefined);
  m.requireApprove.mockResolvedValue(undefined);
  m.canApprove.mockResolvedValue(false);
  m.journlConnectionFor.mockResolvedValue({ id: 9, status: "connected", external_org_id: "218", authorized_by: 55 });
  m.openJournlSession.mockResolvedValue({ token: "tok", companyId: "218", expiresAt: new Date() });
  m.branches.mockResolvedValue([{ id: 5, name: "HO" }]);
  m.previewJournal.mockImplementation(async (_s, _c, p) => ({ payload: p, before: [], after: [], tb_difference_before: 0, tb_difference_after: 0 }));
  m.insertDraft.mockResolvedValue(202);
  m.setDraftJournlContext.mockResolvedValue(true);
  m.events.mockResolvedValue([]);
  m.transition.mockResolvedValue(row());
  m.findCorrection.mockResolvedValue(row());
});

describe("checkJournl", () => {
  it("409 when the correction is not unknown, without touching JournL", async () => {
    m.findCorrection.mockResolvedValue(row({ status: "posted" }));
    expect((await err(svc.checkJournl(reviewer, 101, ctx))).status).toBe(409);
    expect(m.findVoucherByRef).not.toHaveBeenCalled();
    expect(m.openJournlSession).not.toHaveBeenCalled();
  });

  it("the preparer cannot check their own (approver rules)", async () => {
    m.requireApprove.mockRejectedValue(new AppError("FORBIDDEN", "no"));
    expect((await err(svc.checkJournl(preparer, 101, ctx))).status).toBe(403);
    expect(m.requireApprove).toHaveBeenCalledWith(preparer, CLIENT, preparer.id);
  });

  it("journal found by ref -> posted with that voucher id", async () => {
    m.findVoucherByRef.mockResolvedValue([{ id: "555" }]);
    const r = await svc.checkJournl(reviewer, 101, ctx);
    expect(m.findVoucherByRef).toHaveBeenCalledWith("tok", "ACZ-101");
    expect(m.transition).toHaveBeenCalledWith(101, "unknown", "posted", reviewer, ctx, { journl_voucher_id: "555" }, expect.any(String));
    expect(r.found).toBe(true);
    expect(m.journlWrite).toHaveBeenCalledTimes(0);
  });

  it("journal not found -> stays unknown", async () => {
    m.findVoucherByRef.mockResolvedValue([]);
    expect(await svc.checkJournl(admin, 101, ctx)).toEqual({ found: false });
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.journlWrite).toHaveBeenCalledTimes(0);
  });

  it("several vouchers -> anomaly, no pick, stays unknown", async () => {
    m.findVoucherByRef.mockResolvedValue([{ id: "1" }, { id: "2" }]);
    expect(await svc.checkJournl(reviewer, 101, ctx)).toEqual({ found: true, anomaly: "multiple", ids: ["1", "2"] });
    expect(m.transition).not.toHaveBeenCalled();
  });

  it("JournL read failure propagates and nothing changes", async () => {
    m.findVoucherByRef.mockRejectedValue(new AppError("UNAVAILABLE", "down"));
    expect((await err(svc.checkJournl(reviewer, 101, ctx))).code).toBe("UNAVAILABLE");
    expect(m.transition).not.toHaveBeenCalled();
  });

  it("opening equal to the intended value -> posted", async () => {
    m.findCorrection.mockResolvedValue(opening());
    m.getLedger.mockResolvedValue({ id: 20, openingBalance: 50, transactionType: "receivable" });
    const r = await svc.checkJournl(reviewer, 101, ctx);
    expect(r.found).toBe(true);
    expect(m.transition).toHaveBeenCalledWith(101, "unknown", "posted", reviewer, ctx, {}, expect.any(String));
    expect(m.journlWrite).toHaveBeenCalledTimes(0);
  });

  it("opening still at the old value -> unknown, matches_before true", async () => {
    m.findCorrection.mockResolvedValue(opening());
    m.getLedger.mockResolvedValue({ id: 20, openingBalance: 10, transactionType: "receivable" });
    expect(await svc.checkJournl(reviewer, 101, ctx)).toEqual({ found: false, matches_before: true });
    expect(m.transition).not.toHaveBeenCalled();
  });

  it("opening with an unrecognised side and a non-zero amount throws and stays unknown", async () => {
    m.findCorrection.mockResolvedValue(opening());
    m.getLedger.mockResolvedValue({ id: 20, openingBalance: 50, transactionType: "weird" });
    const e = await err(svc.checkJournl(reviewer, 101, ctx));
    expect(e.code).toBe("UNAVAILABLE");
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.journlWrite).toHaveBeenCalledTimes(0);
  });

  it("opening at some other value -> unknown, matches_before false", async () => {
    m.findCorrection.mockResolvedValue(opening());
    m.getLedger.mockResolvedValue({ id: 20, openingBalance: 99, transactionType: "payable" });
    expect(await svc.checkJournl(reviewer, 101, ctx)).toEqual({ found: false, matches_before: false });
    expect(m.journlWrite).toHaveBeenCalledTimes(0);
  });
});

describe("resolveManually", () => {
  it("400 without a note, before anything else", async () => {
    const e = await err(svc.resolveManually(reviewer, 101, "posted", "   ", undefined, ctx));
    expect(e.status).toBe(400);
    expect(m.transition).not.toHaveBeenCalled();
  });

  it("409 when not unknown", async () => {
    m.findCorrection.mockResolvedValue(row({ status: "pending_approval" }));
    expect((await err(svc.resolveManually(reviewer, 101, "rejected", "checked", undefined, ctx))).status).toBe(409);
  });

  it("posted keeps the voucher id", async () => {
    await svc.resolveManually(reviewer, 101, "posted", "Saw it in JournL", "777", ctx);
    expect(m.transition).toHaveBeenCalledWith(101, "unknown", "posted", reviewer, ctx, { journl_voucher_id: "777" }, expect.stringContaining("Saw it"));
  });

  it("rejected records source journl with the note as message (max 1000)", async () => {
    await svc.resolveManually(reviewer, 101, "rejected", "x".repeat(1500), undefined, ctx);
    const fields = m.transition.mock.calls[0][5];
    expect(fields.rejected_by_source).toBe("journl");
    expect(fields.journl_message).toHaveLength(1000);
  });

  it("the initiator cannot resolve", async () => {
    m.requireApprove.mockRejectedValue(new AppError("FORBIDDEN", "no"));
    expect((await err(svc.resolveManually(preparer, 101, "posted", "n", undefined, ctx))).status).toBe(403);
    expect(m.transition).not.toHaveBeenCalled();
  });

  it("never writes to JournL", () => {
    expect(m.journlWrite).toHaveBeenCalledTimes(0);
  });
});

describe("prepareAgain", () => {
  const stale = (over: Partial<CorrectionRow> = {}) => row({ status: "rejected", rejected_by_source: "stale", ...over });

  it("409 on a reviewer-rejected correction", async () => {
    m.findCorrection.mockResolvedValue(stale({ rejected_by_source: "reviewer" }));
    expect((await err(svc.prepareAgain(preparer, 101, ctx))).status).toBe(409);
    expect(m.insertDraft).not.toHaveBeenCalled();
  });

  it("409 when not rejected", async () => {
    m.findCorrection.mockResolvedValue(row({ status: "unknown" }));
    expect((await err(svc.prepareAgain(preparer, 101, ctx))).status).toBe(409);
  });

  it("admins never prepare", async () => {
    m.findCorrection.mockResolvedValue(stale());
    expect((await err(svc.prepareAgain(admin, 101, ctx))).status).toBe(403);
    expect(m.insertDraft).not.toHaveBeenCalled();
  });

  it("journal: new draft copies lines and branch, sets copied_from, re-previews live", async () => {
    m.findCorrection.mockResolvedValueOnce(stale()).mockResolvedValue(row({ id: 202, status: "draft" }));
    const r = await svc.prepareAgain(preparer, 101, ctx);
    expect(m.previewJournal).toHaveBeenCalledTimes(1);
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_journal");
    const d = m.insertDraft.mock.calls[0][0];
    expect(d).toMatchObject({ copiedFrom: 101, kind: "journal_entry", journlBranchId: 5, reason: "Reclass", initiatedBy: preparer.id });
    expect(d.payload.lines).toEqual(lines);
    expect(r.id).toBe(202);
    expect(m.journlWrite).toHaveBeenCalledTimes(0);
  });

  it("suspense: amount is recomputed from the books, not copied", async () => {
    m.findCorrection
      .mockResolvedValueOnce(stale({ kind: "opening_balance", purpose: "unresolved_tb_difference", payload: { ledger_id: 30, ledger_name: "Suspense", amount_paise: 100, side: "cr" } }))
      .mockResolvedValue(row({ id: 202, status: "draft" }));
    const after = { ledger_id: 30, ledger_name: "Suspense", amount_paise: 999, side: "dr" as const };
    m.previewSuspense.mockResolvedValue({ before: { ...after, amount_paise: 0 }, after, tb_difference_before: -999, tb_difference_after: 0 });
    m.openingEntryBranch.mockResolvedValue(3);
    await svc.prepareAgain(preparer, 101, ctx);
    expect(m.previewSuspense).toHaveBeenCalledWith(expect.anything(), CLIENT, 30);
    expect(m.insertDraft.mock.calls[0][0]).toMatchObject({ copiedFrom: 101, purpose: "unresolved_tb_difference", payload: after });
  });

  it("opening: bill-wise refusal from the preview stops it", async () => {
    m.findCorrection.mockResolvedValue(stale({ kind: "opening_balance", payload: { ledger_id: 20, ledger_name: "C", amount_paise: 5, side: "dr" } }));
    m.getLedger.mockResolvedValue({ id: 20, groupId: 1, primaryGroupId: 1, groupName: "Cash" });
    m.previewOpening.mockRejectedValue(new AppError("VALIDATION_ERROR", "bill by bill"));
    expect((await err(svc.prepareAgain(preparer, 101, ctx))).status).toBe(400);
    expect(m.insertDraft).not.toHaveBeenCalled();
  });
});

describe("rows stuck in posting (Task 8 fix I1)", () => {
  const stuck = () => row({ status: "posting", stuck_posting: 1 });
  const young = () => row({ status: "posting", stuck_posting: 0 });

  it("checkJournl on a stuck row: posting → unknown first, then checks (never resends)", async () => {
    m.findCorrection.mockResolvedValue(stuck());
    m.findVoucherByRef.mockResolvedValue([{ id: "555" }]);
    const r = await svc.checkJournl(reviewer, 101, ctx);
    expect(m.transition.mock.calls[0]).toEqual([101, "posting", "unknown", reviewer, ctx, {}, "Stuck in posting; moved to unknown for checking"]);
    expect(m.transition.mock.calls[1].slice(1, 3)).toEqual(["unknown", "posted"]);
    expect(r.found).toBe(true);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("checkJournl on a stuck row that JournL doesn't have: left unknown", async () => {
    m.findCorrection.mockResolvedValue(stuck());
    m.findVoucherByRef.mockResolvedValue([]);
    expect(await svc.checkJournl(reviewer, 101, ctx)).toEqual({ found: false });
    expect(m.transition).toHaveBeenCalledTimes(1);
    expect(m.journlWrite).not.toHaveBeenCalled();
  });

  it("a posting row younger than 2 minutes → 409 'Posting is in progress', nothing changes", async () => {
    m.findCorrection.mockResolvedValue(young());
    for (const p of [svc.checkJournl(reviewer, 101, ctx), svc.resolveManually(reviewer, 101, "posted", "Saw it", undefined, ctx)]) {
      const e = await err(p);
      expect(e.status).toBe(409);
      expect(e.message).toBe("Posting is in progress");
    }
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.openJournlSession).not.toHaveBeenCalled();
  });

  it("resolveManually on a stuck row: posting → unknown, then resolved", async () => {
    m.findCorrection.mockResolvedValue(stuck());
    await svc.resolveManually(reviewer, 101, "posted", "Saw it in JournL", "777", ctx);
    expect(m.transition.mock.calls.map((c) => `${c[1]}->${c[2]}`)).toEqual(["posting->unknown", "unknown->posted"]);
  });

  it("the preparer can't release a stuck row (approver rules first)", async () => {
    m.findCorrection.mockResolvedValue(stuck());
    m.requireApprove.mockRejectedValue(new AppError("FORBIDDEN", "no"));
    expect((await err(svc.checkJournl(preparer, 101, ctx))).status).toBe(403);
    expect(m.transition).not.toHaveBeenCalled();
  });

  it("get flags stuck rows (and only posting ones) so the UI can offer Check JournL", async () => {
    m.findCorrection.mockResolvedValue(stuck());
    const g = await svc.get(reviewer, 101);
    expect(g.stuck).toBe(true);
    expect(g).not.toHaveProperty("stuck_posting");
    m.findCorrection.mockResolvedValue(young());
    expect((await svc.get(reviewer, 101)).stuck).toBe(false);
    m.findCorrection.mockResolvedValue(row({ status: "unknown", stuck_posting: 1 }));
    expect((await svc.get(reviewer, 101)).stuck).toBe(false);
  });
});
