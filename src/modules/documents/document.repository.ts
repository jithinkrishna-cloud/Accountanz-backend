import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { DocumentRequestRow, DocumentRow, DocumentStatus } from "./document.types.js";
import type { CreateRequestInput, DocumentListQuery, RequestListQuery, StaffUploadInput } from "./document.validation.js";

/** Callers pass the access predicate from clientScope(); admins get "1 = 1". */
export interface Scope {
  sql: string;
  params: Param[];
}

const DOC_SELECT = `
  SELECT d.id, d.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, d.category, d.period,
         d.file_name, d.file_path, d.mime_type, d.status, d.request_id, d.task_id, d.folder_id, d.uploaded_by AS uploaded_by_id,
         u.email AS uploaded_by_email, u.full_name AS uploaded_by_name,
         COALESCE(u.portal_role IN ('client_owner', 'client_member'), 0) AS from_client, d.created_at
    FROM documents d JOIN clients c ON c.id = d.client_id LEFT JOIN users u ON u.id = d.uploaded_by`;

export async function listDocuments(q: DocumentListQuery, scope: Scope): Promise<Paged<DocumentRow>> {
  const where = [scope.sql];
  const params: Param[] = [...scope.params];
  if (q.q) (where.push("d.file_name LIKE ?"), params.push(`%${q.q}%`));
  if (q.client_id) (where.push("d.client_id = ?"), params.push(q.client_id));
  if (q.category) (where.push("d.category = ?"), params.push(q.category));
  if (q.status) (where.push("d.status = ?"), params.push(q.status));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const items = await query<DocumentRow>(`${DOC_SELECT} ${whereSql} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`, [...params, q.pageSize, offsetOf(q)]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM documents d ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findDocument = (id: number) => queryOne<DocumentRow>(`${DOC_SELECT} WHERE d.id = ?`, [id]);

export async function setDocumentStatus(id: number, status: DocumentStatus, reviewerId: number, conn: PoolConnection) {
  await execute(`UPDATE documents SET status = ?, reviewed_by = IF(? = 'new', NULL, ?) WHERE id = ?`, [status, status, reviewerId, id], conn);
}

export async function insertDocument(input: StaffUploadInput, file: { key: string; name: string; mime: string; size: number }, uploaderId: number, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO documents (client_id, task_id, uploaded_by, category, period, file_path, file_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.client_id, input.task_id ?? null, uploaderId, input.category, input.period ?? null, file.key, file.name, file.mime, file.size],
    conn,
  );
  return r.insertId;
}

// ── Requests ──
const REQUEST_FROM = `FROM document_requests r JOIN clients c ON c.id = r.client_id LEFT JOIN users u ON u.id = r.requested_by`;
const REQUEST_COLUMNS = `r.id, r.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, r.description,
       u.email AS requested_by_email, r.due_date, r.period, r.status, r.task_id, r.created_at`;

export async function listRequests(q: RequestListQuery, scope: Scope): Promise<Paged<DocumentRequestRow>> {
  const where = ["r.status = ?", scope.sql];
  const params: Param[] = [q.status, ...scope.params];
  if (q.client_id) (where.push("r.client_id = ?"), params.push(q.client_id));
  if (q.q) (where.push("(r.description LIKE ? OR c.legal_name LIKE ? OR c.trade_name LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const items = await query<DocumentRequestRow>(
    `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} ${whereSql} ORDER BY r.due_date IS NULL, r.due_date, r.id DESC LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${REQUEST_FROM} ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findRequest = (id: number, db?: PoolConnection) =>
  queryOne<DocumentRequestRow>(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE r.id = ?${db ? " FOR UPDATE" : ""}`, [id], db);

export async function insertRequest(input: CreateRequestInput, requesterId: number, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO document_requests (client_id, task_id, requested_by, description, due_date, period) VALUES (?, ?, ?, ?, ?, ?)`,
    [input.client_id, input.task_id, requesterId, input.description, input.due_date, input.period],
    conn,
  );
  return r.insertId;
}

export async function cancelRequest(id: number, conn: PoolConnection) {
  await execute(`UPDATE document_requests SET status = 'cancelled' WHERE id = ? AND status = 'open'`, [id], conn);
}

export const taskBelongsToClient = async (taskId: number, clientId: number) =>
  !!(await queryOne<{ id: number }>(`SELECT id FROM tasks WHERE id = ? AND client_id = ?`, [taskId, clientId]));
