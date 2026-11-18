import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { requireClientAccess } from "../access/client-access.js";
import { recordAudit } from "../audit/audit.service.js";
import type { RequestContext } from "../audit/journl-read-audit.js";
import { openJournlSession } from "../integrations/journl-data.service.js";
import { notifyCorrectionDecided, notifyCorrectionSubmitted } from "../notifications/notification.service.js";
import { canApprove, featureFor, requireApprove, requirePrepare } from "./correction.access.js";
import * as repo from "./correction.repository.js";
import { assertOpeningMonthsOpen, previewJournal, previewOpening, previewSuspense, type BooksSession } from "./correction.preview.js";
import { transition } from "./correction.state.js";
import { correctionRef, type BalanceRow, type CorrectionRow, type JournalPayload, type OpeningPayload } from "./correction.types.js";
import { branches, findVoucherByRef, getLedger, ledgerGroups, openingEntryBranch, searchLedgers, toPaise, type JournlLedger } from "./journl-books.js";

/**
 * Prepare → submit → review for JournL corrections (Task 7); check/resolve/prepare-again (Task 9). Approve and post
 * (the JournL writes) live in correction.posting.ts (Task 8).
 * Every function scopes to the correction's client first (404 when the actor can't see it), never returns the JournL
 * token or a JournL body, and moves status only through `transition` (conditional UPDATE + event + audit).
 */

export const NOT_CONNECTED = "This client hasn't connected JournL yet";
export const NO_SESSION_OWNER = "Accountanz doesn't know who signed in to JournL for this client. Ask the owner to sign in with JournL again.";
export const SUSPENSE_REASON_PREFIX = "Temporary adjustment: unresolved trial balance difference";
export const BAD_BRANCH = "Choose one of this client's JournL branches";

/** What the preparer sends. Suspense: only the ledger; its amount and side are computed from the books. */
export type CorrectionInput =
  | { kind: "journal_entry"; purpose: "correction"; reason: string; branch_id: number; journal: JournalPayload }
  | { kind: "opening_balance"; purpose: "correction"; reason: string; opening: OpeningPayload }
  | { kind: "opening_balance"; purpose: "unresolved_tb_difference"; reason: string; ledger_id: number };

/** Seeded JournL primary groups: Sundry Debtors 26, Sundry Creditors 22. */
const SUNDRY_DEBTORS_GROUP = 26;
const SUNDRY_CREDITORS_GROUP = 22;

/**
 * Which permission module an opening-balance correction needs, from the ledger's accounting group:
 *  - Sundry Debtors (group 26, or primary group 26, or a group named like "Sundry Debtors") → customer (f_customers)
 *  - Sundry Creditors (group 22, or primary group 22, or a group named like "Sundry Creditors") → supplier (f_suppliers)
 *  - anything else → general (f_general_ledgers)
 * The name check covers user-made groups (e.g. a "Sundry Creditors" group 29 under primary group 3).
 */
export async function ledgerKindOf(token: string, ledger: JournlLedger): Promise<"general" | "customer" | "supplier"> {
  const ids = [Number(ledger.groupId), Number(ledger.primaryGroupId)];
  if (ids.includes(SUNDRY_DEBTORS_GROUP)) return "customer";
  if (ids.includes(SUNDRY_CREDITORS_GROUP)) return "supplier";
  let name = ledger.groupName ?? null;
  if (!name && ledger.groupId != null) name = (await ledgerGroups(token)).find((g) => Number(g.id) === Number(ledger.groupId))?.name ?? null;
  if (name && /sundry\s+debtors/i.test(name)) return "customer";
  if (name && /sundry\s+creditors/i.test(name)) return "supplier";
  return "general";
}

const suspenseReason = (reason: string) => {
  const r = reason.trim();
  return r.startsWith(SUSPENSE_REASON_PREFIX) ? r : `${SUSPENSE_REASON_PREFIX}. ${r}`;
};

const signed = (o: { amount_paise: number; side: "dr" | "cr" }) => (o.side === "dr" ? -o.amount_paise : o.amount_paise);

/** Opening previews as balance rows (signed: Dr negative, Cr positive), in the journal preview's before/after shape. */
function openingRows(before: OpeningPayload, after: OpeningPayload): { before: BalanceRow[]; after: BalanceRow[] } {
  const b = signed(before);
  const row = { ledger_id: after.ledger_id, ledger_name: after.ledger_name };
  return { before: [{ ...row, before_paise: b, after_paise: b }], after: [{ ...row, before_paise: b, after_paise: signed(after) }] };
}

