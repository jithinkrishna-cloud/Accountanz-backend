/** Methods staff can record by hand. */
export const MANUAL_PAYMENT_METHODS = ["bank_transfer", "upi", "cheque", "cash", "other"] as const;
/** Every method a payment can have; "easebuzz" is only ever set by an online payment. */
export const PAYMENT_METHODS = [...MANUAL_PAYMENT_METHODS, "easebuzz"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PaymentRow {
  id: number;
  invoice_id: number;
  invoice_number: string;
  client_name: string;
  amount: number;
  paid_date: string;
  method: PaymentMethod;
  reference: string | null;
}

/** An invoice that can still take a payment. */
export interface OpenInvoice {
  id: number;
  invoice_number: string;
  client_name: string;
  total: number;
  balance: number;
}
