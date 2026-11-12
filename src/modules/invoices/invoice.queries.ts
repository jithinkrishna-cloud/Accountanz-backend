import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { InvoiceRow, InvoiceStatus, InvoiceSummary } from "./invoice.types.js";
import type { InvoiceListQuery } from "./invoice.validation.js";

/** Read side for the invoices screen. Issuing lives in invoice.repository.ts (shared with engagements). */
const FROM = `
  FROM service_invoices i
  JOIN engagements e ON e.id = i.engagement_id
  JOIN clients c ON c.id = e.client_id
  LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM service_payments GROUP BY invoice_id) p ON p.invoice_id = i.id`;

const SELECT = `
  SELECT i.id, i.invoice_number, i.engagement_id, c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name,
         i.period, i.amount, i.gst_amount, i.total, i.due_date, i.status, COALESCE(p.paid, 0) AS paid_amount`;

export async function listInvoices(q: InvoiceListQuery): Promise<Paged<InvoiceRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) (where.push("i.invoice_number LIKE ?"), params.push(`%${q.q}%`));
  if (q.client_id) (where.push("c.id = ?"), params.push(q.client_id));
  if (q.status) (where.push("i.status = ?"), params.push(q.status));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<InvoiceRow>(`${SELECT} ${FROM} ${whereSql} ORDER BY i.period DESC, i.invoice_number DESC LIMIT ? OFFSET ?`, [
    ...params,
    q.pageSize,
    offsetOf(q),
  ]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findInvoiceById = (id: number, db?: PoolConnection) => queryOne<InvoiceRow>(`${SELECT} ${FROM} WHERE i.id = ?`, [id], db);

/** Billed = all non-cancelled invoices; collected = payments received; outstanding = the difference. */
export async function invoiceSummary(): Promise<InvoiceSummary> {
  const row = await queryOne<{ billed: number; collected: number }>(
    `SELECT (SELECT COALESCE(SUM(total), 0) FROM service_invoices WHERE status NOT IN ('cancelled', 'draft')) AS billed,
            (SELECT COALESCE(SUM(sp.amount), 0) FROM service_payments sp JOIN service_invoices si ON si.id = sp.invoice_id WHERE si.status <> 'cancelled') AS collected`,
  );
  const billed = row?.billed ?? 0;
  const collected = row?.collected ?? 0;
  return { billed, collected, outstanding: Math.round((billed - collected) * 100) / 100 };
}

export function findEngagementForInvoice(engagementId: number) {
  return queryOne<{ id: number; client_id: number; status: string; client_name: string }>(
    `SELECT e.id, e.client_id, e.status, COALESCE(c.trade_name, c.legal_name) AS client_name
       FROM engagements e JOIN clients c ON c.id = e.client_id WHERE e.id = ?`,
    [engagementId],
  );
}

export const invoiceExistsForPeriod = async (engagementId: number, period: string) =>
  !!(await queryOne<{ id: number }>(`SELECT id FROM service_invoices WHERE engagement_id = ? AND period = ?`, [engagementId, period]));

export async function setInvoiceStatus(id: number, status: InvoiceStatus, conn: PoolConnection) {
  await execute(`UPDATE service_invoices SET status = ? WHERE id = ?`, [status, id], conn);
}
