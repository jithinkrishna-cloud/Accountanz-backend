export const ENGAGEMENT_STATUSES = ["draft", "sent", "accepted", "active", "ended"] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

/** draft → sent → accepted → active → ended; anything not yet ended can be ended. */
export const ENGAGEMENT_TRANSITIONS: Record<EngagementStatus, EngagementStatus[]> = {
  draft: ["sent", "ended"],
  sent: ["accepted", "draft", "ended"],
  accepted: ["active", "ended"],
  active: ["ended"],
  ended: [],
};

export interface EngagementRow {
  id: number;
  client_id: number;
  client_name: string;
  client_status: string;
  package_id: number;
  package_name: string;
  /** What's billed: the agreed fee, or the package's list price. */
  monthly_fee: number;
  list_fee: number;
  billing_cycle: "monthly" | "quarterly" | "yearly";
  status: EngagementStatus;
  start_date: string | null;
  end_date: string | null;
  renewal_date: string | null;
  agreement_file_name: string | null;
  invoice_count: number;
  first_invoice_number: string | null;
  created_at: string;
  updated_at: string;
}

export type EngagementCounts = Record<EngagementStatus, number>;
