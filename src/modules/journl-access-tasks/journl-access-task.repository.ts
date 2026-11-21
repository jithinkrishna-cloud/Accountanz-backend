import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { ADMIN_ROLES } from "../../types/auth.types.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { AccessTaskAction, AccessTaskRow, AccessTaskStatus } from "./journl-access-task.types.js";
import type { AccessTaskListQuery } from "./journl-access-task.validation.js";

type Db = PoolConnection | typeof pool;

const SELECT = `
  SELECT t.id, t.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, ic.external_org_id AS journl_org_id,
         t.assignment_id, t.user_id, u.full_name AS user_name, u.email AS user_email,
         t.previous_user_id, pu.full_name AS previous_user_name, t.action, t.status,
         t.responsible_id, ru.full_name AS responsible_name, t.notes, t.completed_at, cu.full_name AS completed_by_name,
         cb.full_name AS created_by_name, t.created_at
    FROM journl_access_tasks t
    JOIN clients c ON c.id = t.client_id
    JOIN users u ON u.id = t.user_id
    LEFT JOIN users pu ON pu.id = t.previous_user_id
    LEFT JOIN users ru ON ru.id = t.responsible_id
    LEFT JOIN users cu ON cu.id = t.completed_by
    LEFT JOIN users cb ON cb.id = t.created_by
    LEFT JOIN integration_connections ic ON ic.client_id = t.client_id AND ic.provider = 'journl'`;

export async function listTasks(q: AccessTaskListQuery): Promise<Paged<AccessTaskRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.status === "open") where.push("t.status IN ('pending','in_progress')");
  else if (q.status === "done") where.push("t.status IN ('completed','cancelled')");
  if (q.clientId) {
    where.push("t.client_id = ?");
    params.push(q.clientId);
  }
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(c.legal_name LIKE ? OR c.trade_name LIKE ? OR u.full_name LIKE ? OR pu.full_name LIKE ?)");
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<AccessTaskRow>(
    `${SELECT} ${whereSql} ORDER BY FIELD(t.status, 'in_progress', 'pending', 'completed', 'cancelled'), t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journl_access_tasks t JOIN clients c ON c.id = t.client_id JOIN users u ON u.id = t.user_id
       LEFT JOIN users pu ON pu.id = t.previous_user_id ${whereSql}`,
    params,
  );
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findTask = (id: number, db: Db = pool) => queryOne<AccessTaskRow>(`${SELECT} WHERE t.id = ?`, [id], db);

export const lockTask = (id: number, db: PoolConnection) =>
  queryOne<{ id: number; client_id: number; status: AccessTaskStatus; action: AccessTaskAction }>(
    `SELECT id, client_id, status, action FROM journl_access_tasks WHERE id = ? FOR UPDATE`,
    [id],
    db,
  );

/** The newest still-open to-do of the given kinds for an assignment, locked. */
export const lockOpenForAssignment = (assignmentId: number, actions: AccessTaskAction[], db: PoolConnection) =>
  queryOne<{ id: number; action: AccessTaskAction }>(
    `SELECT id, action FROM journl_access_tasks
      WHERE assignment_id = ? AND status IN ('pending','in_progress') AND action IN (${actions.map(() => "?").join(",")})
      ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [assignmentId, ...actions],
    db,
  );

export async function insertTask(
  input: { clientId: number; assignmentId: number | null; userId: number; previousUserId?: number | null; action: AccessTaskAction; createdBy: number },
  db: Db,
) {
  const r = await execute(
    `INSERT INTO journl_access_tasks (client_id, assignment_id, user_id, previous_user_id, action, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [input.clientId, input.assignmentId, input.userId, input.previousUserId ?? null, input.action, input.createdBy],
    db,
  );
  return r.insertId;
}

export async function updateTask(
  id: number,
  input: { status?: AccessTaskStatus; responsibleId?: number | null; notes?: string | null; completedBy?: number | null },
  db: Db,
) {
  const sets: string[] = [];
  const params: Param[] = [];
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
    if (input.status === "completed") {
      sets.push("completed_at = UTC_TIMESTAMP(), completed_by = ?");
      params.push(input.completedBy ?? null);
    }
  }
  if (input.responsibleId !== undefined) {
    sets.push("responsible_id = ?");
    params.push(input.responsibleId);
  }
  if (input.notes !== undefined) {
    sets.push("notes = ?");
    params.push(input.notes);
  }
  if (!sets.length) return;
  await execute(`UPDATE journl_access_tasks SET ${sets.join(", ")} WHERE id = ?`, [...params, id], db);
}

/** People who can own a to-do: active admins. */
export const responsibleOptions = () =>
  query<{ id: number; full_name: string }>(
    `SELECT id, full_name FROM users WHERE status = 'active' AND portal_role IN (${ADMIN_ROLES.map(() => "?").join(",")}) ORDER BY full_name`,
    [...ADMIN_ROLES],
  );

export const findResponsible = (id: number) =>
  queryOne<{ id: number }>(`SELECT id FROM users WHERE id = ? AND status = 'active' AND portal_role IN (${ADMIN_ROLES.map(() => "?").join(",")})`, [id, ...ADMIN_ROLES]);

/**
 * SQL for an assignment's newest non-cancelled to-do as "action:status" (alias `a` = assignments), read by
 * `accessState` to tell whether JournL access was actually confirmed.
 */
export const latestTaskSql = (alias = "a") =>
  `(SELECT CONCAT(jt.action, ':', jt.status) FROM journl_access_tasks jt WHERE jt.assignment_id = ${alias}.id AND jt.status <> 'cancelled' ORDER BY jt.id DESC LIMIT 1)`;