interface Connection {
  id: number;
  companyId: string;
  sessionOwner: number;
}

async function connectionOf(clientId: number): Promise<Connection> {
  const c = await repo.journlConnectionFor(clientId);
  if (!c || c.status !== "connected" || !c.external_org_id) throw AppError.conflict(NOT_CONNECTED);
  if (!c.authorized_by) throw AppError.conflict(NO_SESSION_OWNER);
  return { id: c.id, companyId: c.external_org_id, sessionOwner: c.authorized_by };
}

async function session(conn: Connection): Promise<BooksSession> {
  const s = await openJournlSession(conn.id);
  return { token: s.token, companyId: s.companyId };
}

interface Prepared {
  payload: JournalPayload | OpeningPayload;
  before: BalanceRow[];
  after: BalanceRow[];
  branchId: number;
  reason: string;
  tb_difference_before: number;
  tb_difference_after: number;
}

/** Checks Correct access and previews against the live books. Shared by create, update and the dry run. */
async function prepare(actor: AuthUser, clientId: number, input: CorrectionInput, s: BooksSession): Promise<Prepared> {
  if (input.kind === "journal_entry") {
    await requirePrepare(actor, clientId, featureFor("journal_entry", "general"));
    const live = await branches(s.token);
    if (!live.some((b) => b.id === input.branch_id)) throw new AppError("VALIDATION_ERROR", BAD_BRANCH);
    const p = await previewJournal(s, clientId, input.journal);
    return { payload: p.payload, before: p.before, after: p.after, branchId: input.branch_id, reason: input.reason.trim(), tb_difference_before: p.tb_difference_before, tb_difference_after: p.tb_difference_after };
  }
  if (input.purpose === "unresolved_tb_difference") {
    await requirePrepare(actor, clientId, featureFor("opening_balance", "general"));
    await assertOpeningMonthsOpen(s, clientId); // closed months block opening corrections (journal entries keep the per-date rule)
    const p = await previewSuspense(s, clientId, input.ledger_id); // amount/side computed here, never from the request
    const branchId = await openingEntryBranch(s.token, input.ledger_id);
    return { payload: p.after, ...openingRows(p.before, p.after), branchId, reason: suspenseReason(input.reason), tb_difference_before: p.tb_difference_before, tb_difference_after: p.tb_difference_after };
  }
  const ledger = await getLedger(s.token, input.opening.ledger_id);
  if (!ledger) throw new AppError("VALIDATION_ERROR", `Ledger ${input.opening.ledger_id} isn't in this client's JournL books`);
  await requirePrepare(actor, clientId, featureFor("opening_balance", await ledgerKindOf(s.token, ledger)));
  await assertOpeningMonthsOpen(s, clientId);
  const p = await previewOpening(s, input.opening); // bill-wise ledgers are refused here (400)
  const branchId = await openingEntryBranch(s.token, input.opening.ledger_id);
  return { payload: p.after, ...openingRows(p.before, p.after), branchId, reason: input.reason.trim(), tb_difference_before: p.tb_difference_before, tb_difference_after: p.tb_difference_after };
}

/** Admins never prepare: refuse before any JournL read. */
function refuseAdmin(actor: AuthUser) {
  if (actor.role === "super_admin" || actor.role === "ops_admin") throw AppError.forbidden("Admins review corrections; a team member on the client prepares them");
}

/** The correction, scoped: 404 when it doesn't exist, belongs to another client, or the actor can't see its client. */
export async function load(actor: AuthUser, id: number, clientId?: number): Promise<CorrectionRow> {
  const row = await repo.findCorrection(id);
  if (!row || (clientId !== undefined && row.client_id !== clientId)) throw AppError.notFound("Correction");
  await requireClientAccess(actor, row.client_id, "Correction");
  return row;
}

/** A row left in `posting` past STUCK_POSTING_SECONDS: JournL may or may not have it; offer Check JournL. */
export const isStuck = (row: CorrectionRow) => row.status === "posting" && Boolean(Number(row.stuck_posting ?? 0));

const withRef = ({ stuck_posting: _s, ...row }: CorrectionRow) => ({ ...row, ref: correctionRef(row.id), stuck: isStuck({ ...row, stuck_posting: _s }) });

export const STUCK_NOTE = "Stuck in posting; moved to unknown for checking";
export const POSTING_IN_PROGRESS = "Posting is in progress";

