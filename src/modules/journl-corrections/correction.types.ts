export type CorrectionKind = "opening_balance" | "journal_entry";
export type CorrectionPurpose = "correction" | "unresolved_tb_difference";
export type CorrectionStatus = "draft" | "pending_approval" | "approved" | "posting" | "posted" | "rejected" | "unknown";
export type RejectedBy = "reviewer" | "journl" | "stale";

export interface JournalLine {
  ledger_id: number;
  ledger_name: string;
  side: "dr" | "cr";
  amount_paise: number;
}

export interface JournalPayload {
  voucher_date: string;
  lines: JournalLine[];
}

export interface OpeningPayload {
  ledger_id: number;
  ledger_name: string;
  amount_paise: number;
  side: "dr" | "cr";
}

/** Signed: Dr negative, Cr positive (JournL convention). */
export interface BalanceRow {
  ledger_id: number;
  ledger_name: string;
  before_paise: number;
  after_paise: number;
}

export interface CorrectionRow {
  id: number;
  client_id: number;
  connection_id: number;
  journl_company_id: string;
  journl_branch_id: number;
  kind: CorrectionKind;
  purpose: CorrectionPurpose;
  status: CorrectionStatus;
  payload: JournalPayload | OpeningPayload;
  before_values: BalanceRow[] | null;
  after_values: BalanceRow[] | null;
  reason: string;
  initiated_by: number;
  approved_by: number | null;
  approved_at: string | null;
  review_comment: string | null;
  journl_session_owner: number | null;
  journl_voucher_id: string | null;
  rejected_by_source: RejectedBy | null;
  journl_message: string | null;
  copied_from: number | null;
  /** 1 when the row has sat in `posting` longer than STUCK_POSTING_SECONDS (computed on read; not a column). */
  stuck_posting?: number | boolean | null;
  created_at: string;
  updated_at: string;
}

/** Human reference written to the journal voucher's invoiceNo. Derived from id; not stored. */
export function correctionRef(id: number): string {
  return `ACZ-${id}`;
}
