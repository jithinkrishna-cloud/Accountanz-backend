import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import { activeAssignmentSql } from "../access/client-access.js";
import type { ChecklistItem, GenerationCandidate, TaskDetail, TaskListRow, TaskOptions, TaskRecord, TaskStatus } from "./task.types.js";
import { TASK_VIEWS, type TaskListQuery } from "./task.validation.js";

type Db = PoolConnection | typeof pool;

// ───────────────────────────── Lists ─────────────────────────────

/**
 * Task list with optional scoping. `scopeSql` restricts clients (access rule); `assigneeId` limits to one person.
 */
export async function listTasks(
  q: TaskListQuery,
  opts: { scopeSql?: string; scopeParams?: Param[]; assigneeId?: number } = {},
): Promise<Paged<TaskListRow> & { counts: TaskViewCounts }> {
  const where: string[] = [];
  const params: Param[] = [];
  if (opts.scopeSql) (where.push(opts.scopeSql), params.push(...(opts.scopeParams ?? [])));
  if (opts.assigneeId) (where.push("t.assignee_id = ?"), params.push(opts.assigneeId));
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(t.title LIKE ? OR c.legal_name LIKE ? OR c.trade_name LIKE ? OR a.email LIKE ?)");
    params.push(like, like, like, like);
  }
  if (q.status) (where.push("t.status = ?"), params.push(q.status));
  if (q.period) (where.push("t.period = ?"), params.push(q.period));
  if (q.source) (where.push("t.creation_source = ?"), params.push(q.source));
  if (q.client_id) (where.push("t.client_id = ?"), params.push(q.client_id));
  const from = `FROM tasks t JOIN clients c ON c.id = t.client_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users r ON r.id = t.reviewer_id`;
  // The view counts ignore the chosen view and status, so the summary tiles always show the whole picture.
  const baseWhereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const counts = await queryOne<TaskViewCounts>(
    `SELECT ${Object.entries(VIEW_SQL).map(([k, sql]) => `CAST(COALESCE(SUM(${sql}), 0) AS UNSIGNED) AS ${k}`).join(", ")} ${from} ${baseWhereSql}`,
    params,
  );
  if (q.view) where.push(VIEW_SQL[q.view]);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await query<TaskListRow & { client_visible: unknown }>(
    `SELECT t.id, t.title, t.period, t.status, t.due_date, t.client_visible, t.creation_source AS source,
            c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name,
            t.assignee_id, a.email AS assignee_email, r.email AS reviewer_email
       ${from} ${whereSql}
      ORDER BY ${TASK_WORK_ORDER}, CASE WHEN t.status = 'approved' THEN t.period END DESC, t.due_date IS NULL, t.due_date, t.id
      LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params);
  return {
    items: rows.map((r) => ({ ...r, client_visible: Boolean(r.client_visible) })),
    total: total?.n ?? 0,
    page: q.page,
    pageSize: q.pageSize,
    counts: counts ?? { open: 0, overdue: 0, due_week: 0, review: 0, done: 0 },
  };
}

const OPEN_SQL = "t.status IN ('todo', 'in_progress', 'returned')";
const VIEW_SQL: Record<TaskView, string> = {
  open: OPEN_SQL,
  overdue: `${OPEN_SQL} AND t.due_date < CURDATE()`,
  due_week: `${OPEN_SQL} AND t.due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)`,
  review: "t.status = 'submitted'",
  done: "t.status = 'approved'",
};
export type TaskView = (typeof TASK_VIEWS)[number];
export type TaskViewCounts = Record<TaskView, number>;

/** Work that needs doing first (returned, in progress, to do), then waiting for review, then done (newest month first). */
const TASK_WORK_ORDER = `FIELD(t.status, 'returned', 'in_progress', 'todo', 'submitted', 'approved')`;

/** Per-client task counts for the same scope as `listTasks` (the My Tasks client navigation). */
export function taskClientSummary(opts: { scopeSql?: string; scopeParams?: Param[]; assigneeId?: number }) {
  const where: string[] = [];
  const params: Param[] = [];
  if (opts.scopeSql) (where.push(opts.scopeSql), params.push(...(opts.scopeParams ?? [])));
  if (opts.assigneeId) (where.push("t.assignee_id = ?"), params.push(opts.assigneeId));
  return query<{ client_id: number; client_name: string; total: number; open: number; overdue: number }>(
    `SELECT c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, COUNT(*) AS total,
            CAST(SUM(t.status IN ('todo', 'in_progress', 'returned')) AS UNSIGNED) AS open,
            CAST(SUM(t.status IN ('todo', 'in_progress', 'returned') AND t.due_date < CURDATE()) AS UNSIGNED) AS overdue
       FROM tasks t JOIN clients c ON c.id = t.client_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY c.id, client_name ORDER BY client_name`,
    params,
  );
}

// ───────────────────────────── One task ─────────────────────────────

const RECORD_SELECT = `
  SELECT t.id, t.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, t.engagement_id, t.template_item_id,
         t.creation_source, t.period, t.title, t.description, t.checklist, t.status, t.due_date, t.client_visible,
         t.submitted_at, t.assignee_id, a.full_name AS assignee_name, t.reviewer_id, r.full_name AS reviewer_name,
         cb.email AS created_by_email
    FROM tasks t
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN users r ON r.id = t.reviewer_id
    LEFT JOIN users cb ON cb.id = t.created_by`;

const normalize = (row: TaskRecord & { client_visible: unknown }): TaskRecord => ({ ...row, client_visible: Boolean(row.client_visible) });

export async function findTask(id: number, db: Db = pool) {
  const row = await queryOne<TaskRecord & { client_visible: unknown }>(`${RECORD_SELECT} WHERE t.id = ?`, [id], db);
  return row ? normalize(row) : null;
}

/** Locks the task row for a status/content change. */
export async function lockTask(id: number, conn: PoolConnection) {
  const row = await queryOne<TaskRecord & { client_visible: unknown }>(`${RECORD_SELECT} WHERE t.id = ? FOR UPDATE`, [id], conn);
  return row ? normalize(row) : null;
}

export function listWorkLogs(taskId: number) {
  return query<TaskDetail["work_logs"][number]>(
    `SELECT w.id, u.email AS user_email, w.minutes, w.note, w.logged_on
       FROM work_logs w JOIN users u ON u.id = w.user_id WHERE w.task_id = ? ORDER BY w.logged_on DESC, w.id DESC`,
    [taskId],
  );
}

export function listTaskReviews(taskId: number) {
  return query<TaskDetail["reviews"][number]>(
    `SELECT tr.decision, tr.comments, u.email AS reviewer_email, tr.submission_number, tr.created_at
       FROM task_reviews tr LEFT JOIN users u ON u.id = tr.reviewer_id WHERE tr.task_id = ? ORDER BY tr.created_at DESC, tr.id DESC`,
    [taskId],
  );
}

export interface NewManualTask {
  clientId: number;
  engagementId: number;
  period: string;
  title: string;
  description: string | null;
  checklist: ChecklistItem[];
  createdBy: number;
  assigneeId: number;
  reviewerId: number;
  dueDate: string;
  clientVisible: boolean;
}

export async function insertManualTask(t: NewManualTask, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO tasks (client_id, engagement_id, template_item_id, creation_source, period, title, description, checklist,
                        created_by, assignee_id, reviewer_id, due_date, client_visible)
     VALUES (?, ?, NULL, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.clientId, t.engagementId, t.period, t.title, t.description, JSON.stringify(t.checklist), t.createdBy, t.assigneeId, t.reviewerId, t.dueDate, t.clientVisible],
    conn,
  );
  return r.insertId;
}

export interface TaskFieldChanges {
  title?: string;
  description?: string | null;
  checklist?: ChecklistItem[];
  assignee_id?: number;
  reviewer_id?: number;
  period?: string;
  due_date?: string;
  client_visible?: boolean;
}

// ── Client-created tasks (Client Portal) ──

/** A task of this client that someone at the company created (not the team), locked for a change. */
export async function lockClientCreatedTask(clientId: number, id: number, conn: PoolConnection) {
  const row = await queryOne<{ id: number; title: string; status: TaskStatus; period: string; checklist: ChecklistItem[] | string }>(
    `SELECT t.id, t.title, t.status, t.period, t.checklist FROM tasks t
      WHERE t.id = ? AND t.client_id = ?
        AND EXISTS (SELECT 1 FROM client_users cu WHERE cu.user_id = t.created_by AND cu.client_id = t.client_id)
      FOR UPDATE`,
    [id, clientId],
    conn,
  );
  if (!row) return null;
  return { ...row, checklist: typeof row.checklist === "string" ? (JSON.parse(row.checklist) as ChecklistItem[]) : row.checklist };
}

export const countWorkLogs = (id: number, conn: PoolConnection) =>
  queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM work_logs WHERE task_id = ?`, [id], conn).then((r) => Number(r?.n ?? 0));

