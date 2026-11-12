export const TASK_STATUSES = ["todo", "in_progress", "submitted", "returned", "approved"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_SOURCES = ["template", "manual"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

/** Statuses in which the assignee can still work on (and the manager still edit) a task. */
export const OPEN_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "returned"];

export interface TaskListRow {
  id: number;
  title: string;
  period: string;
  status: TaskStatus;
  due_date: string | null;
  client_id: number;
  client_name: string;
  assignee_id: number | null;
  assignee_email: string | null;
  reviewer_email: string | null;
  client_visible: boolean;
  source: TaskSource;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface TaskRecord {
  id: number;
  client_id: number;
  client_name: string;
  engagement_id: number | null;
  template_item_id: number | null;
  creation_source: TaskSource;
  period: string;
  title: string;
  description: string | null;
  checklist: ChecklistItem[];
  status: TaskStatus;
  due_date: string | null;
  client_visible: boolean;
  submitted_at: string | null;
  assignee_id: number | null;
  assignee_name: string | null;
  reviewer_id: number | null;
  reviewer_name: string | null;
  created_by_email: string | null;
}

export interface TaskDetail extends TaskRecord {
  work_logs: { id: number; user_email: string; minutes: number; note: string | null; logged_on: string }[];
  reviews: { decision: "approved" | "returned"; comments: string | null; reviewer_email: string | null; submission_number: number; created_at: string }[];
  /** What the current user may do, so both portals show the same controls the API allows. */
  permissions: { can_edit: boolean; can_work: boolean; can_submit: boolean; can_log_time: boolean; can_review: boolean };
}

export interface TaskOptions {
  clients: { id: number; name: string }[];
  engagements: { id: number; package_name: string }[];
  assignees: { user_id: number; full_name: string; team_role: string }[];
  reviewers: { user_id: number; full_name: string; role: string }[];
}

/** One task to create: an engagement × template item for the period. */
export interface GenerationCandidate {
  client_id: number;
  engagement_id: number;
  template_item_id: number;
  title: string;
  checklist: string[];
  client_visible: 0 | 1;
  due_day_of_period: number;
  recurrence: "monthly" | "quarterly" | "annual";
}

export interface GenerationResult {
  period: string;
  engagements: number;
  created: number;
  skipped: number;
  /** Clients whose period is closed: no tasks are generated into a closed month. */
  closed_clients_skipped: number;
}
