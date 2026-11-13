import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { Scope } from "../documents/document.repository.js";
import type { ApprovalRow } from "./approval.types.js";
import type { ApprovalListQuery, CreateApprovalInput } from "./approval.validation.js";

const FROM = `FROM client_approvals a JOIN clients c ON c.id = a.client_id
  LEFT JOIN tasks t ON t.id = a.related_task_id LEFT JOIN users rq ON rq.id = a.requested_by LEFT JOIN users dc ON dc.id = a.decided_by`;
const COLUMNS = `a.id, a.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, a.subject, a.description,
  a.related_task_id, t.title AS related_task_title, a.status, rq.full_name AS requested_by_name,
  dc.full_name AS decided_by_name, a.decided_at, a.comment, a.created_at`;

export async function listApprovals(q: ApprovalListQuery, scope: Scope): Promise<Paged<ApprovalRow>> {
  const where = [scope.sql];
  const params: Param[] = [...scope.params];
  if (q.client_id) (where.push("a.client_id = ?"), params.push(q.client_id));
  if (q.status) (where.push("a.status = ?"), params.push(q.status));
  if (q.q) (where.push("(a.subject LIKE ? OR c.legal_name LIKE ? OR c.trade_name LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const items = await query<ApprovalRow>(`SELECT ${COLUMNS} ${FROM} ${whereSql} ORDER BY a.status = 'pending' DESC, a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, [
    ...params,
    q.pageSize,
    offsetOf(q),
  ]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findApproval = (id: number) => queryOne<ApprovalRow>(`SELECT ${COLUMNS} ${FROM} WHERE a.id = ?`, [id]);

export async function insertApproval(input: CreateApprovalInput, requesterId: number, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO client_approvals (client_id, subject, description, related_task_id, requested_by) VALUES (?, ?, ?, ?, ?)`,
    [input.client_id, input.subject, input.description, input.related_task_id, requesterId],
    conn,
  );
  return r.insertId;
}
