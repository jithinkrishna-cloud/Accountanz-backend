import { query, queryOne } from "../../database/connection.js";

const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** The analytics window: its 'YYYY-MM' months and the dates [start, end) they span. */
export interface Window {
  months: string[];
  start: string;
  end: string;
}

/** Invoices that count as billed: not drafts, not cancelled. */
const BILLED = `si.status NOT IN ('draft', 'cancelled')`;

// ───────────────────────────── Revenue ─────────────────────────────

/** Invoice totals per billing period. */
export const billedByMonth = (w: Window) =>
  query<{ month: string; total: number }>(
    `SELECT si.period AS month, SUM(si.total) AS total FROM service_invoices si
      WHERE ${BILLED} AND si.period IN (${inList(w.months.length)}) GROUP BY si.period`,
    w.months,
  );

/** Payments received per month, by payment date. */
export const collectedByMonth = (w: Window) =>
  query<{ month: string; total: number }>(
    `SELECT DATE_FORMAT(paid_date, '%Y-%m') AS month, SUM(amount) AS total FROM service_payments
      WHERE paid_date >= ? AND paid_date < ? GROUP BY month`,
    [w.start, w.end],
  );

/** What clients owe today, and how much of it is past its due date. Not limited to the window. */
export const receivables = () =>
  queryOne<{ outstanding: number; overdue: number; overdue_invoices: number }>(
    `SELECT COALESCE(SUM(due), 0) AS outstanding,
            COALESCE(SUM(CASE WHEN due_date < CURDATE() THEN due END), 0) AS overdue,
            COALESCE(SUM(due_date < CURDATE() AND due > 0), 0) AS overdue_invoices
       FROM (SELECT si.due_date, si.total - COALESCE((SELECT SUM(sp.amount) FROM service_payments sp WHERE sp.invoice_id = si.id), 0) AS due
               FROM service_invoices si WHERE si.status IN ('issued', 'overdue')) x`,
  );

/** The clients billed most in the window. */
export const topClientsByBilling = (w: Window, limit = 8) =>
  query<{ client_id: number; client_name: string; total: number }>(
    `SELECT c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, SUM(si.total) AS total
       FROM service_invoices si JOIN engagements e ON e.id = si.engagement_id JOIN clients c ON c.id = e.client_id
      WHERE ${BILLED} AND si.period IN (${inList(w.months.length)})
      GROUP BY c.id, c.trade_name, c.legal_name ORDER BY total DESC LIMIT ?`,
    [...w.months, limit],
  );

/** Active engagements per package, with the monthly fees they carry. */
export const activePackages = () =>
  query<{ package_id: number; name: string; clients: number; monthly_fees: number }>(
    `SELECT p.id AS package_id, p.name, COUNT(*) AS clients, SUM(p.monthly_fee) AS monthly_fees
       FROM engagements e JOIN packages p ON p.id = e.package_id
      WHERE e.status = 'active' GROUP BY p.id, p.name ORDER BY monthly_fees DESC`,
  );

// ───────────────────────────── Delivery ─────────────────────────────

/**
 * Per month (by review date): tasks approved, first reviews and how many of those were approved first time,
 * average days from submission to decision, and approved tasks with a due date / submitted by it.
 */
export const deliveryByMonth = (w: Window) =>
  query<{ month: string; approved: number; first_reviews: number; first_approved: number; turnaround_hours: number | null; with_due: number; on_time: number }>(
    `SELECT DATE_FORMAT(tr.created_at, '%Y-%m') AS month,
            SUM(tr.decision = 'approved') AS approved,
            SUM(tr.submission_number = 1) AS first_reviews,
            SUM(tr.submission_number = 1 AND tr.decision = 'approved') AS first_approved,
            AVG(CASE WHEN t.submitted_at IS NOT NULL AND tr.created_at >= t.submitted_at THEN TIMESTAMPDIFF(HOUR, t.submitted_at, tr.created_at) END) AS turnaround_hours,
            SUM(tr.decision = 'approved' AND t.due_date IS NOT NULL) AS with_due,
            SUM(tr.decision = 'approved' AND t.due_date IS NOT NULL AND DATE(t.submitted_at) <= t.due_date) AS on_time
       FROM task_reviews tr JOIN tasks t ON t.id = tr.task_id
      WHERE tr.created_at >= ? AND tr.created_at < ?
      GROUP BY month`,
    [w.start, w.end],
  );

/** Average hours from submission to review decision across the whole window. */
export const avgReviewHours = (w: Window) =>
  queryOne<{ hours: number | null }>(
    `SELECT AVG(TIMESTAMPDIFF(HOUR, t.submitted_at, tr.created_at)) AS hours
       FROM task_reviews tr JOIN tasks t ON t.id = tr.task_id
      WHERE t.submitted_at IS NOT NULL AND tr.created_at >= t.submitted_at AND tr.created_at >= ? AND tr.created_at < ?`,
    [w.start, w.end],
  );

/** Hours logged per month. */
export const minutesByMonth = (w: Window) =>
  query<{ month: string; minutes: number }>(
    `SELECT DATE_FORMAT(logged_on, '%Y-%m') AS month, SUM(minutes) AS minutes FROM work_logs
      WHERE logged_on >= ? AND logged_on < ? GROUP BY month`,
    [w.start, w.end],
  );

/** Each assignee's approvals per month, first-review outcomes and on-time deliveries in the window. */
export const deliveryByPerson = (w: Window) =>
  query<{ user_id: number; full_name: string; month: string; approved: number; first_reviews: number; first_approved: number; with_due: number; on_time: number }>(
    `SELECT u.id AS user_id, u.full_name, DATE_FORMAT(tr.created_at, '%Y-%m') AS month,
            SUM(tr.decision = 'approved') AS approved,
            SUM(tr.submission_number = 1) AS first_reviews,
            SUM(tr.submission_number = 1 AND tr.decision = 'approved') AS first_approved,
            SUM(tr.decision = 'approved' AND t.due_date IS NOT NULL) AS with_due,
            SUM(tr.decision = 'approved' AND t.due_date IS NOT NULL AND DATE(t.submitted_at) <= t.due_date) AS on_time
       FROM task_reviews tr JOIN tasks t ON t.id = tr.task_id JOIN users u ON u.id = t.assignee_id
      WHERE tr.created_at >= ? AND tr.created_at < ?
      GROUP BY u.id, u.full_name, month`,
    [w.start, w.end],
  );

/** Hours each person logged in the window. */
export const minutesByPerson = (w: Window) =>
  query<{ user_id: number; minutes: number }>(
    `SELECT user_id, SUM(minutes) AS minutes FROM work_logs WHERE logged_on >= ? AND logged_on < ? GROUP BY user_id`,
    [w.start, w.end],
  );

// ───────────────────────────── Clients ─────────────────────────────

export const clientsByStatus = () =>
  query<{ status: string; count: number }>(`SELECT status, COUNT(*) AS count FROM clients GROUP BY status ORDER BY count DESC`);

/** Clients added per month. */
export const newClientsByMonth = (w: Window) =>
  query<{ month: string; n: number }>(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS n FROM clients WHERE created_at >= ? AND created_at < ? GROUP BY month`,
    [w.start, w.end],
  );

/** Month-end: per period, how many clients' months are closed. */
export const closedByMonth = (w: Window) =>
  query<{ month: string; closed: number }>(
    `SELECT period AS month, COUNT(*) AS closed FROM period_closings
      WHERE status = 'closed' AND period IN (${inList(w.months.length)}) GROUP BY period`,
    w.months,
  );
