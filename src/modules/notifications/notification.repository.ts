import { query, queryOne } from "../../database/connection.js";
import { activeAssignmentSql } from "../access/client-access.js";

export interface Contact {
  email: string;
  full_name: string;
}

export const findActiveContact = (userId: number | null) =>
  userId ? queryOne<Contact>(`SELECT email, full_name FROM users WHERE id = ? AND status = 'active'`, [userId]) : Promise.resolve(null);

/** Client portal users who should hear about billing: owners, plus anyone allowed to approve. */
export const listBillingContacts = (clientId: number) =>
  query<Contact>(
    `SELECT u.email, u.full_name FROM client_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.client_id = ? AND u.status = 'active' AND (cu.role = 'owner' OR cu.can_approve = 1)`,
    [clientId],
  );

export const countReviews = async (taskId: number) =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM task_reviews WHERE task_id = ?`, [taskId]))?.n ?? 0;

export function findInvoiceForEmail(invoiceId: number) {
  return queryOne<{ id: number; invoice_number: string; period: string; amount: number; gst_amount: number; total: number; due_date: string; client_id: number; client_name: string }>(
    `SELECT i.id, i.invoice_number, i.period, i.amount, i.gst_amount, i.total, i.due_date, c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name
       FROM service_invoices i JOIN engagements e ON e.id = i.engagement_id JOIN clients c ON c.id = e.client_id
      WHERE i.id = ?`,
    [invoiceId],
  );
}

/** The client's accounting team today (who should hear about client messages). */
export const listClientTeamContacts = (clientId: number) =>
  query<Contact>(
    `SELECT DISTINCT u.email, u.full_name FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")} AND u.status = 'active'`,
    [clientId],
  );
