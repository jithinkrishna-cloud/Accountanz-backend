export interface AnalyticsOverview {
  /** Oldest → newest 'YYYY-MM' periods covered by the charts. */
  months: string[];
  avg_review_turnaround_days: number;
  tasks_approved: number;
  revenue_booked: number;
  /** Approved tasks per accountant per month (by approval date). */
  tasks_by_accountant: { user_id: number; full_name: string; counts: number[] }[];
  /** Invoice totals raised per month. */
  revenue_by_month: number[];
  clients_by_status: { status: string; count: number }[];
}
