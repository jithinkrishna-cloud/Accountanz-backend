export const INVOICE_STATUSES = ["draft", "issued", "paid", "overdue", "cancelled"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface InvoiceRow {
  id: number;
  invoice_number: string;
  engagement_id: number;
  client_id: number;
  client_name: string;
  period: string;
  amount: number;
  gst_amount: number;
  total: number;
  due_date: string;
  status: InvoiceStatus;
  paid_amount: number;
}

export interface InvoiceSummary {
  billed: number;
  collected: number;
  outstanding: number;
}
