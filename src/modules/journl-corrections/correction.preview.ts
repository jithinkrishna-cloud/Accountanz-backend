import { query, queryOne } from "../../database/connection.js";
import { AppError } from "../../utils/app-error.js";
import type { BalanceRow, JournalPayload, OpeningPayload } from "./correction.types.js";
import { journalLineProblems } from "./correction.validation.js";
import {
  DEFAULT_SUSPENSE_GROUP_ID,
  booksStart,
  getLedger,
  ledgerClosingOf,
  ledgerGroups,
  suspenseCheck,
  tbDifferenceOf,
  toPaise,
  trialBalance,
  type JournlLedger,
} from "./journl-books.js";

/**
 * Previews of a correction against the live JournL books: validation that needs JournL or the Accountanz DB, and the
 * before/after values the preparer and reviewer see. Read-only: GETs to JournL and SELECTs only. Money is paise.
 */

/** What the previews need from `openJournlSession`: the owner token and the JournL company id (for the books start). */
export interface BooksSession {
  token: string;
  companyId: string;
}

export const BILL_WISE_BLOCKED = "This ledger tracks opening balances bill by bill; correct it in JournL.";
export const PERIOD_CLOSED = "That month is closed in Accountanz";
export const ALREADY_BALANCED = "The trial balance already balances";

export const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const bad = (message: string) => new AppError("VALIDATION_ERROR", message);
const unknownLedger = (id: number) => bad(`Ledger ${id} isn't in this client's JournL books`);

async function requireLedger(token: string, id: number): Promise<JournlLedger> {
  const ledger = await getLedger(token, id);
  if (!ledger) throw unknownLedger(id);
  return ledger;
}

export const NO_BILL_LIST = "JournL didn't return the ledger's opening bills; correct it in JournL";

/** Bill-wise, or carrying opening bills. */
export const isBillWise = (ledger: JournlLedger) =>
  Number(ledger.enableBillWise) === 1 || (Array.isArray(ledger.openingBillEntry) && ledger.openingBillEntry.length > 0);

/**
 * JournL's PUT deletes every opening bill not in the list it is sent, so an opening write is only safe when the GET
 * returned the list itself (an array). A missing or malformed list blocks the correction.
 */
export const hasBillList = (ledger: JournlLedger) => Array.isArray(ledger.openingBillEntry);

/** Bill-wise ledgers, ledgers carrying opening bills, or ones whose bill list JournL didn't return, are blocked (user decision b). */
function assertNotBillWise(ledger: JournlLedger) {
  if (isBillWise(ledger)) throw bad(BILL_WISE_BLOCKED);
  if (!hasBillList(ledger)) throw bad(NO_BILL_LIST);
}

/** The ledger's current opening as `{ amount, side }` in paise; signed = Dr negative, Cr positive. */
export function currentOpening(ledger: JournlLedger): { amount_paise: number; side: "dr" | "cr"; signed: number } {
  const amount = Math.abs(toPaise(ledger.openingBalance));
  const t = String(ledger.transactionType ?? "").toLowerCase();
  if (t !== "receivable" && t !== "payable") {
    if (amount !== 0) throw AppError.conflict("JournL returned an opening balance side Accountanz doesn't recognise for this ledger");
    return { amount_paise: 0, side: "cr", signed: 0 };
  }
  const side = t === "receivable" ? "dr" : "cr";
  return { amount_paise: amount, side, signed: side === "dr" ? -amount : amount };
}

const signedOf = (o: { amount_paise: number; side: "dr" | "cr" }) => (o.side === "dr" ? -o.amount_paise : o.amount_paise);

/** The journal per-date rule: is the voucher date's month closed in Accountanz for the client? */
export async function isPeriodClosed(clientId: number, date: string): Promise<boolean> {
  const row = await queryOne<{ status: string }>(`SELECT status FROM period_closings WHERE client_id = ? AND period = ?`, [clientId, date.slice(0, 7)]);
  return row?.status === "closed";
}

