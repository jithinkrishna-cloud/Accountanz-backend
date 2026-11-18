import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { logger } from "../../utils/logger.js";
import type { RequestContext } from "../audit/journl-read-audit.js";
import { openJournlSession } from "../integrations/journl-data.service.js";
import { assertWritesEnabled, journlWrite, type WriteResult } from "../integrations/journl.gateway.js";
import { notifyCorrectionOutcome } from "../notifications/notification.service.js";
import { canApprove, featureFor, requireApprove, requirePrepare } from "./correction.access.js";
import {
  ALREADY_BALANCED,
  BILL_WISE_BLOCKED,
  closedMonthsForOpening,
  closedMonthsMessage,
  currentOpening,
  hasBillList,
  isBillWise,
  NO_BILL_LIST,
  isPeriodClosed,
  monthLabel,
  suspenseAmount,
  suspenseGroupId,
  type BooksSession,
} from "./correction.preview.js";
import * as repo from "./correction.repository.js";
import { get, ledgerKindOf, load } from "./correction.service.js";
import { transition } from "./correction.state.js";
import { correctionRef, type CorrectionRow, type JournalPayload, type OpeningPayload } from "./correction.types.js";
import { journalLineProblems } from "./correction.validation.js";
import { SESSION_EXPIRED, branches, getLedger, journalVoucherType, ledgerGroups, suspenseCheck, type JournlLedger } from "./journl-books.js";

/**
 * Approve-and-post and post (Task 8): the only code that writes a correction to a client's JournL books.
 *
 * Everything that can refuse runs BEFORE `transition(approved → posting)`, which is the single-send gate: of any number
 * of concurrent callers exactly one moves the row, and only that caller calls `journlWrite`, exactly once (no retry).
 * After the gate every path ends in posted / rejected / unknown (or back to approved when the write threw before
 * anything was sent). The JournL token is never logged, stored or returned.
 */

export const WAITING_FOR_OWNER = "Waiting for the owner to refresh JournL";
/** Refuse to send when the owner session has less than this left. */
export const SESSION_MARGIN_MS = 60_000;
export const STALE_LEDGER = "The ledger changed in JournL after this correction was prepared.";
export const STALE_DIFFERENCE = "The trial balance difference changed in JournL after this correction was prepared.";
export const PREPARER_LOST = "The preparer no longer has Correct access";
export const APPROVER_LOST = "The approver can no longer approve corrections on this client";
export const OTHER_COMPANY = "This client is now connected to a different JournL company";
export const NO_JOURNAL_TYPE = "JournL has no Journal voucher type for this company";
export const UNKNOWN_AFTER_SESSION =
  "JournL said the session had expired after the correction was sent. Check JournL before doing anything else.";

export type PostResult = Awaited<ReturnType<typeof get>> & { message?: string };

/** Integer paise → JournL rupees, 2 decimals (always positive here; JournL negates debits itself). */
export const toRupees = (paise: number): number => Number((Math.abs(paise) / 100).toFixed(2));

