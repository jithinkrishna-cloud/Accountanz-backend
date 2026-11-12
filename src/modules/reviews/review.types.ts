export const REVIEW_DECISIONS = ["approved", "returned"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** A submitted task waiting on a reviewer. */
export interface ReviewQueueItem {
  task_id: number;
  title: string;
  period: string;
  due_date: string | null;
  submitted_at: string | null;
  client_id: number;
  client_name: string;
  assignee_id: number | null;
  assignee_email: string | null;
  reviewer_email: string | null;
  /** Whole days since submission. */
  waiting_days: number;
}

/** First-submission quality per accountant: how often their work is approved without a return. */
export interface AccountantQuality {
  user_id: number;
  full_name: string;
  first_submissions: number;
  approved_first: number;
  returns: number;
  approved_first_pct: number;
}

export interface TaskForReview {
  id: number;
  client_id: number;
  title: string;
  period: string;
  status: string;
  assignee_id: number | null;
}