/** Rejects a voucher date in a month Accountanz has closed for the client. */
async function assertPeriodOpen(clientId: number, date: string) {
  if (await isPeriodClosed(clientId, date)) throw bad(PERIOD_CLOSED);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-04" -> "April 2026". */
export const monthLabel = (period: string) => {
  const [y, mo] = period.split("-");
  return `${MONTHS[Number(mo) - 1] ?? mo} ${y}`;
};

/** Months (YYYY-MM) closed in Accountanz for the client from `fromMonth` through `toMonth`, oldest first. */
export async function closedMonthsBetween(clientId: number, fromMonth: string, toMonth: string): Promise<string[]> {
  const rows = await query<{ period: string }>(
    "SELECT period FROM period_closings WHERE client_id = ? AND status = 'closed' AND period >= ? AND period <= ? ORDER BY period",
    [clientId, fromMonth, toMonth],
  );
  return rows.map((r) => String(r.period));
}

/** The closed-month wording for opening-balance corrections. `atPost` adds the way forward for an approved one. */
export function closedMonthsMessage(periods: string[], atPost: boolean): string {
  const list = periods.map(monthLabel).join(", ");
  const it = periods.length > 1 ? "those months" : "that month";
  const head = `Opening balances can't be changed while a month is closed in Accountanz (closed: ${list}).`;
  return atPost
    ? `${head} Nothing was sent to JournL. Reopen ${it} in Accountanz, then post this correction; or reject it and prepare a new correction.`
    : `${head} Reopen ${it} first.`;
}

/**
 * Opening-balance corrections (including the Suspense adjustment) change the books from their start, so they are
 * refused while any month from the books start through the current month (India time) is closed for the client.
 * Returns the closed months, oldest first (empty = allowed). Journal entries never use this; they keep the per-date rule.
 */
export async function closedMonthsForOpening(session: BooksSession, clientId: number): Promise<string[]> {
  const start = await booksStart(session.token, session.companyId);
  return closedMonthsBetween(clientId, start.slice(0, 7), todayIst().slice(0, 7));
}

/** Refuses (400) an opening-balance correction at preparation while any month since the books start is closed. */
export async function assertOpeningMonthsOpen(session: BooksSession, clientId: number): Promise<void> {
  const closed = await closedMonthsForOpening(session, clientId);
  if (closed.length) throw bad(closedMonthsMessage(closed, false));
}

export interface JournalPreview {
  payload: JournalPayload;
  before: BalanceRow[];
  after: BalanceRow[];
  tb_difference_before: number;
  tb_difference_after: number;
}

/**
 * Validates a journal against JournL and Accountanz and shows each ledger's closing balance as of the voucher date,
 * before and after. A balanced journal never changes the trial-balance difference.
 */
export async function previewJournal(session: BooksSession, clientId: number, payload: JournalPayload): Promise<JournalPreview> {
  const problems = journalLineProblems(payload.lines);
  if (problems.length) throw bad(problems[0]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.voucher_date)) throw bad("Use a valid date");

  const start = await booksStart(session.token, session.companyId);
  if (payload.voucher_date < start) throw bad(`The date is before the start of this client's books in JournL (${start})`);
  await assertPeriodOpen(clientId, payload.voucher_date);

  const ids = [...new Set(payload.lines.map((l) => l.ledger_id))];
  const ledgers = new Map<number, JournlLedger>();
  for (const id of ids) ledgers.set(id, await requireLedger(session.token, id));

  const tb = await trialBalance(session.token, payload.voucher_date, start);
  const diff = tbDifferenceOf(tb);

  const effect = new Map<number, number>();
  for (const l of payload.lines) effect.set(l.ledger_id, (effect.get(l.ledger_id) ?? 0) + (l.side === "dr" ? -l.amount_paise : l.amount_paise));

  const rows: BalanceRow[] = ids.map((id) => {
    const name = String(ledgers.get(id)!.name ?? "");
    const before = ledgerClosingOf(tb, id, name);
    return { ledger_id: id, ledger_name: name, before_paise: before, after_paise: before + effect.get(id)! };
  });

  return {
    payload: { voucher_date: payload.voucher_date, lines: payload.lines.map((l) => ({ ...l, ledger_name: String(ledgers.get(l.ledger_id)!.name ?? "") })) },
    before: rows.map((r) => ({ ...r, after_paise: r.before_paise })),
    after: rows,
    tb_difference_before: diff,
    tb_difference_after: diff,
  };
}

export interface OpeningPreview {
  before: OpeningPayload;
  after: OpeningPayload;
  tb_difference_before: number;
  tb_difference_after: number;
}

