import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyInvoiceIssued } from "../notifications/notification.service.js";
import * as q from "./invoice.queries.js";
import { issueInvoice } from "./invoice.repository.js";
import type { InvoiceStatus } from "./invoice.types.js";
import type { CreateInvoiceInput, InvoiceListQuery } from "./invoice.validation.js";

export async function listInvoices(query: InvoiceListQuery) {
  const [page, summary] = await Promise.all([q.listInvoices(query), q.invoiceSummary()]);
  return { ...page, summary };
}

/** Raises an invoice from an active engagement at the package fee plus GST from Settings. */
export async function createInvoice(actor: AuthUser, input: CreateInvoiceInput) {
  const engagement = await q.findEngagementForInvoice(input.engagement_id);
  if (!engagement) throw AppError.notFound("Engagement");
  if (engagement.status !== "active") throw new AppError("VALIDATION_ERROR", "Invoices can only be raised from active engagements");
  if (await q.invoiceExistsForPeriod(input.engagement_id, input.period)) {
    throw AppError.conflict(`${engagement.client_name} already has an invoice for ${input.period}`);
  }
  const id = await withTransaction(async (conn) => {
    const inv = await issueInvoice(input.engagement_id, conn, input.period);
    await recordAudit(
      actor,
      { action: "Invoice issued", entityType: "ServiceInvoice", entityId: inv.id, clientId: engagement.client_id, details: `${inv.invoice_number} · ${input.period} · ₹${inv.total.toFixed(2)}` },
      conn,
    );
    return inv.id;
  });
  void notifyInvoiceIssued(id);
  return (await q.findInvoiceById(id))!;
}

export async function changeStatus(actor: AuthUser, id: number, status: InvoiceStatus) {
  const before = await q.findInvoiceById(id);
  if (!before) throw AppError.notFound("Invoice");
  if (before.status === status) return before;
  if (status === "paid" && before.paid_amount < before.total) {
    throw new AppError("VALIDATION_ERROR", "Record a payment for the full total to mark this invoice paid");
  }
  await withTransaction(async (conn) => {
    await q.setInvoiceStatus(id, status, conn);
    await recordAudit(
      actor,
      { action: "Invoice status changed", entityType: "ServiceInvoice", entityId: id, clientId: before.client_id, details: `${before.invoice_number}: ${before.status} → ${status}` },
      conn,
    );
  });
  return (await q.findInvoiceById(id))!;
}