/**
 * Before checking / resolving: a stuck `posting` row becomes `unknown` (nothing is resent); a recent one is still
 * in flight → 409. Other rows are returned unchanged.
 */
async function releaseStuck(actor: AuthUser, row: CorrectionRow, ctx: RequestContext): Promise<CorrectionRow> {
  if (row.status !== "posting") return row;
  if (!isStuck(row)) throw AppError.conflict(POSTING_IN_PROGRESS);
  return transition(row.id, "posting", "unknown", actor, ctx, {}, STUCK_NOTE);
}

/** Dry run: the same checks and preview as a draft, nothing stored. */
export async function preview(actor: AuthUser, clientId: number, input: CorrectionInput) {
  await requireClientAccess(actor, clientId);
  refuseAdmin(actor);
  const conn = await connectionOf(clientId);
  const p = await prepare(actor, clientId, input, await session(conn));
  return { kind: input.kind, purpose: input.purpose, journl_branch_id: p.branchId, payload: p.payload, before_values: p.before, after_values: p.after, reason: p.reason, tb_difference_before: p.tb_difference_before, tb_difference_after: p.tb_difference_after };
}

export async function createDraft(actor: AuthUser, clientId: number, input: CorrectionInput, ctx: RequestContext) {
  return createDraftFrom(actor, clientId, input, ctx, null);
}

/** The one path that stores a new draft (create, and prepare-again via `copiedFrom`). */
async function createDraftFrom(actor: AuthUser, clientId: number, input: CorrectionInput, ctx: RequestContext, copiedFrom: number | null) {
  await requireClientAccess(actor, clientId);
  refuseAdmin(actor);
  const conn = await connectionOf(clientId);
  const p = await prepare(actor, clientId, input, await session(conn));
  const id = await withTransaction(async (db) => {
    const newId = await repo.insertDraft(
      {
        clientId,
        connectionId: conn.id,
        journlCompanyId: conn.companyId,
        journlBranchId: p.branchId,
        kind: input.kind,
        purpose: input.purpose,
        payload: p.payload,
        before: p.before,
        after: p.after,
        reason: p.reason,
        initiatedBy: actor.id,
        copiedFrom,
      },
      db,
    );
    await repo.setDraftJournlContext(newId, p.branchId, conn.sessionOwner, db);
    await recordAudit(
      actor,
      { action: "JournL correction draft", entityType: "JournlCorrection", entityId: correctionRef(newId), clientId, details: `${input.kind} (${input.purpose}) prepared${copiedFrom ? ` again from ${correctionRef(copiedFrom)}` : ""}`, outcome: "success", endpoint: ctx.endpoint ?? null, requestId: ctx.requestId ?? null, ipAddress: ctx.ipAddress ?? null },
      db,
    );
    return newId;
  });
  return get(actor, id);
}

/** Initiator only, drafts only. Kind and purpose can't change; the books are previewed again. */
export async function updateDraft(actor: AuthUser, id: number, input: CorrectionInput, ctx: RequestContext, clientId?: number) {
  const row = await load(actor, id, clientId);
  if (row.initiated_by !== actor.id) throw AppError.forbidden("Only the person who prepared this correction can edit it");
  if (row.status !== "draft") throw AppError.conflict(`This correction is ${row.status}; only drafts can be edited`);
  if (row.kind !== input.kind || row.purpose !== input.purpose) throw new AppError("VALIDATION_ERROR", "A correction's type can't change; prepare a new one");
  const conn = await connectionOf(row.client_id);
  const p = await prepare(actor, row.client_id, input, await session(conn));
  await withTransaction(async (db) => {
    const ok = await repo.updateDraft(id, p.payload, p.before, p.after, p.reason, db);
    if (!ok || !(await repo.setDraftJournlContext(id, p.branchId, conn.sessionOwner, db))) throw AppError.conflict("This correction is no longer a draft");
    await recordAudit(
      actor,
      { action: "JournL correction edited", entityType: "JournlCorrection", entityId: correctionRef(id), clientId: row.client_id, details: "draft edited", outcome: "success", endpoint: ctx.endpoint ?? null, requestId: ctx.requestId ?? null, ipAddress: ctx.ipAddress ?? null },
      db,
    );
  });
  return get(actor, id);
}

