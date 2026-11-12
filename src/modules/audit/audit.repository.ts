import { query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type ListQuery, type Paged } from "../../utils/pagination.js";
import type { AuditLogRow } from "./audit.types.js";

export async function listAuditLogs(q: ListQuery & { clientId?: number }): Promise<Paged<AuditLogRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(a.action LIKE ? OR a.actor_email LIKE ? OR a.details LIKE ?)");
    params.push(like, like, like);
  }
  if (q.clientId) {
    where.push("a.client_id = ?");
    params.push(q.clientId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<AuditLogRow>(
    `SELECT a.id, a.created_at, a.action, a.actor_email, a.actor_role, a.entity_type, a.entity_id, a.details,
            a.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name
       FROM audit_logs a LEFT JOIN clients c ON c.id = a.client_id
       ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs a ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}
