import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { activeAssignmentSql, REVIEWER_TEAM_ROLES } from "../access/client-access.js";
import type { BalanceRow, CorrectionKind, CorrectionPurpose, CorrectionRow, JournalPayload, OpeningPayload } from "./correction.types.js";

type Db = PoolConnection | typeof pool;

const JSON_COLUMNS = ["payload", "before_values", "after_values"] as const;

/** mysql2 returns JSON columns parsed; tolerate strings too. */
function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

export function toCorrectionRow(raw: Record<string, unknown>): CorrectionRow {
  const row = { ...raw } as Record<string, unknown>;
  for (const c of JSON_COLUMNS) row[c] = parseJson(row[c]);
  return row as unknown as CorrectionRow;
}

export interface NewDraft {
  clientId: number;
  connectionId: number;
  journlCompanyId: string;
  journlBranchId: number;
  kind: CorrectionKind;
  purpose?: CorrectionPurpose;
  payload: JournalPayload | OpeningPayload;
  before: BalanceRow[] | null;
  after: BalanceRow[] | null;
  reason: string;
  initiatedBy: number;
  copiedFrom?: number | null;
}

export async function insertDraft(d: NewDraft, db: Db = pool): Promise<number> {
  const res = await execute(
    `INSERT INTO journl_corrections (client_id, connection_id, journl_company_id, journl_branch_id, kind, purpose, status,
                                     payload, before_values, after_values, reason, initiated_by, copied_from)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
    [
      d.clientId,
      d.connectionId,
      d.journlCompanyId,
      d.journlBranchId,
      d.kind,
      d.purpose ?? "correction",
      JSON.stringify(d.payload),
      d.before ? JSON.stringify(d.before) : null,
      d.after ? JSON.stringify(d.after) : null,
      d.reason,
      d.initiatedBy,
      d.copiedFrom ?? null,
    ],
    db,
  );
  return res.insertId;
}

/** Seconds a row may sit in `posting` before it counts as stuck (the write itself times out after 20 s). */
export const STUCK_POSTING_SECONDS = 120;
/** Computed in SQL so updated_at and NOW() share the DB session's clock. */
const STUCK_COL = `(status = 'posting' AND updated_at < NOW() - INTERVAL ${STUCK_POSTING_SECONDS} SECOND) AS stuck_posting`;

export async function findCorrection(id: number, db: Db = pool): Promise<CorrectionRow | null> {
  const raw = await queryOne<Record<string, unknown>>(`SELECT *, ${STUCK_COL} FROM journl_corrections WHERE id = ?`, [id], db);
  return raw ? toCorrectionRow(raw) : null;
}

export async function listForClient(clientId: number, db: Db = pool): Promise<CorrectionRow[]> {
  const rows = await query<Record<string, unknown>>(`SELECT *, ${STUCK_COL} FROM journl_corrections WHERE client_id = ? ORDER BY id DESC`, [clientId], db);
  return rows.map(toCorrectionRow);
}

/**
 * pending_approval corrections the actor may review: on clients where they hold a REVIEWER_TEAM_ROLES assignment
 * today (same conditions as activeTeamRoles), or every one for super_admin. Never ones the actor initiated.
 */
export async function listAwaitingApproval(actor: AuthUser, db: Db = pool): Promise<CorrectionRow[]> {
  if (actor.role === "ops_admin") return []; // ops_admin never approves
  let rows: Record<string, unknown>[];
  if (actor.role === "super_admin") {
    rows = await query<Record<string, unknown>>(
      "SELECT c.* FROM journl_corrections c WHERE c.status = 'pending_approval' AND c.initiated_by <> ? ORDER BY c.id DESC",
      [actor.id],
      db,
    );
  } else {
    const roles = REVIEWER_TEAM_ROLES.map(() => "?").join(", ");
    rows = await query<Record<string, unknown>>(
      `SELECT c.* FROM journl_corrections c
        WHERE c.status = 'pending_approval' AND c.initiated_by <> ?
          AND EXISTS (SELECT 1 FROM assignments a
                       WHERE a.user_id = ? AND a.client_id = c.client_id AND a.team_role IN (${roles}) AND ${activeAssignmentSql("a")})
        ORDER BY c.id DESC`,
      [actor.id, actor.id, ...REVIEWER_TEAM_ROLES],
      db,
    );
  }
  return rows.map(toCorrectionRow);
}

/** Edits a draft in place. Only drafts are editable; returns false when it was not (or no longer) a draft. */
export async function updateDraft(
  id: number,
  payload: JournalPayload | OpeningPayload,
  before: BalanceRow[] | null,
  after: BalanceRow[] | null,
  reason: string,
  db: Db = pool,
): Promise<boolean> {
  const res = await execute(
    "UPDATE journl_corrections SET payload = ?, before_values = ?, after_values = ?, reason = ? WHERE id = ? AND status = 'draft'",
    [JSON.stringify(payload), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason, id],
    db,
  );
  return res.affectedRows > 0;
}

export interface CorrectionEvent {
  id: number;
  correction_id: number;
  from_status: string | null;
  to_status: string;
  actor_id: number | null;
  note: string | null;
  request_id: string | null;
  created_at: string;
  /** users.full_name of actor_id; "(unknown user)" when the actor no longer resolves; null for system steps (no actor). */
  actor_name: string | null;
}

export async function events(id: number, db: Db = pool): Promise<CorrectionEvent[]> {
  return query<CorrectionEvent>(
    `SELECT e.*, CASE WHEN e.actor_id IS NULL THEN NULL ELSE COALESCE(u.full_name, '(unknown user)') END AS actor_name
       FROM journl_correction_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.correction_id = ? ORDER BY e.id`,
    [id],
    db,
  );
}

/** The client's JournL connection as corrections need it. `authorized_by` is the owner whose session JournL sees. */
export function journlConnectionFor(clientId: number, db: Db = pool) {
  return queryOne<{ id: number; status: string; external_org_id: string | null; authorized_by: number | null }>(
    "SELECT id, status, external_org_id, authorized_by FROM integration_connections WHERE client_id = ? AND provider = 'journl'",
    [clientId],
    db,
  );
}

/** Sets the branch and JournL session owner on a draft (both chosen at preparation). False when it is not a draft. */
export async function setDraftJournlContext(id: number, branchId: number, sessionOwner: number, db: Db = pool): Promise<boolean> {
  const res = await execute(
    "UPDATE journl_corrections SET journl_branch_id = ?, journl_session_owner = ? WHERE id = ? AND status = 'draft'",
    [branchId, sessionOwner, id],
    db,
  );
  return res.affectedRows > 0;
}

/**
 * Who may approve a client's corrections, for notifications: active users holding a REVIEWER_TEAM_ROLES assignment on
 * the client today, never `excludeUserId` (the initiator). Admins are not mailed (ops_admin never approves).
 */
export function listApproverContacts(clientId: number, excludeUserId: number, db: Db = pool) {
  const roles = REVIEWER_TEAM_ROLES.map(() => "?").join(", ");
  return query<{ id: number; email: string; full_name: string }>(
    `SELECT DISTINCT u.id, u.email, u.full_name FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND a.team_role IN (${roles}) AND ${activeAssignmentSql("a")} AND u.status = 'active' AND u.id <> ?
        AND u.portal_role NOT IN ('ops_admin')`,
    [clientId, ...REVIEWER_TEAM_ROLES, excludeUserId],
    db,
  );
}

export interface PostedSuspenseAdjustment {
  id: number;
  payload: OpeningPayload;
  approved_by_name: string;
}

/** Posted unresolved-difference adjustments for a client, newest first (read-only; feeds the trial balance `suspense` field). */
export async function listPostedSuspenseAdjustments(clientId: number, db: Db = pool): Promise<PostedSuspenseAdjustment[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT c.id, c.payload, COALESCE(u.full_name, 'Unknown') AS approved_by_name
       FROM journl_corrections c LEFT JOIN users u ON u.id = c.approved_by
      WHERE c.client_id = ? AND c.purpose = 'unresolved_tb_difference' AND c.status = 'posted'
      ORDER BY c.id DESC`,
    [clientId],
    db,
  );
  return rows.map((r) => ({ id: Number(r.id), payload: parseJson<OpeningPayload>(r.payload) as OpeningPayload, approved_by_name: String(r.approved_by_name) }));
}

/** An active Accountanz user as an access check needs them (re-checked at posting). Null when missing or not active. */
export async function findActiveUser(id: number | null, db: Db = pool): Promise<AuthUser | null> {
  if (!id) return null;
  const u = await queryOne<{ id: number; email: string; full_name: string; portal_role: AuthUser["role"] }>(
    "SELECT id, email, full_name, portal_role FROM users WHERE id = ? AND status = 'active'",
    [id],
    db,
  );
  return u ? { id: u.id, email: u.email, fullName: u.full_name, role: u.portal_role } : null;
}
