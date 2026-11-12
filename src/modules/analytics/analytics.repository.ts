import { query, queryOne } from "../../database/connection.js";

const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** Average days from submission to review decision, for reviews in the window. */
export async function avgReviewTurnaroundDays(months: string[]) {
  const row = await queryOne<{ days: number | null }>(
    `SELECT AVG(TIMESTAMPDIFF(HOUR, t.submitted_at, tr.created_at)) / 24 AS days
       FROM task_reviews tr JOIN tasks t ON t.id = tr.task_id
      WHERE t.submitted_at IS NOT NULL AND tr.created_at >= t.submitted_at
        AND DATE_FORMAT(tr.created_at, '%Y-%m') IN (${inList(months.length)})`,
    months,
  );
  return row?.days ?? 0;
}

export function approvalsByAccountantMonth(months: string[]) {
  return query<{ user_id: number; full_name: string; month: string; n: number }>(
    `SELECT u.id AS user_id, u.full_name, DATE_FORMAT(tr.created_at, '%Y-%m') AS month, COUNT(*) AS n
       FROM task_reviews tr JOIN tasks t ON t.id = tr.task_id JOIN users u ON u.id = t.assignee_id
      WHERE tr.decision = 'approved' AND DATE_FORMAT(tr.created_at, '%Y-%m') IN (${inList(months.length)})
      GROUP BY u.id, u.full_name, month`,
    months,
  );
}

export function revenueByMonth(months: string[]) {
  return query<{ period: string; total: number }>(
    `SELECT period, SUM(total) AS total FROM service_invoices
      WHERE status NOT IN ('cancelled', 'draft') AND period IN (${inList(months.length)}) GROUP BY period`,
    months,
  );
}

export async function revenueBooked() {
  return (await queryOne<{ total: number }>(`SELECT COALESCE(SUM(total), 0) AS total FROM service_invoices WHERE status NOT IN ('cancelled', 'draft')`))?.total ?? 0;
}

export const clientsByStatus = () =>
  query<{ status: string; count: number }>(`SELECT status, COUNT(*) AS count FROM clients GROUP BY status ORDER BY count DESC`);