/** Validates an opening-balance change and projects the trial-balance difference: after = before − (old − new). */
export async function previewOpening(session: BooksSession, payload: OpeningPayload): Promise<OpeningPreview> {
  if (!Number.isSafeInteger(payload.amount_paise) || payload.amount_paise < 0) throw bad("The opening balance can't be negative");
  if (payload.side !== "dr" && payload.side !== "cr") throw bad("Choose Dr or Cr");
  const ledger = await requireLedger(session.token, payload.ledger_id);
  assertNotBillWise(ledger);

  const old = currentOpening(ledger);
  const newSigned = signedOf(payload);
  if (newSigned === old.signed && (payload.amount_paise === 0 || payload.side === old.side)) {
    throw bad("The new opening balance is the same as the current one");
  }

  const start = await booksStart(session.token, session.companyId);
  const diff = tbDifferenceOf(await trialBalance(session.token, todayIst(), start));
  const name = String(ledger.name ?? "");
  return {
    before: { ledger_id: payload.ledger_id, ledger_name: name, amount_paise: old.amount_paise, side: old.side },
    after: { ledger_id: payload.ledger_id, ledger_name: name, amount_paise: payload.amount_paise, side: payload.side },
    tb_difference_before: diff,
    tb_difference_after: diff - (old.signed - newSigned),
  };
}

/** The adjustment that offsets the current trial-balance difference (credits exceed → Dr). 409 when it already balances. */
export async function suspenseAmount(session: BooksSession): Promise<{ amount_paise: number; side: "dr" | "cr" }> {
  const start = await booksStart(session.token, session.companyId);
  const diff = tbDifferenceOf(await trialBalance(session.token, todayIst(), start));
  if (diff === 0) throw AppError.conflict(ALREADY_BALANCED);
  return { amount_paise: Math.abs(diff), side: diff > 0 ? "dr" : "cr" };
}

/** The client's Suspense group id: the per-client override, else the seeded JournL group 9. */
export async function suspenseGroupId(clientId: number): Promise<number> {
  const row = await queryOne<{ journl_corrections_suspense_group_id: number | null }>(
    `SELECT journl_corrections_suspense_group_id FROM integration_connections WHERE client_id = ? AND provider = 'journl'`,
    [clientId],
  );
  return row?.journl_corrections_suspense_group_id ?? DEFAULT_SUSPENSE_GROUP_ID;
}

export interface SuspensePreview extends OpeningPreview {
  ledger: { id: number; name: string; group_id: number; group_name: string | null };
  amount_paise: number;
  side: "dr" | "cr";
}

/**
 * Unresolved-difference adjustment on an existing Suspense ledger: its opening moves by the amount that offsets the
 * current difference (new signed opening = old − difference), so the projected difference is 0.
 */
export async function previewSuspense(session: BooksSession, clientId: number, ledgerId: number): Promise<SuspensePreview> {
  const groupId = await suspenseGroupId(clientId);
  const ledger = await getLedger(session.token, ledgerId);
  if (!ledger) throw bad("Choose a ledger in a Suspense group. Create one in JournL first if there is none.");
  const groups = await ledgerGroups(session.token);
  const check = suspenseCheck(ledger, groupId, groups);
  if (!check.ok) throw bad(check.reason);
  assertNotBillWise(ledger);

  const offset = await suspenseAmount(session);
  const old = currentOpening(ledger);
  const diff = offset.side === "dr" ? offset.amount_paise : -offset.amount_paise;
  const newSigned = old.signed - diff;
  const name = String(ledger.name ?? "");
  const group = groups.find((g) => Number(g.id) === groupId);
  return {
    ledger: { id: ledgerId, name, group_id: groupId, group_name: group?.name ?? null },
    amount_paise: offset.amount_paise,
    side: offset.side,
    before: { ledger_id: ledgerId, ledger_name: name, amount_paise: old.amount_paise, side: old.side },
    after: { ledger_id: ledgerId, ledger_name: name, amount_paise: Math.abs(newSigned), side: newSigned === 0 ? old.side : newSigned < 0 ? "dr" : "cr" },
    tb_difference_before: diff,
    tb_difference_after: diff - (old.signed - newSigned),
  };
}
