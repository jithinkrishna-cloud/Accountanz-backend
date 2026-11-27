import { activeAssignmentSql } from "../access/client-access.js";
import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { AssignmentOptions, AssignmentRow, AssignmentStatus, TeamRole } from "./assignment.types.js";
import type { AssignmentInput, AssignmentListQuery, AssignmentUpdateInput } from "./assignment.validation.js";

type Db = PoolConnection | typeof pool;

const PHASE = `CASE
    WHEN a.status = 'ended' THEN 'ended'
    WHEN a.valid_from > CURDATE() THEN 'scheduled'
    WHEN a.valid_to IS NOT NULL AND a.valid_to < CURDATE() THEN 'expired'
    ELSE 'current' END`;

const SELECT = `
  SELECT a.id, a.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, c.status AS client_status,
         a.user_id, u.full_name, u.email, u.portal_role, a.team_role, a.valid_from, a.valid_to, a.status,
         ${PHASE} AS phase, a.journl_access, a.replaced_by_assignment_id, ru.full_name AS replaced_by_name,
         a.source_group_id, sg.name AS source_group_name, a.created_at
    FROM assignments a
    JOIN clients c ON c.id = a.client_id
    JOIN users u ON u.id = a.user_id
    LEFT JOIN assignments ra ON ra.id = a.replaced_by_assignment_id
    LEFT JOIN users ru ON ru.id = ra.user_id
    LEFT JOIN staff_groups sg ON sg.id = a.source_group_id`;

const toRow = (r: AssignmentRow): AssignmentRow => ({ ...r, journl_access: Boolean(r.journl_access) });

export async function listAssignments(q: AssignmentListQuery): Promise<Paged<AssignmentRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(c.legal_name LIKE ? OR c.trade_name LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)");
    params.push(like, like, like, like);
  }
  for (const [col, value] of [["a.status", q.status], ["a.team_role", q.team_role], ["a.client_id", q.clientId], ["a.user_id", q.userId]] as const) {
    if (value !== undefined) {
      where.push(`${col} = ?`);
      params.push(value);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<AssignmentRow>(
    `${SELECT} ${whereSql}
      ORDER BY a.status = 'ended', client_name, FIELD(a.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name, a.id DESC
      LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assignments a JOIN clients c ON c.id = a.client_id JOIN users u ON u.id = a.user_id ${whereSql}`,
    params,
  );
  return { items: items.map(toRow), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export async function findAssignment(id: number, db: Db = pool) {
  const row = await queryOne<AssignmentRow>(`${SELECT} WHERE a.id = ?`, [id], db);
  return row && toRow(row);
}

export interface LockedAssignment {
  id: number;
  client_id: number;
  user_id: number;
  team_role: TeamRole;
  valid_from: string;
  status: AssignmentStatus;
  journl_access: boolean;
}

export function lockAssignment(id: number, db: PoolConnection) {
  return queryOne<LockedAssignment>(`SELECT id, client_id, user_id, team_role, valid_from, status, journl_access = 1 AS journl_access FROM assignments WHERE id = ? FOR UPDATE`, [id], db).then((r) => r && { ...r, journl_access: Boolean(r.journl_access) });
}

export function findActiveDuplicate(input: Pick<AssignmentInput, "client_id" | "user_id" | "team_role">, exceptId: number, db: PoolConnection) {
  return queryOne<{ id: number }>(
    `SELECT id FROM assignments WHERE client_id = ? AND user_id = ? AND team_role = ? AND status = 'active' AND id <> ? LIMIT 1 FOR UPDATE`,
    [input.client_id, input.user_id, input.team_role, exceptId],
    db,
  );
}

export function findAssignableStaff(userId: number) {
  return queryOne<{ id: number; full_name: string; verification_status: string }>(
    `SELECT u.id, u.full_name, sp.verification_status FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
      WHERE u.id = ? AND u.status = 'active' AND sp.staff_type = 'accountant'`,
    [userId],
  );
}

export async function insertAssignment(
  input: Pick<AssignmentInput, "client_id" | "user_id" | "team_role" | "valid_from" | "valid_to" | "journl_access">,
  db: Db = pool,
  sourceGroupId: number | null = null,
): Promise<number> {
  const r = await execute(
    `INSERT INTO assignments (client_id, user_id, team_role, valid_from, valid_to, status, journl_access, source_group_id) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [input.client_id, input.user_id, input.team_role, input.valid_from, input.valid_to, input.journl_access, sourceGroupId],
    db,
  );
  return r.insertId;
}

export async function updateAssignment(id: number, input: AssignmentUpdateInput, db: Db = pool) {
  const keys = (["valid_to", "journl_access"] as const).filter((k) => input[k] !== undefined);
  if (!keys.length) return;
  await execute(`UPDATE assignments SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => input[k] ?? null), id], db);
}

/**
 * Ends an assignment today: an open or later end date becomes today. A scheduled assignment that
 * hasn't started yet ends on its start date (valid_to can't precede valid_from); status 'ended' blocks access either way.
 */
/** Every assignment still marked active for a person (current and future-dated), locked for ending. */
export function lockActiveForUser(userId: number, db: PoolConnection) {
  return query<{ id: number; client_id: number; team_role: string; journl_access: 0 | 1 }>(
    `SELECT id, client_id, team_role, journl_access FROM assignments WHERE user_id = ? AND status = 'active' FOR UPDATE`,
    [userId],
    db,
  );
}

export async function endAssignment(id: number, replacedBy: number | null, db: Db = pool) {
  await execute(
    `UPDATE assignments
        SET status = 'ended',
            valid_to = CASE
              WHEN valid_from > CURDATE() THEN valid_from
              WHEN valid_to IS NULL OR valid_to > CURDATE() THEN CURDATE()
              ELSE valid_to END,
            replaced_by_assignment_id = COALESCE(?, replaced_by_assignment_id)
      WHERE id = ? AND status = 'active'`,
    [replacedBy, id],
    db,
  );
}

const parseExpertise = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  try {
    const p = typeof v === "string" ? JSON.parse(v) : null;
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
};

export async function options(): Promise<AssignmentOptions> {
  const [staff, clients] = await Promise.all([
    query<AssignmentOptions["staff"][number]>(
      `SELECT u.id AS user_id, u.full_name, u.email, u.portal_role, sp.verification_status, sp.expertise,
              (SELECT COUNT(DISTINCT a.client_id) FROM assignments a WHERE a.user_id = u.id AND ${activeAssignmentSql("a")}) AS active_clients
         FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
        WHERE u.status = 'active' AND sp.staff_type = 'accountant' ORDER BY u.full_name`,
    ).then((rows) => rows.map((r) => ({ ...r, expertise: parseExpertise(r.expertise), active_clients: Number(r.active_clients) }))),
    query<AssignmentOptions["clients"][number]>(
      `SELECT id, COALESCE(trade_name, legal_name) AS name, status FROM clients WHERE status <> 'exited' ORDER BY name`,
    ),
  ]);
  return { staff, clients };
}
