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
  queryOne<{ id: number; user_id: number; full_name: string; email: string; team_role: string; journl_access: 0 | 1 }>(
    `SELECT a.id, a.user_id, u.full_name, u.email, a.team_role, a.journl_access
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

/** What anyone may see about an accountant on the public home page: name, role, expertise and start date. Nothing else. */
export interface PublicAccountant {
  full_name: string;
  role: string;
  expertise: string[];
  member_since: string;
}

/** Verified, active accountants for the public home page. Selects only the public columns, so nothing else can leak. */
export async function publicAccountants(): Promise<PublicAccountant[]> {
  const rows = await query<{ full_name: string; role: string; expertise: unknown; member_since: string }>(
    `SELECT u.full_name, u.portal_role AS role, sp.expertise, DATE(u.created_at) AS member_since
       FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
      WHERE sp.staff_type = 'accountant' AND sp.verification_status = 'verified' AND u.status = 'active'
      ORDER BY FIELD(u.portal_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name
      LIMIT 60`,
  );
  return rows.map((r) => ({ full_name: r.full_name, role: r.role, expertise: parseList(r.expertise), member_since: r.member_since }));
}
