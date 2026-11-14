import type { PoolConnection } from "mysql2/promise";
import { execute, queryOne } from "../../database/connection.js";

/** Months billed per invoice for each package billing cycle. */
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 } as const;
const PAYMENT_TERMS_DAYS = 15;
const FIRST_INVOICE_SEQ = 1000;

export interface IssuedInvoice {
  id: number;
  invoice_number: string;
  period: string;
  amount: number;
  gst_amount: number;
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Issues a service invoice for the engagement's agreed fee (or the package's list price) plus GST (rate snapshot from Settings),
 * for the given period (default: current), due in 15 days. Numbers are ACC-YYYYMM-NNNN with one running sequence.
 * Must run inside the caller's transaction.
 */
export async function issueInvoice(engagementId: number, conn: PoolConnection, period?: string): Promise<IssuedInvoice> {
  const base = await queryOne<{ monthly_fee: number; billing_cycle: keyof typeof CYCLE_MONTHS; gst_rate: number; period: string }>(
    `SELECT COALESCE(e.monthly_fee, p.monthly_fee) AS monthly_fee, p.billing_cycle,
            (SELECT gst_rate FROM app_settings WHERE id = 1) AS gst_rate,
            COALESCE(?, DATE_FORMAT(CURDATE(), '%Y-%m')) AS period
       FROM engagements e JOIN packages p ON p.id = e.package_id
      WHERE e.id = ?`,
    [period ?? null, engagementId],
    conn,
  );
  if (!base) throw new Error(`Engagement ${engagementId} not found while issuing invoice`);

  const gstRate = base.gst_rate ?? 18;
  const amount = round2(base.monthly_fee * CYCLE_MONTHS[base.billing_cycle]);
  const gstAmount = round2((amount * gstRate) / 100);
  const total = round2(amount + gstAmount);

  // Serialises numbering: concurrent issuers wait on the same locked rows; the unique key is the backstop.
  const last = await queryOne<{ seq: number | null }>(
    `SELECT MAX(CAST(SUBSTRING_INDEX(invoice_number, '-', -1) AS UNSIGNED)) AS seq FROM service_invoices FOR UPDATE`,
    [],
    conn,
  );
  const invoiceNumber = `ACC-${base.period.replace("-", "")}-${(last?.seq ?? FIRST_INVOICE_SEQ) + 1}`;

  const r = await execute(
    `INSERT INTO service_invoices (engagement_id, invoice_number, period, amount, gst_rate, gst_amount, total, due_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 'issued')`,
    [engagementId, invoiceNumber, base.period, amount, gstRate, gstAmount, total, PAYMENT_TERMS_DAYS],
    conn,
  );
  return { id: r.insertId, invoice_number: invoiceNumber, period: base.period, amount, gst_amount: gstAmount, total };
}

export function countLiveInvoices(engagementId: number, conn: PoolConnection) {
  return queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM service_invoices WHERE engagement_id = ? AND status <> 'cancelled'`, [engagementId], conn).then(
    (r) => r?.n ?? 0,
  );
}
