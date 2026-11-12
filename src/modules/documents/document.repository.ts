import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type ListQuery, type Paged } from "../../utils/pagination.js";
import type { DocumentRequestRow, DocumentRow, DocumentStatus } from "./document.types.js";
import type { DocumentListQuery } from "./document.validation.js";

const DOC_SELECT = `
  SELECT d.id, d.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, d.category, d.period,
         d.file_name, d.file_path, d.mime_type, d.status, u.email AS uploaded_by_email, d.created_at
    FROM documents d JOIN clients c ON c.id = d.client_id LEFT JOIN users u ON u.id = d.uploaded_by`;

export async function listDocuments(q: DocumentListQuery): Promise<Paged<DocumentRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) (where.push("d.file_name LIKE ?"), params.push(`%${q.q}%`));
  if (q.client_id) (where.push("d.client_id = ?"), params.push(q.client_id));
  if (q.category) (where.push("d.category = ?"), params.push(q.category));
  if (q.status) (where.push("d.status = ?"), params.push(q.status));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<DocumentRow>(`${DOC_SELECT} ${whereSql} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`, [...params, q.pageSize, offsetOf(q)]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM documents d ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findDocument = (id: number) => queryOne<DocumentRow>(`${DOC_SELECT} WHERE d.id = ?`, [id]);

export async function setDocumentStatus(id: number, status: DocumentStatus, reviewerId: number, conn: PoolConnection) {
  await execute(`UPDATE documents SET status = ?, reviewed_by = IF(? = 'new', NULL, ?) WHERE id = ?`, [status, status, reviewerId, id], conn);
}

/** What the team is waiting on from clients. */
export async function listOpenRequests(q: ListQuery): Promise<Paged<DocumentRequestRow>> {
  const where = ["r.status = 'open'"];
  const params: Param[] = [];
  if (q.q) (where.push("(r.description LIKE ? OR c.legal_name LIKE ? OR c.trade_name LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const from = `FROM document_requests r JOIN clients c ON c.id = r.client_id LEFT JOIN users u ON u.id = r.requested_by`;
  const items = await query<DocumentRequestRow>(
    `SELECT r.id, r.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, r.description,
            u.email AS requested_by_email, r.due_date, r.period, r.status
       ${from} ${whereSql} ORDER BY r.due_date IS NULL, r.due_date, r.id LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}