export const deleteTask = (id: number, conn: PoolConnection) => execute(`DELETE FROM tasks WHERE id = ?`, [id], conn);

export async function updateTaskFields(id: number, changes: TaskFieldChanges, conn: PoolConnection) {
  const sets: string[] = [];
  const params: Param[] = [];
  for (const [key, value] of Object.entries(changes)) {
    sets.push(`${key} = ?`);
    params.push(key === "checklist" ? JSON.stringify(value) : (value as Param));
  }
  if (!sets.length) return;
  await execute(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, [...params, id], conn);
}

export async function setChecklistAndStatus(id: number, checklist: ChecklistItem[], status: TaskStatus, conn: PoolConnection) {
  await execute(`UPDATE tasks SET checklist = ?, status = ? WHERE id = ?`, [JSON.stringify(checklist), status, id], conn);
}

export async function markSubmitted(id: number, conn: PoolConnection) {
  await execute(`UPDATE tasks SET status = 'submitted', submitted_at = UTC_TIMESTAMP() WHERE id = ?`, [id], conn);
}

export async function insertWorkLog(taskId: number, userId: number, minutes: number, note: string | null, loggedOn: string, conn: PoolConnection) {
  const r = await execute(`INSERT INTO work_logs (task_id, user_id, minutes, note, logged_on) VALUES (?, ?, ?, ?, ?)`, [taskId, userId, minutes, note, loggedOn], conn);
  return r.insertId;
}

