import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { Scope } from "../documents/document.repository.js";
import type { ReportRow } from "./report.types.js";
import type { CreateReportInput, ReportListQuery } from "./report.validation.js";

const SELECT = `
  SELECT r.id, r.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, r.period, r.report_type,
         r.file_name, r.file_path, r.summary, pu.full_name AS prepared_by_name, au.full_name AS approved_by_name,
         r.published_date, r.created_at
    FROM published_reports r JOIN clients c ON c.id = r.client_id
    LEFT JOIN users pu ON pu.id = r.prepared_by LEFT JOIN users au ON au.id = r.approved_by`;

export async function listReports(q: ReportListQuery, scope: Scope): Promise<Paged<ReportRow>> {
  const where = [scope.sql];
  const params: Param[] = [...scope.params];
  if (q.client_id) (where.push("r.client_id = ?"), params.push(q.client_id));
  if (q.state === "draft") where.push("r.published_date IS NULL");
  if (q.state === "published") where.push("r.published_date IS NOT NULL");
  if (q.q) (where.push("(c.legal_name LIKE ? OR c.trade_name LIKE ? OR r.summary LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const items = await query<ReportRow>(
    `${SELECT} ${whereSql} ORDER BY r.published_date IS NOT NULL, r.period DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM published_reports r JOIN clients c ON c.id = r.client_id ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findReport = (id: number, db?: PoolConnection) => queryOne<ReportRow>(`${SELECT} WHERE r.id = ?${db ? " FOR UPDATE" : ""}`, [id], db);

export async function insertReport(input: CreateReportInput, file: { key: string; name: string } | null, preparerId: number, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO published_reports (client_id, period, report_type, file_path, file_name, summary, prepared_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.client_id, input.period, input.report_type, file?.key ?? null, file?.name ?? null, input.summary, preparerId],
    conn,
  );
  return r.insertId;
}

export async function publish(id: number, approverId: number, conn: PoolConnection) {
  await execute(`UPDATE published_reports SET approved_by = ?, published_date = CURDATE() WHERE id = ?`, [approverId, id], conn);
}

export async function unpublish(id: number, conn: PoolConnection) {
  await execute(`UPDATE published_reports SET approved_by = NULL, published_date = NULL WHERE id = ?`, [id], conn);
}

export async function deleteReport(id: number, conn: PoolConnection) {
  await execute(`DELETE FROM published_reports WHERE id = ?`, [id], conn);
}
