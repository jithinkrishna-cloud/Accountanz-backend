export const CLOSING_STATUSES = ["open", "ready", "closed"] as const;
export type ClosingStatus = (typeof CLOSING_STATUSES)[number];

export interface ClosingCell {
  status: ClosingStatus;
  approved: number;
  total: number;
  closed_by_email: string | null;
  closed_at: string | null;
  ready_override: string | null;
}

export interface ClosingRow {
  client_id: number;
  client_name: string;
  client_status: string;
  cells: Record<string, ClosingCell>;
}

export interface ClosingGrid {
  periods: string[];
  rows: ClosingRow[];
}

/** Raw month-end checklist facts for one client and period (counts come back from MySQL as numbers or strings). */
export interface ChecklistRow {
  client_id: number;
  client_name: string;
  closing_status: ClosingStatus;
  ready_override: string | null;
  tasks_total: number;
  tasks_approved: number;
  tasks_submitted: number;
  open_requests: number;
  pending_approvals: number;
  reports_published: number;
  reports_draft: number;
}
