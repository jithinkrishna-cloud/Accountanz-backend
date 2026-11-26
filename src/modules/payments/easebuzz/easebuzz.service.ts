import { randomBytes } from "node:crypto";
import { env } from "../../../config/env.js";
import { execute, queryOne, withTransaction } from "../../../database/connection.js";
import type { AuthUser } from "../../../types/auth.types.js";
import { AppError } from "../../../utils/app-error.js";
import { logger } from "../../../utils/logger.js";
import { recordAudit } from "../../audit/audit.service.js";
import * as paymentRepo from "../payment.repository.js";
import { easebuzzConfigured, initiateLink, verifyResponse } from "./easebuzz.client.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
/** Easebuzz rejects some characters in firstname/productinfo. */
const clean = (s: string, re: RegExp, fallback: string) => s.replace(re, "").trim().slice(0, 50) || fallback;
const tenDigits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);

/**
 * Client clicks "Pay now" on an invoice: records a pending attempt for the invoice's remaining balance (worked out
 * here, never taken from the browser) and returns the Easebuzz checkout URL to send the browser to.
 */
export async function startInvoicePayment(user: AuthUser, clientId: number, invoiceId: number) {
  if (!easebuzzConfigured()) throw new AppError("UNAVAILABLE", "Online payments aren't set up yet");

  // Easebuzz requires a 10-digit mobile: the payer's own, else the company's primary contact.
  const contact = await queryOne<{ user_phone: string | null; client_phone: string | null }>(
    `SELECT u.phone AS user_phone, c.primary_contact_phone AS client_phone FROM users u JOIN clients c ON c.id = ? WHERE u.id = ?`,
    [clientId, user.id],
  );
  const phone = [contact?.user_phone, contact?.client_phone].map(tenDigits).find((p) => p.length === 10);
  if (!phone) throw new AppError("VALIDATION_ERROR", "A 10-digit mobile number is needed to pay online. Ask your Accountanz team to add one to your profile.");

  const txnid = `ACZ${Date.now()}${randomBytes(3).toString("hex")}`.toUpperCase();
  const inv = await withTransaction(async (conn) => {
    const invoice = await paymentRepo.lockInvoice(invoiceId, conn);
    if (!invoice || invoice.client_id !== clientId) throw AppError.notFound("Invoice");
    if (invoice.status !== "issued" && invoice.status !== "overdue") {
      throw AppError.conflict(`Invoice ${invoice.invoice_number} is ${invoice.status} and can't be paid online`);
    }
    const balance = round2(invoice.balance);
    if (balance <= 0) throw AppError.conflict("Nothing is outstanding on this invoice");
    await execute(
      `INSERT INTO gateway_transactions (txnid, invoice_id, client_id, initiated_by, amount) VALUES (?, ?, ?, ?, ?)`,
      [txnid, invoice.id, clientId, user.id, balance],
      conn,
    );
    return { id: invoice.id, number: invoice.invoice_number, balance };
  });

  const back = `${env.API_PUBLIC_URL ?? env.APP_URL}/api/payments/easebuzz/return`;
  try {
    const url = await initiateLink({
      txnid,
      amount: inv.balance,
      phone,
      email: user.email,
      firstname: clean(user.fullName, /[^A-Za-z .]/g, "Customer"),
      productinfo: clean(`Invoice ${inv.number}`, /[^A-Za-z0-9 _-]/g, "Invoice"),
      surl: back,
      furl: back,
      udf1: String(inv.id),
    });
    return { url };
  } catch (err) {
    await execute(`UPDATE gateway_transactions SET status = 'failure', error_message = ? WHERE txnid = ?`, [
      (err instanceof Error ? err.message : "Gateway error").slice(0, 255),
      txnid,
    ]);
    throw err;
  }
}

export type Outcome = "success" | "failed" | "pending" | "invalid";

/**
 * Applies an Easebuzz result (browser return or webhook). Safe to run twice for the same txnid: the second call
 * finds the transaction already successful and changes nothing.
 */
export async function applyEasebuzzResult(body: unknown): Promise<{ outcome: Outcome; invoiceId?: number }> {
  const p = (body && typeof body === "object" ? body : {}) as Record<string, string | undefined>;
  if (!p.txnid || !verifyResponse(p)) {
    logger.warn({ txnid: p.txnid }, "Easebuzz response rejected: missing txnid or hash mismatch");
    return { outcome: "invalid" };
  }
  return withTransaction(async (conn) => {
    const tx = await queryOne<{ id: number; invoice_id: number; client_id: number; amount: number; status: string }>(
      `SELECT id, invoice_id, client_id, amount, status FROM gateway_transactions WHERE txnid = ? FOR UPDATE`,
      [p.txnid!],
      conn,
    );
    if (!tx) return { outcome: "invalid" as const };
    if (tx.status === "success") return { outcome: "success" as const, invoiceId: tx.invoice_id };

    if (p.status !== "success") {
      const s = p.status === "pending" ? "pending" : p.status === "userCancelled" ? "cancelled" : "failure";
      const msg = (p.error_Message ?? p.error ?? "").slice(0, 255) || null;
      await execute(`UPDATE gateway_transactions SET status = ?, easepayid = ?, error_message = ? WHERE id = ?`, [s, p.easepayid ?? null, msg, tx.id], conn);
      return { outcome: s === "pending" ? ("pending" as const) : ("failed" as const), invoiceId: tx.invoice_id };
    }
    if (round2(Number(p.amount)) !== round2(tx.amount)) {
      logger.error({ txnid: p.txnid, got: p.amount, expected: tx.amount }, "Easebuzz amount mismatch");
      await execute(`UPDATE gateway_transactions SET status = 'failure', error_message = 'Amount mismatch' WHERE id = ?`, [tx.id], conn);
      return { outcome: "failed" as const, invoiceId: tx.invoice_id };
    }

    // The money has been taken, so it is always recorded — even if the invoice was settled some other way meanwhile.
    const invoice = await paymentRepo.lockInvoice(tx.invoice_id, conn);
    const r = await execute(
      `INSERT INTO service_payments (invoice_id, amount, paid_date, method, reference, recorded_by) VALUES (?, ?, ?, 'easebuzz', ?, NULL)`,
      [tx.invoice_id, tx.amount, todayIST(), (p.easepayid ?? p.txnid!).slice(0, 100)],
      conn,
    );
    const open = invoice?.status === "issued" || invoice?.status === "overdue";
    const fullyPaid = open && round2(invoice.balance - tx.amount) <= 0;
    if (fullyPaid) await paymentRepo.markInvoicePaid(tx.invoice_id, conn);
    if (!open) logger.warn({ txnid: p.txnid, invoice: invoice?.invoice_number, status: invoice?.status }, "Easebuzz payment received for an invoice that was no longer open");
    await execute(`UPDATE gateway_transactions SET status = 'success', easepayid = ?, payment_id = ? WHERE id = ?`, [p.easepayid ?? null, r.insertId, tx.id], conn);
    await recordAudit(
      null,
      {
        action: "Online payment received",
        entityType: "ServicePayment",
        entityId: r.insertId,
        clientId: tx.client_id,
        details: `₹${tx.amount.toFixed(2)} via Easebuzz against ${invoice?.invoice_number ?? `invoice #${tx.invoice_id}`}${fullyPaid ? " (invoice paid)" : ""}`,
      },
      conn,
    );
    return { outcome: "success" as const, invoiceId: tx.invoice_id };
  });
}
