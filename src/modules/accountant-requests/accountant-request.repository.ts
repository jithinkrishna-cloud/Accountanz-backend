import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne } from "../../database/connection.js";
import { activeAssignmentSql } from "../access/client-access.js";

type Db = PoolConnection | typeof pool;

export type RequestKind = "join_team" | "one_off" | "replace";
export type RequestStatus = "pending" | "approved" | "declined" | "withdrawn";

/**
 * Verified, active accountants as a client may see them. Deliberately no rate, bank details, email or phone, and
 * no performance numbers: clients choose by role and expertise, Accountanz handles the rest.
 */
export interface ExploreAccountant {
  id: number;
  full_name: string;
  role: string;
  expertise: string[];
  member_since: string;
  /** Their current team role(s) on this client, if they already work on it. */
  team_roles: string[];
  /** This client's open (pending) request for them, if any. */
  pending_request_id: number | null;
}

interface AccountantRow {
  id: number;
  full_name: string;
  role: string;
  expertise: unknown;
  member_since: string;
  team_roles: string | null;
  pending_request_id: number | null;
}

const parseList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
};

export async function exploreAccountants(clientId: number, accountantId?: number): Promise<ExploreAccountant[]> {
  const rows = await query<AccountantRow>(
    `SELECT u.id, u.full_name, u.portal_role AS role, sp.expertise, DATE(u.created_at) AS member_since,
            (SELECT GROUP_CONCAT(DISTINCT a.team_role) FROM assignments a WHERE a.user_id = u.id AND a.client_id = ? AND ${activeAssignmentSql("a")}) AS team_roles,
            (SELECT r.id FROM accountant_requests r WHERE r.accountant_id = u.id AND r.client_id = ? AND r.status = 'pending' ORDER BY r.id DESC LIMIT 1) AS pending_request_id
       FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
      WHERE sp.staff_type = 'accountant' AND sp.verification_status = 'verified' AND u.status = 'active' ${accountantId ? "AND u.id = ?" : ""}
      ORDER BY FIELD(u.portal_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name`,
    accountantId ? [clientId, clientId, accountantId] : [clientId, clientId],
  );
  return rows.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    role: r.role,
    expertise: parseList(r.expertise),
    member_since: r.member_since,
    team_roles: r.team_roles ? r.team_roles.split(",") : [],
    pending_request_id: r.pending_request_id,
  }));
}

export interface RequestRow {
  id: number;
  client_id: number;
  client_name: string;
  accountant_id: number;
  accountant_name: string;
  accountant_role: string;
  requested_by: number | null;
  requester_name: string | null;
  kind: RequestKind;
  /** kind=replace: the team member to hand over from (their assignment, name and role). */
  replaces_assignment_id: number | null;
  replaces_name: string | null;
  replaces_role: string | null;
  replaces_user_id: number | null;
  message: string;
  preferred_start: string | null;
  status: RequestStatus;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

const SELECT = `SELECT r.id, r.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, r.accountant_id, a.full_name AS accountant_name,
                       a.portal_role AS accountant_role, r.requested_by, q.full_name AS requester_name, r.kind,
                       r.replaces_assignment_id, ru.full_name AS replaces_name, ra.team_role AS replaces_role, ra.user_id AS replaces_user_id,
                       r.message, r.preferred_start,
                       r.status, d.full_name AS decided_by_name, r.decided_at, r.decision_note, r.created_at
                  FROM accountant_requests r
                  JOIN clients c ON c.id = r.client_id
                  JOIN users a ON a.id = r.accountant_id
                  LEFT JOIN assignments ra ON ra.id = r.replaces_assignment_id
                  LEFT JOIN users ru ON ru.id = ra.user_id
                  LEFT JOIN users q ON q.id = r.requested_by
                  LEFT JOIN users d ON d.id = r.decided_by`;

export const findRequest = (id: number, db: Db = pool) => queryOne<RequestRow>(`${SELECT} WHERE r.id = ?`, [id], db);

export const clientRequests = (clientId: number) => query<RequestRow>(`${SELECT} WHERE r.client_id = ? ORDER BY r.id DESC LIMIT 50`, [clientId]);

export const adminRequests = (status?: RequestStatus) =>
  query<RequestRow>(`${SELECT} ${status ? "WHERE r.status = ?" : ""} ORDER BY r.status = 'pending' DESC, r.id DESC LIMIT 200`, status ? [status] : []);

export const pendingCount = async () => (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM accountant_requests WHERE status = 'pending'`))?.n ?? 0;

export async function insertRequest(
  r: { clientId: number; accountantId: number; requestedBy: number; kind: RequestKind; replacesAssignmentId: number | null; message: string; preferredStart: string | null },
  db: Db = pool,
) {
  const res = await execute(
    `INSERT INTO accountant_requests (client_id, accountant_id, requested_by, kind, replaces_assignment_id, message, preferred_start) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [r.clientId, r.accountantId, r.requestedBy, r.kind, r.replacesAssignmentId, r.message, r.preferredStart],
    db,
  );
  return res.insertId;
}

/** An active assignment on this client (the team member a client wants replaced). */
export const activeTeamAssignment = (clientId: number, assignmentId: number) =>
  queryOne<{ id: number; user_id: number; full_name: string; email: string; team_role: string }>(
    `SELECT a.id, a.user_id, u.full_name, u.email, a.team_role
       FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.id = ? AND a.client_id = ? AND ${activeAssignmentSql("a")}`,
    [assignmentId, clientId],
  );

