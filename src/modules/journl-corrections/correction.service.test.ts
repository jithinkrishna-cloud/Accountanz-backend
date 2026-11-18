import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { CorrectionRow } from "./correction.types.js";

const m = vi.hoisted(() => ({
  requireClientAccess: vi.fn(),
  requirePrepare: vi.fn(),
  requireApprove: vi.fn(),
  canApprove: vi.fn(),
  insertDraft: vi.fn(),
  findCorrection: vi.fn(),
  listForClient: vi.fn(),
  listAwaitingApproval: vi.fn(),
  updateDraft: vi.fn(),
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
  openJournlSession: vi.fn(),
  notifyCorrectionSubmitted: vi.fn(),
  notifyCorrectionDecided: vi.fn(),
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
  listForClient: m.listForClient,
  listAwaitingApproval: m.listAwaitingApproval,
  updateDraft: m.updateDraft,
  events: m.events,
  journlConnectionFor: m.journlConnectionFor,
  setDraftJournlContext: m.setDraftJournlContext,
}));
vi.mock("./correction.state.js", () => ({ transition: m.transition }));
vi.mock("./correction.preview.js", () => ({ previewJournal: m.previewJournal, previewOpening: m.previewOpening, previewSuspense: m.previewSuspense, assertOpeningMonthsOpen: m.assertOpeningMonthsOpen }));
vi.mock("./journl-books.js", () => ({ branches: m.branches, getLedger: m.getLedger, ledgerGroups: m.ledgerGroups, openingEntryBranch: m.openingEntryBranch }));
vi.mock("../integrations/journl-data.service.js", () => ({ openJournlSession: m.openJournlSession }));
vi.mock("../notifications/notification.service.js", () => ({ notifyCorrectionSubmitted: m.notifyCorrectionSubmitted, notifyCorrectionDecided: m.notifyCorrectionDecided }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../integrations/journl-features.js", () => ({ JOURNL_FEATURE_LIST: [] }));
vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));

const svc = await import("./correction.service.js");
const { BILL_WISE_BLOCKED } = await vi.importActual<typeof import("./correction.preview.js")>("./correction.preview.js");

const preparer = { id: 7, fullName: "Rahul", email: "r@x.in", role: "bookkeeper" } as AuthUser;
const reviewer = { id: 8, fullName: "Meera", email: "m@x.in", role: "finance_manager" } as AuthUser;
const admin = { id: 1, fullName: "Admin", email: "a@x.in", role: "super_admin" } as AuthUser;
const ops = { id: 2, fullName: "Ops", email: "o@x.in", role: "ops_admin" } as AuthUser;
const ctx = { requestId: "req-1", ipAddress: "1.2.3.4", endpoint: "POST /api/team/workspace/clients/42/journl/corrections" };
const CLIENT = 42;
const TOKEN = "owner-secret-token";

const journalInput = {
  kind: "journal_entry" as const,
  purpose: "correction" as const,
  reason: "Reclass",
  branch_id: 5,
  journal: {
    voucher_date: "2026-11-01",
    lines: [
      { ledger_id: 10, ledger_name: "", side: "dr" as const, amount_paise: 10000 },
      { ledger_id: 11, ledger_name: "", side: "cr" as const, amount_paise: 10000 },
    ],
  },
};
const openingInput = { kind: "opening_balance" as const, purpose: "correction" as const, reason: "Fix opening", opening: { ledger_id: 20, ledger_name: "", amount_paise: 5000, side: "dr" as const } };
const suspenseInput = { kind: "opening_balance" as const, purpose: "unresolved_tb_difference" as const, reason: "Books from old system", ledger_id: 30 };

const row = (over: Partial<CorrectionRow> = {}): CorrectionRow =>
  ({ id: 101, client_id: CLIENT, kind: "journal_entry", purpose: "correction", status: "draft", initiated_by: preparer.id, reason: "Reclass", ...over }) as CorrectionRow;