/** Initiator sends the draft for approval; eligible approvers are told. */
export async function submit(actor: AuthUser, id: number, ctx: RequestContext, clientId?: number) {
  const row = await load(actor, id, clientId);
  if (row.initiated_by !== actor.id) throw AppError.forbidden("Only the person who prepared this correction can submit it");
  if (row.status !== "draft") throw AppError.conflict(`This correction was already ${row.status}`);
  await transition(id, "draft", "pending_approval", actor, ctx);
  await notifyCorrectionSubmitted(id);
  return get(actor, id);
}

const requireComment = (comment: string | undefined | null) => {
  const c = (comment ?? "").trim();
  if (!c) throw new AppError("VALIDATION_ERROR", "A comment is required", { fieldErrors: { comment: ["A comment is required"] } });
  return c.slice(0, 1000);
};

/** An approver returns it to the preparer as a draft (comment required). */
export async function sendBack(actor: AuthUser, id: number, comment: string, ctx: RequestContext, clientId?: number) {
  const c = requireComment(comment);
  const row = await load(actor, id, clientId);
  await requireApprove(actor, row.client_id, row.initiated_by);
  if (row.status !== "pending_approval") throw AppError.conflict(`This correction was already ${row.status}`);
  await transition(id, "pending_approval", "draft", actor, ctx, { review_comment: c }, c);
  await notifyCorrectionDecided(id);
  return get(actor, id);
}

/** An approver rejects it for good (comment required); the preparer is told. */
export async function reject(actor: AuthUser, id: number, comment: string, ctx: RequestContext, clientId?: number) {
  const c = requireComment(comment);
  const row = await load(actor, id, clientId);
  await requireApprove(actor, row.client_id, row.initiated_by);
  if (row.status !== "pending_approval") throw AppError.conflict(`This correction was already ${row.status}`);
  await transition(id, "pending_approval", "rejected", actor, ctx, { review_comment: c, rejected_by_source: "reviewer" }, c);
  await notifyCorrectionDecided(id);
  return get(actor, id);
}

export async function list(actor: AuthUser, clientId: number) {
  await requireClientAccess(actor, clientId);
  return (await repo.listForClient(clientId)).map(withRef);
}

/** Form lookups (read-only): ledgers matching `q` and the company's branches, for people who prepare corrections. */
export async function lookupLedgers(actor: AuthUser, clientId: number, q: string) {
  refuseAdmin(actor);
  await requireClientAccess(actor, clientId);
  const s = await session(await connectionOf(clientId));
  return q.trim().length < 2 ? [] : searchLedgers(s.token, q.trim());
}

export async function lookupBranches(actor: AuthUser, clientId: number) {
  refuseAdmin(actor);
  await requireClientAccess(actor, clientId);
  const s = await session(await connectionOf(clientId));
  return branches(s.token);
}

/** One correction with its history, and what the actor may do with it. */
export async function get(actor: AuthUser, id: number, clientId?: number) {
  const row = await load(actor, id, clientId);
  const [events, approvable] = await Promise.all([repo.events(id), row.status === "pending_approval" ? canApprove(actor, row.client_id, row.initiated_by) : Promise.resolve(false)]);
  return {
    ...withRef(row),
    events,
    can_edit: row.status === "draft" && row.initiated_by === actor.id,
    can_submit: row.status === "draft" && row.initiated_by === actor.id,
    can_review: approvable,
  };
}

/** The reviewer queue: corrections waiting on this actor (never their own). */
export async function awaitingMyApproval(actor: AuthUser) {
  const items = (await repo.listAwaitingApproval(actor)).map(withRef);
  return { count: items.length, items };
}


// ───────────── Task 9: read-only ways to settle an `unknown` outcome, and "Prepare again" ─────────────
// None of these sends anything to JournL: they only GET (voucher search / ledger read) or change Accountanz's own record.

/** A ledger's opening as a signed paise value (Dr negative, Cr positive), as the preview rows store it. */
function signedOpeningOf(ledger: JournlLedger): number {
  const amount = Math.abs(toPaise(ledger.openingBalance));
  const t = String(ledger.transactionType ?? "").toLowerCase();
  if (t === "receivable") return -amount;
  if (t === "payable") return amount;
  if (amount !== 0) throw new AppError("UNAVAILABLE", "JournL returned an unrecognised opening balance side");
  return 0;
}

export type CheckResult =
  | { found: true; correction: Awaited<ReturnType<typeof get>> }
  | { found: true; anomaly: "multiple"; ids: string[] }
  | { found: false; matches_before?: boolean };