// ───────────────────────────── Form options ─────────────────────────────

/** Clients the user may create tasks for: every non-exited client for admins, else assigned clients. */
export function listClientOptions(userId: number | null) {
  if (userId === null) {
    return query<TaskOptions["clients"][number]>(`SELECT id, COALESCE(trade_name, legal_name) AS name FROM clients WHERE status <> 'exited' ORDER BY name`);
  }
  return query<TaskOptions["clients"][number]>(
    `SELECT DISTINCT c.id, COALESCE(c.trade_name, c.legal_name) AS name
       FROM clients c JOIN assignments a ON a.client_id = c.id
      WHERE a.user_id = ? AND ${activeAssignmentSql("a")} AND c.status <> 'exited' ORDER BY name`,
    [userId],
  );
}

export function listActiveEngagements(clientId: number) {
  return query<TaskOptions["engagements"][number]>(
    `SELECT e.id, p.name AS package_name FROM engagements e JOIN packages p ON p.id = e.package_id
      WHERE e.client_id = ? AND e.status = 'active' ORDER BY e.start_date DESC, e.id DESC`,
    [clientId],
  );
}

/** Everyone with an active assignment on the client today. */
export function listClientTeam(clientId: number) {
  return query<TaskOptions["assignees"][number]>(
    `SELECT u.id AS user_id, u.full_name, a.team_role
       FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")} AND u.status = 'active'
      ORDER BY u.full_name, a.team_role`,
    [clientId],
  );
}

