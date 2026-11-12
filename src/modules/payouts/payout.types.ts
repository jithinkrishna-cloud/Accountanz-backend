export const PAYOUT_STATUSES = ["draft", "approved", "paid"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export interface PayoutRow {
  id: number;
  user_id: number;
  full_name: string;
  email: string;
  period: string;
  minutes: number;
  hourly_rate: number;
  amount: number;
  status: PayoutStatus;
  paid_date: string | null;
  reference: string | null;
  bank_account_last4: string | null;
  verification_status: "pending" | "verified" | "rejected" | null;
}

export interface PayoutSummary {
  payable: number;
  paid: number;
  logged_minutes: number;
}

export interface RunResult {
  period: string;
  created: number;
  refreshed: number;
  payable: number;
  /** Accountants with logged time who were left out because they aren't verified. */
  skipped_unverified: string[];
}
