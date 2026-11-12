import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./payment.repository.js";
import type { PaymentListQuery, RecordPaymentInput } from "./payment.validation.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const listPayments = (q: PaymentListQuery) => repo.listPayments(q);
export const listOpenInvoices = () => repo.listOpenInvoices();

/**
 * Records money received against an issued/overdue invoice. Paying the full total marks the invoice paid.
 * Payments larger than the remaining balance are refused.
 */
export async function recordPayment(actor: AuthUser, input: RecordPaymentInput) {
  return withTransaction(async (conn) => {
    const invoice = await repo.lockInvoice(input.invoice_id, conn);
    if (!invoice) throw AppError.notFound("Invoice");
    if (invoice.status !== "issued" && invoice.status !== "overdue") {
      throw AppError.conflict(`Invoice ${invoice.invoice_number} is ${invoice.status} and can't take a payment`);
    }
    const balance = round2(invoice.balance);
    if (input.amount > balance) {
      throw new AppError("VALIDATION_ERROR", "Please check the highlighted fields", {
        fieldErrors: { amount: [`Only ₹${balance.toFixed(2)} is outstanding on this invoice`] },
      });
    }
    const id = await repo.insertPayment(input, actor.id, conn);
    const fullyPaid = round2(balance - input.amount) === 0;
    if (fullyPaid) await repo.markInvoicePaid(invoice.id, conn);
    await recordAudit(
      actor,
      {
        action: "Payment recorded",
        entityType: "ServicePayment",
        entityId: id,
        clientId: invoice.client_id,
        details: `₹${input.amount.toFixed(2)} against ${invoice.invoice_number}${fullyPaid ? " (invoice paid)" : ""}`,
      },
      conn,
    );
    return { id, invoice_paid: fullyPaid };
  });
}