beforeEach(() => {
  vi.resetAllMocks();
  m.requireClientAccess.mockResolvedValue(undefined);
  m.requirePrepare.mockResolvedValue(undefined);
  m.requireApprove.mockResolvedValue(undefined);
  m.canApprove.mockResolvedValue(false);
  m.journlConnectionFor.mockResolvedValue({ id: 9, status: "connected", external_org_id: "218", authorized_by: 55 });
  m.openJournlSession.mockResolvedValue({ token: TOKEN, companyId: "218", expiresAt: new Date() });
  m.branches.mockResolvedValue([{ id: 5, name: "Head office" }, { id: 6, name: "Pune" }]);
  m.previewJournal.mockImplementation(async (_s, _c, p) => ({
    payload: { ...p, lines: p.lines.map((l: { ledger_id: number }) => ({ ...l, ledger_name: `L${l.ledger_id}` })) },
    before: [{ ledger_id: 10, ledger_name: "L10", before_paise: 0, after_paise: 0 }],
    after: [{ ledger_id: 10, ledger_name: "L10", before_paise: 0, after_paise: -10000 }],
    tb_difference_before: 0,
    tb_difference_after: 0,
  }));
  m.insertDraft.mockResolvedValue(101);
  m.setDraftJournlContext.mockResolvedValue(true);
  m.updateDraft.mockResolvedValue(true);
  m.findCorrection.mockResolvedValue(row());
  m.events.mockResolvedValue([]);
  m.transition.mockResolvedValue(row());
  m.openingEntryBranch.mockResolvedValue(3);
});

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected a rejection");
};

