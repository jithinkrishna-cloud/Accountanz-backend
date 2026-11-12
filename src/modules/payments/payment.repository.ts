import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { OpenInvoice, PaymentRow } from "./payment.types.js";
import type { PaymentListQuery, RecordPaymentInput } from "./payment.validation.js";

const FROM = `
  FROM service_payments sp
  JOIN service_invoices i ON i.id = sp.invoice_id
  JOIN engagements e ON e.id = i.engagement_id
  JOIN clients c ON c.id = e.client_id`;

export async function listPayments(q: PaymentListQuery): Promise<Paged<PaymentRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) (where.push("(sp.reference LIKE ? OR i.invoice_number LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`));
  if (q.method) (where.push("sp.method = ?"), params.push(q.method));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<PaymentRow>(
    `SELECT sp.id, sp.invoice_id, i.invoice_number, COALESCE(c.trade_name, c.legal_name) AS client_name,
            sp.amount, sp.paid_date, sp.method, sp.reference
       ${FROM} ${whereSql} ORDER BY sp.paid_date DESC, sp.id DESC LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

const OPEN_SELECT = `
  SELECT i.id, i.invoice_number, COALESCE(c.trade_name, c.legal_name) AS client_name, i.total,
         i.total - COALESCE((SELECT SUM(amount) FROM service_payments WHERE invoice_id = i.id), 0) AS balance
    FROM service_invoices i JOIN engagements e ON e.id = i.engagement_id JOIN clients c ON c.id = e.client_id
   WHERE i.status IN ('issued', 'overdue')`;

export const listOpenInvoices = () => query<OpenInvoice>(`${OPEN_SELECT} ORDER BY i.due_date, i.invoice_number`);

/** Locks the invoice row so concurrent payments can't both pass the balance check. */
export function lockInvoice(id: number, conn: PoolConnection) {
  return queryOne<OpenInvoice & { status: string; client_id: number }>(
    `SELECT i.id, i.invoice_number, i.status, i.total, e.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name,
            i.total - COALESCE((SELECT SUM(amount) FROM service_payments WHERE invoice_id = i.id), 0) AS balance
       FROM service_invoices i JOIN engagements e ON e.id = i.engagement_id JOIN clients c ON c.id = e.client_id
      WHERE i.id = ? FOR UPDATE`,
    [id],
    conn,
  );
}

export async function insertPayment(p: RecordPaymentInput, recordedBy: number, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO service_payments (invoice_id, amount, paid_date, method, reference, recorded_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [p.invoice_id, p.amount, p.paid_date, p.method, p.reference, recordedBy],
    conn,
  );
  return r.insertId;
}

export async function markInvoicePaid(id: number, conn: PoolConnection) {
  await execute(`UPDATE service_invoices SET status = 'paid' WHERE id = ?`, [id], conn);
}