export const listActiveAdmins = () =>
  query<TaskOptions["reviewers"][number]>(
    `SELECT id AS user_id, full_name, portal_role AS role FROM users WHERE portal_role IN ('super_admin', 'ops_admin') AND status = 'active' ORDER BY full_name`,
  );

export function findEngagement(id: number) {
  return queryOne<{ id: number; client_id: number; status: string }>(`SELECT id, client_id, status FROM engagements WHERE id = ?`, [id]);
}

export const findActiveUser = (id: number) =>
  queryOne<{ id: number; email: string; portal_role: string }>(`SELECT id, email, portal_role FROM users WHERE id = ? AND status = 'active'`, [id]);

// ───────────────────────────── Bulk generation ─────────────────────────────

/**
 * Every (active engagement × template item) that could produce a task for the period:
 * the engagement must cover the period, and the template's service must be one of the engagement's services (its own list, else its package's).
 */
export function listGenerationCandidates(periodStart: string, periodEnd: string, conn: PoolConnection) {
  return query<GenerationCandidate>(
    `SELECT e.client_id, e.id AS engagement_id, i.id AS template_item_id, i.title, i.checklist, i.client_visible,
            tt.due_day_of_period, tt.recurrence
       FROM engagements e
       JOIN (
         SELECT es.engagement_id, es.service_id FROM engagement_services es
         UNION ALL
         SELECT e3.id, ps.service_id FROM engagements e3 JOIN package_services ps ON ps.package_id = e3.package_id
          WHERE NOT EXISTS (SELECT 1 FROM engagement_services x WHERE x.engagement_id = e3.id)
       ) svc ON svc.engagement_id = e.id
       JOIN task_templates tt ON tt.service_id = svc.service_id
       JOIN task_template_items i ON i.template_id = tt.id
      WHERE e.status = 'active'
        AND e.start_date IS NOT NULL AND e.start_date <= ?
        AND (e.end_date IS NULL OR e.end_date >= ?)
      ORDER BY e.id, tt.due_day_of_period, i.sort_order, i.id`,
    [periodEnd, periodStart],
    conn,
  );
}

/** The client's team during the period, by role (default assignee / reviewer for generated tasks). */
export function listTeamForPeriod(clientIds: number[], periodStart: string, periodEnd: string, conn: PoolConnection) {
  if (!clientIds.length) return Promise.resolve([]);
  return query<{ client_id: number; user_id: number; team_role: string }>(
    `SELECT client_id, user_id, team_role FROM assignments
      WHERE status = 'active' AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
        AND client_id IN (${clientIds.map(() => "?").join(",")})
      ORDER BY valid_from, id`,
    [periodEnd, periodStart, ...clientIds],
    conn,
  );
}

/** Inserts unless the (engagement, template item, period) task already exists. Returns true when created. */
export async function insertGeneratedTask(
  t: {
    clientId: number;
    engagementId: number;
    templateItemId: number;
    period: string;
    title: string;
    checklist: ChecklistItem[];
    createdBy: number;
    assigneeId: number | null;
    reviewerId: number | null;
    dueDate: string;
    clientVisible: boolean;
  },
  conn: PoolConnection,
): Promise<boolean> {
  const r = await execute(
    `INSERT IGNORE INTO tasks (client_id, engagement_id, template_item_id, creation_source, period, title, checklist, created_by, assignee_id, reviewer_id, due_date, client_visible)
     VALUES (?, ?, ?, 'template', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.clientId, t.engagementId, t.templateItemId, t.period, t.title, JSON.stringify(t.checklist), t.createdBy, t.assigneeId, t.reviewerId, t.dueDate, t.clientVisible],
    conn,
  );
  return r.affectedRows === 1;
}