describe("createDraft", () => {
  it("403 without Correct access, before anything is stored", async () => {
    m.requirePrepare.mockRejectedValue(new AppError("FORBIDDEN", "You don't have Correct access for Journal on this client."));
    const e = await err(svc.createDraft(preparer, CLIENT, journalInput, ctx));
    expect(e.status).toBe(403);
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_journal");
    expect(m.insertDraft).not.toHaveBeenCalled();
  });

  it("stores the chosen branch, the connection and the JournL session owner; previews into before/after", async () => {
    const out = await svc.createDraft(preparer, CLIENT, journalInput, ctx);
    const [draft, db] = m.insertDraft.mock.calls[0];
    expect(db).toBe(m.conn);
    expect(draft).toMatchObject({ clientId: CLIENT, connectionId: 9, journlCompanyId: "218", journlBranchId: 5, kind: "journal_entry", purpose: "correction", initiatedBy: 7, reason: "Reclass" });
    expect(draft.payload.lines[0].ledger_name).toBe("L10");
    expect(draft.after[0].after_paise).toBe(-10000);
    expect(m.setDraftJournlContext).toHaveBeenCalledWith(101, 5, 55, m.conn);
    expect(m.recordAudit).toHaveBeenCalledTimes(1);
    expect(out.ref).toBe("ACZ-101");
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("400 when the journal's branch isn't one of the company's branches", async () => {
    const e = await err(svc.createDraft(preparer, CLIENT, { ...journalInput, branch_id: 99 }, ctx));
    expect(e.status).toBe(400);
    expect(m.insertDraft).not.toHaveBeenCalled();
  });

  it("409 when the client hasn't connected JournL", async () => {
    m.journlConnectionFor.mockResolvedValue({ id: 9, status: "disconnected", external_org_id: null, authorized_by: null });
    const e = await err(svc.createDraft(preparer, CLIENT, journalInput, ctx));
    expect(e.status).toBe(409);
    expect(e.message).toBe("This client hasn't connected JournL yet");
    expect(m.openJournlSession).not.toHaveBeenCalled();
  });

  it("404 for a client the actor can't see", async () => {
    m.requireClientAccess.mockRejectedValue(AppError.notFound("Client"));
    const e = await err(svc.createDraft(preparer, CLIENT, journalInput, ctx));
    expect(e.status).toBe(404);
    expect(m.journlConnectionFor).not.toHaveBeenCalled();
  });

  it.each([admin, ops])("%s can't prepare (403), before any JournL read", async (who) => {
    const e = await err(svc.createDraft(who, CLIENT, journalInput, ctx));
    expect(e.status).toBe(403);
    expect(m.openJournlSession).not.toHaveBeenCalled();
    expect(m.insertDraft).not.toHaveBeenCalled();
  });

  it("opening balance: branch comes from the ledger's opening entry; customer ledgers need f_customers", async () => {
    m.getLedger.mockResolvedValue({ id: 20, name: "Acme", groupId: 40, primaryGroupId: 26, openingBalance: 0, transactionType: null, enableBillWise: 0, branchId: 3 });
    m.previewOpening.mockResolvedValue({
      before: { ledger_id: 20, ledger_name: "Acme", amount_paise: 0, side: "cr" },
      after: { ledger_id: 20, ledger_name: "Acme", amount_paise: 5000, side: "dr" },
      tb_difference_before: 0,
      tb_difference_after: 5000,
    });
    await svc.createDraft(preparer, CLIENT, openingInput, ctx);
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_customers");
    const [draft] = m.insertDraft.mock.calls[0];
    expect(draft.journlBranchId).toBe(3);
    expect(draft.payload).toEqual({ ledger_id: 20, ledger_name: "Acme", amount_paise: 5000, side: "dr" });
    expect(draft.after).toEqual([{ ledger_id: 20, ledger_name: "Acme", before_paise: 0, after_paise: -5000 }]);
    expect(m.branches).not.toHaveBeenCalled();
  });

  it("opening balance: a user-made 'Sundry Creditors' group (id 29 under primary 3) needs f_suppliers", async () => {
    m.getLedger.mockResolvedValue({ id: 20, name: "Vendor", groupId: 29, primaryGroupId: 3, openingBalance: 0, transactionType: null, enableBillWise: 0, branchId: 3 });
    m.ledgerGroups.mockResolvedValue([{ id: 29, name: "Sundry Creditors" }]);
    m.previewOpening.mockResolvedValue({ before: { ledger_id: 20, ledger_name: "Vendor", amount_paise: 0, side: "cr" }, after: { ledger_id: 20, ledger_name: "Vendor", amount_paise: 5000, side: "dr" }, tb_difference_before: 0, tb_difference_after: 0 });
    await svc.createDraft(preparer, CLIENT, openingInput, ctx);
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_suppliers");
  });

  it("opening balance on a bill-wise ledger surfaces as 400 and stores nothing", async () => {
    m.getLedger.mockResolvedValue({ id: 20, name: "Acme", groupId: 1, primaryGroupId: 1, groupName: "Cash", openingBalance: 0, transactionType: null, enableBillWise: 1, branchId: 3 });
    m.previewOpening.mockRejectedValue(new AppError("VALIDATION_ERROR", BILL_WISE_BLOCKED));
    const e = await err(svc.createDraft(preparer, CLIENT, openingInput, ctx));
    expect(e.status).toBe(400);
    expect(e.message).toBe(BILL_WISE_BLOCKED);
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_general_ledgers");
    expect(m.insertDraft).not.toHaveBeenCalled();
  });

  it("Suspense: amount/side from the books, reason prefixed with the fixed copy, f_general_ledgers", async () => {
    m.previewSuspense.mockResolvedValue({
      ledger: { id: 30, name: "Suspense A/c", group_id: 9, group_name: "Suspense A/c" },
      amount_paise: 12345,
      side: "dr",
      before: { ledger_id: 30, ledger_name: "Suspense A/c", amount_paise: 0, side: "cr" },
      after: { ledger_id: 30, ledger_name: "Suspense A/c", amount_paise: 12345, side: "dr" },
      tb_difference_before: 12345,
      tb_difference_after: 0,
    });
    await svc.createDraft(preparer, CLIENT, suspenseInput, ctx);
    expect(m.requirePrepare).toHaveBeenCalledWith(preparer, CLIENT, "f_general_ledgers");
    expect(m.previewSuspense).toHaveBeenCalledWith({ token: TOKEN, companyId: "218" }, CLIENT, 30);
    const [draft] = m.insertDraft.mock.calls[0];
    expect(draft.purpose).toBe("unresolved_tb_difference");
    expect(draft.payload).toEqual({ ledger_id: 30, ledger_name: "Suspense A/c", amount_paise: 12345, side: "dr" });
    expect(draft.reason).toBe("Temporary adjustment: unresolved trial balance difference. Books from old system");
    expect(draft.journlBranchId).toBe(3);
  });
});

describe("updateDraft", () => {
  it("only the initiator can edit a draft", async () => {
    const e = await err(svc.updateDraft(reviewer, 101, journalInput, ctx));
    expect(e.status).toBe(403);
    expect(m.updateDraft).not.toHaveBeenCalled();
  });

  it("only drafts can be edited", async () => {
    m.findCorrection.mockResolvedValue(row({ status: "pending_approval" }));
    const e = await err(svc.updateDraft(preparer, 101, journalInput, ctx));
    expect(e.status).toBe(409);
  });

  it("re-previews and stores the new values and branch", async () => {
    await svc.updateDraft(preparer, 101, { ...journalInput, branch_id: 6 }, ctx);
    expect(m.updateDraft).toHaveBeenCalledWith(101, expect.objectContaining({ voucher_date: "2026-11-01" }), expect.any(Array), expect.any(Array), "Reclass", m.conn);
    expect(m.setDraftJournlContext).toHaveBeenCalledWith(101, 6, 55, m.conn);
  });

  it("404 when the correction belongs to another client than the URL's", async () => {
    const e = await err(svc.updateDraft(preparer, 101, journalInput, ctx, 99));
    expect(e.status).toBe(404);
  });
});

describe("submit", () => {
  it("moves the draft to pending_approval and notifies approvers once", async () => {
    await svc.submit(preparer, 101, ctx);
    expect(m.transition).toHaveBeenCalledWith(101, "draft", "pending_approval", preparer, ctx);
    expect(m.notifyCorrectionSubmitted).toHaveBeenCalledTimes(1);
    expect(m.notifyCorrectionSubmitted).toHaveBeenCalledWith(101);
  });

  it("only the initiator can submit", async () => {
    const e = await err(svc.submit(reviewer, 101, ctx));
    expect(e.status).toBe(403);
    expect(m.transition).not.toHaveBeenCalled();
  });

  it("404 for a correction on a client the actor can't see", async () => {
    m.requireClientAccess.mockRejectedValue(AppError.notFound("Correction"));
    const e = await err(svc.submit(preparer, 101, ctx));
    expect(e.status).toBe(404);
    expect(m.transition).not.toHaveBeenCalled();
  });
});

describe("send back and reject", () => {
  beforeEach(() => m.findCorrection.mockResolvedValue(row({ status: "pending_approval" })));

  it.each(["", "   "])("send-back needs a comment (%j)", async (c) => {
    const e = await err(svc.sendBack(reviewer, 101, c, ctx));
    expect(e.status).toBe(400);
    expect(m.transition).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("reject needs a comment (%j)", async (c) => {
    const e = await err(svc.reject(reviewer, 101, c, ctx));
    expect(e.status).toBe(400);
    expect(m.transition).not.toHaveBeenCalled();
  });

  it("send-back returns it to draft with the comment and tells the preparer", async () => {
    await svc.sendBack(reviewer, 101, " Use the March date ", ctx);
    expect(m.requireApprove).toHaveBeenCalledWith(reviewer, CLIENT, preparer.id);
    expect(m.transition).toHaveBeenCalledWith(101, "pending_approval", "draft", reviewer, ctx, { review_comment: "Use the March date" }, "Use the March date");
    expect(m.notifyCorrectionDecided).toHaveBeenCalledWith(101);
  });

  it("reject records reviewer as the source and tells the preparer", async () => {
    await svc.reject(reviewer, 101, "Wrong ledger", ctx);
    expect(m.transition).toHaveBeenCalledWith(101, "pending_approval", "rejected", reviewer, ctx, { review_comment: "Wrong ledger", rejected_by_source: "reviewer" }, "Wrong ledger");
    expect(m.notifyCorrectionDecided).toHaveBeenCalledTimes(1);
  });

  it("the initiator can't reject their own correction (403)", async () => {
    m.requireApprove.mockRejectedValue(new AppError("FORBIDDEN", "You can't approve your own correction"));
    const e = await err(svc.reject(preparer, 101, "nope", ctx));
    expect(e.status).toBe(403);
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.notifyCorrectionDecided).not.toHaveBeenCalled();
  });

  it("super_admin can review", async () => {
    await svc.reject(admin, 101, "Not needed", ctx);
    expect(m.transition).toHaveBeenCalledWith(101, "pending_approval", "rejected", admin, ctx, expect.anything(), "Not needed");
  });
});

describe("list, get, awaiting", () => {
  it("list is client-scoped (404) and carries refs", async () => {
    m.listForClient.mockResolvedValue([row()]);
    expect((await svc.list(preparer, CLIENT))[0].ref).toBe("ACZ-101");
    m.requireClientAccess.mockRejectedValue(AppError.notFound("Client"));
    expect((await err(svc.list(preparer, CLIENT))).status).toBe(404);
  });

  it("get includes events and what the actor may do", async () => {
    m.findCorrection.mockResolvedValue(row({ status: "pending_approval" }));
    m.events.mockResolvedValue([{ id: 1, to_status: "pending_approval" }]);
    m.canApprove.mockResolvedValue(true);
    const out = await svc.get(reviewer, 101);
    expect(out.events).toHaveLength(1);
    expect(out.can_review).toBe(true);
    expect(out.can_edit).toBe(false);
  });

  it("get 404s for an unknown correction", async () => {
    m.findCorrection.mockResolvedValue(null);
    expect((await err(svc.get(preparer, 999))).status).toBe(404);
  });

  it("awaiting returns count and items", async () => {
    m.listAwaitingApproval.mockResolvedValue([row({ status: "pending_approval" })]);
    expect(await svc.awaitingMyApproval(reviewer)).toMatchObject({ count: 1, items: [{ ref: "ACZ-101" }] });
  });
});

describe("closed months block opening-balance corrections at prepare (Task 8, user decision)", () => {
  const closed = () => new AppError("VALIDATION_ERROR", "Opening balances can't be changed while a month is closed in Accountanz (closed: April 2026). Reopen that month first.");
  beforeEach(() => {
    m.ledgerGroups.mockResolvedValue([]);
    m.getLedger.mockResolvedValue({ id: 20, name: "Cash", groupId: 18, primaryGroupId: 18, openingBalance: 0, transactionType: null, enableBillWise: 0, branchId: 3 });
    m.previewOpening.mockResolvedValue({ before: { ledger_id: 20, ledger_name: "Cash", amount_paise: 0, side: "cr" }, after: { ledger_id: 20, ledger_name: "Cash", amount_paise: 5000, side: "dr" }, tb_difference_before: 0, tb_difference_after: 0 });
  });

  it("opening correction refused (400 naming the month), nothing stored, no preview", async () => {
    m.assertOpeningMonthsOpen.mockRejectedValue(closed());
    const e = await err(svc.createDraft(preparer, CLIENT, openingInput, ctx));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/April 2026/);
    expect(m.assertOpeningMonthsOpen).toHaveBeenCalledWith({ token: TOKEN, companyId: "218" }, CLIENT);
    expect(m.previewOpening).not.toHaveBeenCalled();
    expect(m.insertDraft).not.toHaveBeenCalled();
  });

  it("Suspense adjustment refused the same way", async () => {
    m.assertOpeningMonthsOpen.mockRejectedValue(closed());
    const e = await err(svc.createDraft(preparer, CLIENT, suspenseInput, ctx));
    expect(e.status).toBe(400);
    expect(m.previewSuspense).not.toHaveBeenCalled();
    expect(m.insertDraft).not.toHaveBeenCalled();
  });

  it("allowed once the month is reopened", async () => {
    m.assertOpeningMonthsOpen.mockResolvedValue(undefined);
    await svc.createDraft(preparer, CLIENT, openingInput, ctx);
    expect(m.insertDraft).toHaveBeenCalledTimes(1);
  });

  it("journal entries are unaffected (only their per-date rule in the preview applies)", async () => {
    m.assertOpeningMonthsOpen.mockRejectedValue(closed());
    await svc.createDraft(preparer, CLIENT, journalInput, ctx);
    expect(m.assertOpeningMonthsOpen).not.toHaveBeenCalled();
    expect(m.insertDraft).toHaveBeenCalledTimes(1);
  });
});

describe("list flags rows stuck in posting (Task 8 fix I1)", () => {
  it("stuck: true only for a posting row past the limit", async () => {
    m.listForClient.mockResolvedValue([row({ id: 1, status: "posting", stuck_posting: 1 }), row({ id: 2, status: "posting", stuck_posting: 0 }), row({ id: 3, status: "posted" })]);
    const items = await svc.list(reviewer, CLIENT);
    expect(items.map((i) => i.stuck)).toEqual([true, false, false]);
    expect(items[0]).not.toHaveProperty("stuck_posting");
  });
});
