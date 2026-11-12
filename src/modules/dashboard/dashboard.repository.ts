import { query, queryOne } from "../../database/connection.js";

export async function clientCounts() {
  return (await queryOne<{ active: number; onboarding: number; paused: number }>(
    `SELECT COALESCE(SUM(status = 'active'), 0) AS active,
            COALESCE(SUM(status = 'onboarding'), 0) AS onboarding,
            COALESCE(SUM(status = 'paused'), 0) AS paused
       FROM clients`,
  ))!;
}

export async function engagementCounts() {
  return (await queryOne<{ active: number; draft: number; sent: number }>(
    `SELECT COALESCE(SUM(status = 'active'), 0) AS active,
            COALESCE(SUM(status = 'draft'), 0) AS draft,
            COALESCE(SUM(status = 'sent'), 0) AS sent
       FROM engagements`,
  ))!;
}

export async function taskCounts(period: string) {
  return (await queryOne<{ overdue: number; approved: number; total: number }>(
    `SELECT (SELECT COUNT(*) FROM tasks WHERE status <> 'approved' AND due_date < CURDATE()) AS overdue,
            COALESCE(SUM(status = 'approved'), 0) AS approved,
            COUNT(*) AS total
       FROM tasks WHERE period = ?`,
    [period],
  ))!;
}

export async function reviewCounts() {
  return (await queryOne<{ waiting: number; overTwoDays: number }>(
    `SELECT COUNT(*) AS waiting,
            COALESCE(SUM(submitted_at < UTC_TIMESTAMP() - INTERVAL 2 DAY), 0) AS overTwoDays
       FROM tasks WHERE status = 'submitted'`,
  ))!;
}

/** Billed = invoice totals raised for the period; outstanding = unpaid balance across all issued invoices. */
export async function revenue(period: string) {
  return (await queryOne<{ billed: number; outstanding: number; openInvoices: number }>(
    `SELECT (SELECT COALESCE(SUM(total), 0) FROM service_invoices WHERE period = ? AND status <> 'cancelled') AS billed,
            COALESCE(SUM(i.total - COALESCE(p.paid, 0)), 0) AS outstanding,
            COUNT(*) AS openInvoices
       FROM service_invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM service_payments GROUP BY invoice_id) p ON p.invoice_id = i.id
      WHERE i.status IN ('issued', 'overdue')`,
    [period],
  ))!;
}

/** Clients whose current-period tasks are under half approved. */
export function behindOnClosing(period: string) {
  return query<{ client_id: number; client_name: string; approved: number; total: number }>(
    `SELECT c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name,
            SUM(t.status = 'approved') AS approved, COUNT(*) AS total
       FROM tasks t JOIN clients c ON c.id = t.client_id
      WHERE t.period = ? AND c.status = 'active'
      GROUP BY c.id, client_name
     HAVING SUM(t.status = 'approved') < COUNT(*) / 2
      ORDER BY SUM(t.status = 'approved') / COUNT(*)`,
    [period],
  );
}
