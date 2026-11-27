import { query, queryOne, type Param } from "../../database/connection.js";
import { activeAssignmentSql } from "../access/client-access.js";

/** Task statuses that still need work from the assignee. */
const OPEN = `('todo','in_progress','returned')`;

/** A month as a half-open date range: [start, next month's start). */
export interface MonthRange {
  start: string;
  end: string;
}

/**
 * Headline numbers per staff member. Open, overdue and review counts are as of today;
 * approved, returned and time logged are for the chosen month.
 */
const SUMMARY = `
  SELECT u.id AS user_id, u.full_name, u.email, u.portal_role, u.status, sp.staff_type,
         (SELECT COUNT(DISTINCT a.client_id) FROM assignments a WHERE a.user_id = u.id AND ${activeAssignmentSql("a")}) AS active_clients,
         (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status IN ${OPEN}) AS open_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status IN ${OPEN} AND t.due_date < CURDATE()) AS overdue,
         (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status = 'submitted') AS awaiting_review,
         (SELECT COUNT(*) FROM tasks t WHERE t.reviewer_id = u.id AND t.status = 'submitted') AS to_review,
         (SELECT COUNT(*) FROM task_reviews tr JOIN tasks t ON t.id = tr.task_id
           WHERE t.assignee_id = u.id AND tr.decision = 'approved' AND tr.created_at >= ? AND tr.created_at < ?) AS approved,
         (SELECT COUNT(*) FROM task_reviews tr JOIN tasks t ON t.id = tr.task_id
           WHERE t.assignee_id = u.id AND tr.decision = 'returned' AND tr.created_at >= ? AND tr.created_at < ?) AS returned,
         (SELECT COALESCE(SUM(w.minutes), 0) FROM work_logs w WHERE w.user_id = u.id AND w.logged_on >= ? AND w.logged_on < ?) AS minutes
    FROM users u JOIN staff_profiles sp ON sp.user_id = u.id`;

export interface SummaryRow {
  user_id: number;
  full_name: string;
  email: string;
  portal_role: string;
  status: string;
  staff_type: string;
  active_clients: number;
  open_tasks: number;
  overdue: number;
  awaiting_review: number;
  to_review: number;
  approved: number;
  returned: number;
  minutes: number;
}

const rangeParams = (m: MonthRange): Param[] => [m.start, m.end, m.start, m.end, m.start, m.end];

export const listSummaries = (m: MonthRange) =>
  query<SummaryRow>(`${SUMMARY} WHERE u.status = 'active' ORDER BY u.full_name`, rangeParams(m));

export const findSummary = (userId: number, m: MonthRange) =>
  queryOne<SummaryRow>(`${SUMMARY} WHERE u.id = ?`, [...rangeParams(m), userId]);

/** Each client the person is currently assigned to, with their own tasks there. */
export const clientBreakdown = (userId: number, period: string) =>
  query<{
    client_id: number;
    client_name: string;
    roles: string;
    period_total: number;
    period_approved: number;
    open_tasks: number;
    overdue: number;
    awaiting_review: number;
  }>(
    `SELECT c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, x.roles,
            COALESCE(SUM(t.period = ?), 0) AS period_total,
            COALESCE(SUM(t.period = ? AND t.status = 'approved'), 0) AS period_approved,
            COALESCE(SUM(t.status IN ${OPEN}), 0) AS open_tasks,
            COALESCE(SUM(t.status IN ${OPEN} AND t.due_date < CURDATE()), 0) AS overdue,
            COALESCE(SUM(t.status = 'submitted'), 0) AS awaiting_review
       FROM (SELECT a.client_id, GROUP_CONCAT(DISTINCT a.team_role ORDER BY a.team_role) AS roles
               FROM assignments a WHERE a.user_id = ? AND ${activeAssignmentSql("a")} GROUP BY a.client_id) x
       JOIN clients c ON c.id = x.client_id
       LEFT JOIN tasks t ON t.client_id = c.id AND t.assignee_id = ?
      GROUP BY c.id, c.trade_name, c.legal_name, x.roles
      ORDER BY client_name`,
    [period, period, userId, userId],
  );

/** Approved and returned reviews, and time logged, per month from `from` (inclusive) to `to` (exclusive). */
export async function monthlyTrend(userId: number, from: string, to: string) {
  const [reviews, time] = await Promise.all([
    query<{ month: string; approved: number; returned: number }>(
      `SELECT DATE_FORMAT(tr.created_at, '%Y-%m') AS month,
              SUM(tr.decision = 'approved') AS approved, SUM(tr.decision = 'returned') AS returned
         FROM task_reviews tr JOIN tasks t ON t.id = tr.task_id
        WHERE t.assignee_id = ? AND tr.created_at >= ? AND tr.created_at < ?
        GROUP BY month`,
      [userId, from, to],
    ),
    query<{ month: string; minutes: number }>(
      `SELECT DATE_FORMAT(w.logged_on, '%Y-%m') AS month, SUM(w.minutes) AS minutes
         FROM work_logs w WHERE w.user_id = ? AND w.logged_on >= ? AND w.logged_on < ?
        GROUP BY month`,
      [userId, from, to],
    ),
  ]);
  return { reviews, time };
}

/** Work still with the person (open or waiting for review): overdue first, then by due date. */
export const openTasks = (userId: number) =>
  query<{ id: number; title: string; client_id: number; client_name: string; period: string; status: string; due_date: string | null; overdue: number }>(
    `SELECT t.id, t.title, t.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, t.period, t.status,
            DATE_FORMAT(t.due_date, '%Y-%m-%d') AS due_date,
            (t.status IN ${OPEN} AND t.due_date < CURDATE()) AS overdue
       FROM tasks t JOIN clients c ON c.id = t.client_id
      WHERE t.assignee_id = ? AND t.status IN ('todo','in_progress','returned','submitted')
      ORDER BY overdue DESC, t.due_date IS NULL, t.due_date, t.id
      LIMIT 50`,
    [userId],
  );

/** The latest review decisions on the person's tasks. */
export const recentReviews = (userId: number) =>
  query<{ id: number; task_id: number; task_title: string; client_name: string; decision: string; comments: string | null; reviewer_name: string | null; created_at: string }>(
    `SELECT tr.id, t.id AS task_id, t.title AS task_title, COALESCE(c.trade_name, c.legal_name) AS client_name,
            tr.decision, tr.comments, r.full_name AS reviewer_name, tr.created_at
       FROM task_reviews tr
       JOIN tasks t ON t.id = tr.task_id
       JOIN clients c ON c.id = t.client_id
       LEFT JOIN users r ON r.id = tr.reviewer_id
      WHERE t.assignee_id = ?
      ORDER BY tr.created_at DESC, tr.id DESC
      LIMIT 10`,
    [userId],
  );