/** The JournL user id of the owner session (JWT claim `id`, else `userId`). The token itself is never logged. */
export function journlUserIdOf(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { id?: unknown; userId?: unknown };
    const v = Number(payload.id ?? payload.userId);
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const signed = (o: { amount_paise: number; side: "dr" | "cr" }) => (o.side === "dr" ? -o.amount_paise : o.amount_paise);

interface Plan {
  method: "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
}
type Ready = { kind: "send"; plan: Plan } | { kind: "stale"; message: string } | { kind: "waiting" };

const stale = (message: string): Ready => ({ kind: "stale", message });

/** Reads that found the session expired (journl-books `unwrap`) or no usable session at all: nothing was sent. */
const isSessionProblem = (e: unknown) => e instanceof AppError && e.status === 409 && e.message === SESSION_EXPIRED;

async function withMessage(actor: AuthUser, id: number, message?: string): Promise<PostResult> {
  const c = await get(actor, id);
  return message ? { ...c, message } : c;
}

async function staleReject(actor: AuthUser, row: CorrectionRow, message: string, ctx: RequestContext): Promise<PostResult> {
  await transition(row.id, "approved", "rejected", actor, ctx, { rejected_by_source: "stale", journl_message: message }, message);
  await notifyCorrectionOutcome(row.id);
  return withMessage(actor, row.id, message);
}

/** The preparer must still hold `correct` on the feature through an active assignment (Task 7 review, M2). */
async function preparerStillAllowed(row: CorrectionRow, feature: string): Promise<boolean> {
  const preparer = await repo.findActiveUser(row.initiated_by);
  if (!preparer) return false;
  try {
    await requirePrepare(preparer, row.client_id, feature);
    return true;
  } catch (e) {
    if (e instanceof AppError && e.status === 403) return false;
    throw e;
  }
}

/** Journal entry: per-date closed-month rule, every ledger still live, Journal voucher type, then the create body. */
async function planJournal(row: CorrectionRow, s: BooksSession, userId: number): Promise<Ready> {
  const payload = row.payload as JournalPayload;
  if (journalLineProblems(payload.lines).length) throw AppError.conflict("This correction's journal lines are not valid; prepare it again");
  if (await isPeriodClosed(row.client_id, payload.voucher_date)) {
    throw AppError.conflict(`${monthLabel(payload.voucher_date.slice(0, 7))} is closed in Accountanz. Nothing was sent to JournL. Reopen the month, then post this correction.`);
  }
  for (const id of [...new Set(payload.lines.map((l) => l.ledger_id))]) {
    if (!(await getLedger(s.token, id))) {
      const name = payload.lines.find((l) => l.ledger_id === id)?.ledger_name || `Ledger ${id}`;
      return stale(`${name} no longer exists in JournL. ${STALE_LEDGER}`);
    }
  }
  let vt: Awaited<ReturnType<typeof journalVoucherType>>;
  try {
    vt = await journalVoucherType(s.token);
  } catch (e) {
    if (e instanceof AppError && e.status === 409 && !isSessionProblem(e)) return stale(NO_JOURNAL_TYPE);
    throw e;
  }
  const dr = payload.lines.filter((l) => l.side === "dr");
  const cr = payload.lines.filter((l) => l.side === "cr");
  const line = (isDr: boolean) => (l: (typeof payload.lines)[number]) => ({ ledgerId: l.ledger_id, amount: toRupees(l.amount_paise), isDr });
  return {
    kind: "send",
    plan: {
      method: "POST",
      path: "transaction/create-journal",
      body: {
        voucherType: "Journal",
        voucherTypeId: vt.voucherTypeId,
        primaryVoucherTypeId: vt.primaryVoucherTypeId,
        voucherDate: payload.voucher_date,
        invoiceNo: correctionRef(row.id),
        description: row.reason,
        totalAmount: toRupees(dr.reduce((sum, l) => sum + l.amount_paise, 0)),
        debits: dr.map(line(true)),
        credits: cr.map(line(false)),
        branchId: row.journl_branch_id,
        createdBy: userId,
      },
    },
  };
}

/**
 * Opening balance (correction or Suspense adjustment): closed months block it; the ledger must still read exactly as
 * prepared (opening, side, branch, not bill-wise); a Suspense adjustment's difference must be unchanged. The PUT body
 * is the ledger object just read with only openingBalance / transactionType changed (plus branchId / updatedBy).
 */
async function planOpening(row: CorrectionRow, s: BooksSession, userId: number, ledger: JournlLedger): Promise<Ready> {
  const closed = await closedMonthsForOpening(s, row.client_id);
  if (closed.length) throw AppError.conflict(closedMonthsMessage(closed, true));

  const target = row.payload as OpeningPayload;
  if (isBillWise(ledger)) return stale(BILL_WISE_BLOCKED);
  if (!hasBillList(ledger)) return stale(NO_BILL_LIST); // the PUT must carry the list just read; never guess it
  if (Number(ledger.branchId) !== row.journl_branch_id) return stale(STALE_LEDGER);
  let now: ReturnType<typeof currentOpening>;
  try {
    now = currentOpening(ledger);
  } catch {
    return stale(STALE_LEDGER);
  }
  const before = row.before_values?.[0]?.before_paise;
  if (typeof before !== "number") throw AppError.conflict("This correction has no recorded opening balance to compare; prepare it again");
  if (now.signed !== before) return stale(STALE_LEDGER);
  const newSigned = signed(target);
  if (newSigned === now.signed && (target.amount_paise === 0 || target.side === now.side)) return stale("The ledger in JournL already shows this opening balance.");

  if (row.purpose === "unresolved_tb_difference") {
    const check = suspenseCheck(ledger, await suspenseGroupId(row.client_id), await ledgerGroups(s.token));
    if (!check.ok) return stale(check.reason);
    let offset: { amount_paise: number; side: "dr" | "cr" };
    try {
      offset = await suspenseAmount(s);
    } catch (e) {
      if (e instanceof AppError && e.message === ALREADY_BALANCED) return stale(STALE_DIFFERENCE);
      throw e;
    }
    const diffNow = offset.side === "dr" ? offset.amount_paise : -offset.amount_paise;
    if (diffNow !== before - newSigned) return stale(STALE_DIFFERENCE);
  }

  const bills = ledger.openingBillEntry as unknown[]; // an empty array, checked above
  return {
    kind: "send",
    plan: {
      method: "PUT",
      path: `companyLedgerMaster/${encodeURIComponent(String(target.ledger_id))}`,
      body: {
        ...ledger,
        openingBalance: toRupees(target.amount_paise),
        transactionType: target.side === "dr" ? "receivable" : "payable",
        openingBillEntry: bills, // always the (empty) list just read: omitting it would delete opening bills
        branchId: row.journl_branch_id,
        updatedBy: userId,
      },
    },
  };
}

/** Every check that can refuse, in order. Reads only; nothing is sent from here. */
async function ready(row: CorrectionRow, s: BooksSession): Promise<Ready> {
  const userId = journlUserIdOf(s.token);
  if (!userId) return { kind: "waiting" };

  let ledger: JournlLedger | null = null;
  let feature: string;
  if (row.kind === "journal_entry") feature = featureFor("journal_entry", "general");
  else {
    ledger = await getLedger(s.token, (row.payload as OpeningPayload).ledger_id);
    if (!ledger) return stale(`${(row.payload as OpeningPayload).ledger_name || "The ledger"} no longer exists in JournL. ${STALE_LEDGER}`);
    feature = featureFor("opening_balance", row.purpose === "unresolved_tb_difference" ? "general" : await ledgerKindOf(s.token, ledger));
  }
  if (!(await preparerStillAllowed(row, feature))) return stale(PREPARER_LOST);

  if (!(await branches(s.token)).some((b) => b.id === row.journl_branch_id)) return stale(`Branch ${row.journl_branch_id} no longer exists in JournL`);

  return row.kind === "journal_entry" ? planJournal(row, s, userId) : planOpening(row, s, userId, ledger!);
}

/** The voucher id in an ok create-journal answer (`data` is the bare id); null when absent or not a scalar. */
function voucherIdOf(result: Extract<WriteResult, { kind: "ok" }>): string | null {
  const data = (result.data as { data?: unknown } | null)?.data;
  return data == null || typeof data === "object" ? null : String(data).slice(0, 64);
}

/** What `journlWrite` answered → the correction's final state for this attempt. */
async function settle(actor: AuthUser, id: number, result: WriteResult, ctx: RequestContext): Promise<string | undefined> {
  switch (result.kind) {
    case "ok": {
      const voucherId = voucherIdOf(result);
      await transition(id, "posting", "posted", actor, ctx, voucherId ? { journl_voucher_id: voucherId } : {}, voucherId ? `Posted to JournL (voucher ${voucherId})` : "Posted to JournL");
      return undefined;
    }
    case "rejected":
      await transition(id, "posting", "rejected", actor, ctx, { rejected_by_source: "journl", journl_message: result.message }, `JournL refused it (${result.status})`);
      return result.message.slice(0, 1000);
    case "session":
      // User decision: a session answer AFTER sending is not trusted as "not applied"; a person checks JournL.
      await transition(id, "posting", "unknown", actor, ctx, { journl_message: UNKNOWN_AFTER_SESSION }, UNKNOWN_AFTER_SESSION);
      return UNKNOWN_AFTER_SESSION;
    case "unknown":
      await transition(id, "posting", "unknown", actor, ctx, { journl_message: result.reason }, result.reason);
      return result.reason;
  }
}

/**
 * Sends an approved correction to JournL once. The preparer or anyone who may approve on the client can call it
 * (never ops_admin). Refusals that leave it `approved`: writes disabled (503), no usable owner session (returns
 * "Waiting for the owner to refresh JournL"), a closed month (409). Changes since preparation reject it as `stale`.
 */
export async function post(actor: AuthUser, id: number, ctx: RequestContext, clientId?: number): Promise<PostResult> {
  const row = await load(actor, id, clientId);
  if (actor.role === "ops_admin") throw AppError.forbidden("Admins in operations can't post corrections");
  if (actor.id !== row.initiated_by && !(await canApprove(actor, row.client_id, row.initiated_by))) {
    throw AppError.forbidden("Only the preparer or an approver on this client can post this correction");
  }
  if (row.status !== "approved") throw AppError.conflict(row.status === "posting" ? "This correction is already being posted" : `This correction was already ${row.status}`);

  assertWritesEnabled(); // before any re-check: in an environment without writes nothing changes state

  const approver = await repo.findActiveUser(row.approved_by);
  if (!approver || !(await canApprove(approver, row.client_id, row.initiated_by))) return staleReject(actor, row, APPROVER_LOST, ctx);

  let s: BooksSession;
  try {
    const o = await openJournlSession(row.connection_id);
    // A session about to expire could expire mid-request (a 401 after sending would leave the outcome unknown).
    if (!o.expiresAt || new Date(o.expiresAt).getTime() - Date.now() < SESSION_MARGIN_MS) return withMessage(actor, id, WAITING_FOR_OWNER);
    s = { token: o.token, companyId: o.companyId };
  } catch (e) {
    if (e instanceof AppError && (e.status === 409 || e.status === 404)) return withMessage(actor, id, WAITING_FOR_OWNER);
    throw e;
  }
  if (String(s.companyId) !== String(row.journl_company_id)) return staleReject(actor, row, OTHER_COMPANY, ctx);

  let r: Ready;
  try {
    r = await ready(row, s);
  } catch (e) {
    if (isSessionProblem(e)) return withMessage(actor, id, WAITING_FOR_OWNER);
    throw e;
  }
  if (r.kind === "waiting") return withMessage(actor, id, WAITING_FOR_OWNER);
  if (r.kind === "stale") return staleReject(actor, row, r.message, ctx);

  // The single-send gate: only the caller that moves approved → posting sends.
  await transition(id, "approved", "posting", actor, ctx, {}, "Sending to JournL");

  let result: WriteResult;
  try {
    result = await journlWrite(s.token, r.plan.method, r.plan.path, r.plan.body);
  } catch (e) {
    // journlWrite throws only before its request goes out (writes disabled, bad path), so nothing was sent.
    logger.warn({ correction: correctionRef(id), err: (e as Error).message }, "JournL correction write not sent");
    await transition(id, "posting", "approved", actor, ctx, {}, "Not sent to JournL");
    throw e;
  }

  let message: string | undefined;
  try {
    message = await settle(actor, id, result, ctx);
  } catch (e) {
    // JournL answered but Accountanz couldn't record it: the row stays `posting` (never resent). Log enough to tie the
    // gateway's line to this correction; checkJournl / resolveManually recover it after STUCK_POSTING_SECONDS.
    logger.error(
      { correction: correctionRef(id), outcome: result.kind, voucherId: result.kind === "ok" ? voucherIdOf(result) : undefined, err: (e as Error).message },
      "JournL correction outcome could not be recorded",
    );
    throw e;
  }
  await notifyCorrectionOutcome(id);
  return withMessage(actor, id, message);
}

/** An approver (never the preparer, never ops_admin) approves and posts in one step. Concurrent approvers: one wins, the rest get 409. */
export async function approveAndPost(actor: AuthUser, id: number, comment: string | undefined, ctx: RequestContext, clientId?: number): Promise<PostResult> {
  const row = await load(actor, id, clientId);
  await requireApprove(actor, row.client_id, row.initiated_by);
  if (row.status !== "pending_approval") throw AppError.conflict(`This correction was already ${row.status}`);
  const c = comment?.trim() ? comment.trim().slice(0, 1000) : undefined;
  await transition(id, "pending_approval", "approved", actor, ctx, { approved_by: actor.id, approved_at: utcNow(), ...(c ? { review_comment: c } : {}) }, c);
  return post(actor, id, ctx, clientId);
}