/**
 * Looks in JournL (reads only) for what a correction with an unknown outcome did. Same people as approvers
 * (never the preparer). Journal: exactly one voucher carrying ACZ-<id> -> posted with that id; none -> stays unknown;
 * several -> stays unknown for a human (never picks one). Opening: the ledger now equals the intended value -> posted;
 * otherwise stays unknown and says whether it still shows the old value.
 */
export async function checkJournl(actor: AuthUser, id: number, ctx: RequestContext, clientId?: number): Promise<CheckResult> {
  const loaded = await load(actor, id, clientId);
  await requireApprove(actor, loaded.client_id, loaded.initiated_by);
  const row = await releaseStuck(actor, loaded, ctx);
  if (row.status !== "unknown") throw AppError.conflict(`This correction is ${row.status}; only one with an unknown outcome can be checked`);
  const s = await session(await connectionOf(row.client_id));
  if (row.kind === "journal_entry") {
    const hits = await findVoucherByRef(s.token, correctionRef(id));
    if (hits.length === 0) return { found: false };
    if (hits.length > 1) return { found: true, anomaly: "multiple", ids: hits.map((h) => h.id) };
    await transition(id, "unknown", "posted", actor, ctx, { journl_voucher_id: hits[0].id }, "Found in JournL by its reference");
    return { found: true, correction: await get(actor, id) };
  }
  const payload = row.payload as OpeningPayload;
  const ledger = await getLedger(s.token, payload.ledger_id);
  if (!ledger) return { found: false, matches_before: false };
  const now = signedOpeningOf(ledger);
  const after = row.after_values?.[0]?.after_paise;
  const before = row.before_values?.[0]?.after_paise;
  if (after !== undefined && now === after) {
    await transition(id, "unknown", "posted", actor, ctx, {}, "Ledger in JournL already shows the corrected opening balance");
    return { found: true, correction: await get(actor, id) };
  }
  return { found: false, matches_before: before !== undefined && now === before };
}

/** A person who checked JournL themselves settles an unknown outcome. Note required; nothing is sent to JournL. */
export async function resolveManually(actor: AuthUser, id: number, to: "posted" | "rejected", note: string, voucherId: string | undefined, ctx: RequestContext, clientId?: number) {
  const n = (note ?? "").trim();
  if (!n) throw new AppError("VALIDATION_ERROR", "A note is required", { fieldErrors: { note: ["A note is required"] } });
  if (to !== "posted" && to !== "rejected") throw new AppError("VALIDATION_ERROR", "Choose posted or rejected");
  const loaded = await load(actor, id, clientId);
  await requireApprove(actor, loaded.client_id, loaded.initiated_by);
  const row = await releaseStuck(actor, loaded, ctx);
  if (row.status !== "unknown") throw AppError.conflict(`This correction is ${row.status}; only one with an unknown outcome can be resolved`);
  const text = n.slice(0, 1000);
  if (to === "posted") {
    const v = voucherId?.trim();
    await transition(id, "unknown", "posted", actor, ctx, v ? { journl_voucher_id: v.slice(0, 64) } : {}, `Resolved by hand: ${text}`);
  } else {
    // 'journl' = JournL did not take it (the person checked JournL); the note is the explanation kept as JournL's message.
    await transition(id, "unknown", "rejected", actor, ctx, { rejected_by_source: "journl", journl_message: text }, `Resolved by hand: ${text}`);
  }
  return get(actor, id);
}

/** A correction cancelled because the ledger changed becomes a fresh draft, re-read from the current JournL books. */
export async function prepareAgain(actor: AuthUser, id: number, ctx: RequestContext, clientId?: number) {
  const row = await load(actor, id, clientId);
  refuseAdmin(actor);
  if (row.status !== "rejected" || row.rejected_by_source !== "stale") throw AppError.conflict("Only a correction cancelled because the ledger changed can be prepared again");
  let input: CorrectionInput;
  if (row.kind === "journal_entry") {
    input = { kind: "journal_entry", purpose: "correction", reason: row.reason, branch_id: row.journl_branch_id, journal: row.payload as JournalPayload };
  } else if (row.purpose === "unresolved_tb_difference") {
    input = { kind: "opening_balance", purpose: "unresolved_tb_difference", reason: row.reason, ledger_id: (row.payload as OpeningPayload).ledger_id };
  } else {
    input = { kind: "opening_balance", purpose: "correction", reason: row.reason, opening: row.payload as OpeningPayload };
  }
  return createDraftFrom(actor, row.client_id, input, ctx, id);
}
