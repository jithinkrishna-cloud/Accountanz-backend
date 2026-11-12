import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne } from "../../database/connection.js";
import { activeAssignmentSql, REVIEWER_TEAM_ROLES } from "../access/client-access.js";
import type { AccountantQuality, ReviewDecision, ReviewQueueItem, TaskForReview } from "./review.types.js";

/**
 * Submitted tasks, longest wait first. With `reviewerId`, only clients where that person holds a
 * reviewer-type assignment today, and never tasks they did themselves.
 */
export function listReviewQueue(reviewerId?: number) {
  const scope = reviewerId
    ? `AND t.assignee_id <> ? AND t.client_id IN (
         SELECT a.client_id FROM assignments a
          WHERE a.user_id = ? AND a.team_role IN (${REVIEWER_TEAM_ROLES.map(() => "?").join(",")}) AND ${activeAssignmentSql("a")})`
    : "";
  const params = reviewerId ? [reviewerId, reviewerId, ...REVIEWER_TEAM_ROLES] : [];
  return query<ReviewQueueItem>(
    `SELECT t.id AS task_id, t.title, t.period, t.due_date, t.submitted_at,
            c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name,
            t.assignee_id, a.email AS assignee_email, r.email AS reviewer_email,
            GREATEST(TIMESTAMPDIFF(DAY, COALESCE(t.submitted_at, t.updated_at), UTC_TIMESTAMP()), 0) AS waiting_days
       FROM tasks t
       JOIN clients c ON c.id = t.client_id
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN users r ON r.id = t.reviewer_id
      WHERE t.status = 'submitted' ${scope}
      ORDER BY COALESCE(t.submitted_at, t.updated_at) ASC, t.id ASC`,
    params,
  );
}

/** Per assignee: first-submission reviews, how many were approved, and how many were returned. */
export function listAccountantQuality() {
  return query<AccountantQuality>(
    `SELECT u.id AS user_id, u.full_name,
            COUNT(*) AS first_submissions,
            SUM(tr.decision = 'approved') AS approved_first,
            SUM(tr.decision = 'returned') AS returns,
            ROUND(100 * SUM(tr.decision = 'approved') / COUNT(*)) AS approved_first_pct
       FROM task_reviews tr
       JOIN tasks t ON t.id = tr.task_id
       JOIN users u ON u.id = t.assignee_id
      WHERE tr.submission_number = 1
      GROUP BY u.id, u.full_name
      ORDER BY approved_first_pct DESC, u.full_name`,
  );
}

export function findTaskForUpdate(taskId: number, conn: PoolConnection) {
  return queryOne<TaskForReview>(
    `SELECT id, client_id, title, period, status, assignee_id FROM tasks WHERE id = ? FOR UPDATE`,
    [taskId],
    conn,
  );
}

export async function nextSubmissionNumber(taskId: number, conn: PoolConnection) {
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM task_reviews WHERE task_id = ?`, [taskId], conn);
  return (row?.n ?? 0) + 1;
}

export async function insertReview(
  r: { taskId: number; reviewerId: number; decision: ReviewDecision; comments: string | null; submissionNumber: number },
  conn: PoolConnection,
) {
  await execute(
    `INSERT INTO task_reviews (task_id, reviewer_id, decision, comments, submission_number) VALUES (?, ?, ?, ?, ?)`,
    [r.taskId, r.reviewerId, r.decision, r.comments, r.submissionNumber],
    conn,
  );
}

/** Records the decision on the task; the actual reviewer becomes the task's reviewer. */
export async function setTaskDecision(taskId: number, decision: ReviewDecision, reviewerId: number, conn: PoolConnection) {
  await execute(`UPDATE tasks SET status = ?, reviewer_id = ? WHERE id = ?`, [decision, reviewerId, taskId], conn);
}
