export const ANALYTICS_RANGES = [3, 6, 12] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** A share as a whole percent, or null when there was nothing to measure. */
export type Rate = number | null;

export interface AnalyticsOverview {
  /** Oldest → newest 'YYYY-MM' months the page covers. */
  months: string[];
  range: AnalyticsRange;
  summary: {
    billed: number;
    collected: number;
    /** Owed today across all open invoices (not limited to the window). */
    outstanding: number;
    overdue: number;
    overdue_invoices: number;
    /** Monthly fees of every active engagement. */
    monthly_fees: number;
    tasks_approved: number;
    first_time_approval: Rate;
    on_time: Rate;
    avg_review_days: number | null;
    hours: number;
  };
  /** One entry per month, aligned with `months`. */
  monthly: {
    month: string;
    billed: number;
    collected: number;
    approved: number;
    first_time_approval: Rate;
    on_time: Rate;
    avg_review_days: number | null;
    hours: number;
    new_clients: number;
    closed_clients: number;
  }[];
  people: {
    user_id: number;
    full_name: string;
    /** Approved tasks per month, aligned with `months`. */
    approved: number[];
    total: number;
    first_time_approval: Rate;
    on_time: Rate;
    hours: number;
  }[];
  top_clients: { client_id: number; client_name: string; total: number }[];
  packages: { package_id: number; name: string; clients: number; monthly_fees: number }[];
  clients_by_status: { status: string; count: number }[];
}