export const pendingReplaceFor = async (assignmentId: number) =>
  !!(await queryOne<{ id: number }>(`SELECT id FROM accountant_requests WHERE replaces_assignment_id = ? AND status = 'pending' LIMIT 1`, [assignmentId]));

export async function setStatus(id: number, status: RequestStatus, decidedBy: number | null, note: string | null, db: Db = pool) {
  const res = await execute(
    `UPDATE accountant_requests SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ? WHERE id = ? AND status = 'pending'`,
    [status, decidedBy, note, id],
    db,
  );
  return res.affectedRows === 1;
}

/** What anyone may see about an accountant on the public site: name, role, expertise, start date and a URL slug. Nothing else. */
export interface PublicAccountant {
  slug: string;
  full_name: string;
  role: string;
  expertise: string[];
  member_since: string;
}

/** "Meera Joshi", 7 -> "meera-joshi-7". The trailing number is how the detail page finds the person. */
export const accountantSlug = (name: string, id: number) =>
  `${name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "accountant"}-${id}`;

/** Verified, active accountants for the public site. Selects only the public columns (id is used only to build the slug). */
export async function publicAccountants(accountantId?: number): Promise<PublicAccountant[]> {
  const rows = await query<{ id: number; full_name: string; role: string; expertise: unknown; member_since: string }>(
    `SELECT u.id, u.full_name, u.portal_role AS role, sp.expertise, DATE(u.created_at) AS member_since
       FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
      WHERE sp.staff_type = 'accountant' AND sp.verification_status = 'verified' AND u.status = 'active' ${accountantId ? "AND u.id = ?" : ""}
      ORDER BY FIELD(u.portal_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name
      LIMIT 60`,
    accountantId ? [accountantId] : [],
  );
  return rows.map((r) => ({ slug: accountantSlug(r.full_name, r.id), full_name: r.full_name, role: r.role, expertise: parseList(r.expertise), member_since: r.member_since }));
}

/**
 * What one accountant has done for this client: the client's own data, so it can be shown on the profile. Only
 * client-visible tasks count, and nothing about other clients is read.
 */
export async function historyWithClient(clientId: number, userId: number, oversees = false) {
  const [summary, recent, assignments] = await Promise.all([
    queryOne<{ first_day: string | null; done_total: number; month_total: number; month_done: number; open_now: number; waiting_review: number; open_requests: number; last_activity: string | null }>(
      `SELECT (SELECT DATE_FORMAT(MIN(a.valid_from), '%Y-%m-%d') FROM assignments a WHERE a.client_id = ? AND a.user_id = ?) AS first_day,
              COALESCE(SUM(t.status = 'approved'), 0) AS done_total,
              COALESCE(SUM(t.period = DATE_FORMAT(CURDATE(), '%Y-%m')), 0) AS month_total,
              COALESCE(SUM(t.period = DATE_FORMAT(CURDATE(), '%Y-%m') AND t.status = 'approved'), 0) AS month_done,
              COALESCE(SUM(t.status IN ('todo', 'in_progress', 'returned') AND (? OR t.assignee_id = ?)), 0) AS open_now,
              COALESCE(SUM(t.status = 'submitted'), 0) AS waiting_review,
              (SELECT COUNT(*) FROM document_requests dr WHERE dr.client_id = ? AND dr.requested_by = ? AND dr.status = 'open') AS open_requests,
              DATE_FORMAT(MAX(t.updated_at), '%Y-%m-%d') AS last_activity
         FROM tasks t
        WHERE t.client_id = ? AND t.client_visible = 1 AND (? OR t.assignee_id = ? OR t.reviewer_id = ?)`,
      [clientId, userId, oversees, userId, clientId, userId, clientId, oversees, userId, userId],
    ),
    query<{ id: number; title: string; period: string; finished_on: string | null; part: "did" | "checked" | "oversaw" }>(
      `SELECT t.id, t.title, t.period,
              (SELECT DATE_FORMAT(MAX(tr.created_at), '%Y-%m-%d') FROM task_reviews tr WHERE tr.task_id = t.id AND tr.decision = 'approved') AS finished_on,
              CASE WHEN t.assignee_id = ? THEN 'did' WHEN t.reviewer_id = ? THEN 'checked' ELSE 'oversaw' END AS part
         FROM tasks t
        WHERE t.client_id = ? AND t.client_visible = 1 AND t.status = 'approved' AND (? OR t.assignee_id = ? OR t.reviewer_id = ?)
        ORDER BY finished_on DESC, t.id DESC LIMIT 5`,
      [userId, userId, clientId, oversees, userId, userId],
    ),
    query<{ team_role: string; valid_from: string; valid_to: string | null; current: 0 | 1 }>(
      `SELECT a.team_role, DATE_FORMAT(a.valid_from, '%Y-%m-%d') AS valid_from, DATE_FORMAT(COALESCE(a.valid_to, IF(a.status = 'ended', DATE(a.created_at), NULL)), '%Y-%m-%d') AS valid_to,
              (${activeAssignmentSql("a")}) AS current
         FROM assignments a WHERE a.client_id = ? AND a.user_id = ? ORDER BY a.valid_from DESC`,
      [clientId, userId],
    ),
  ]);
  return { summary, recent, assignments };
}
