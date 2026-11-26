import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { money, optionalText } from "../../utils/zod-helpers.js";
import { MANUAL_PAYMENT_METHODS, PAYMENT_METHODS } from "./payment.types.js";

export const paymentListQuerySchema = listQuerySchema.extend({ method: z.enum(PAYMENT_METHODS).optional() });

export const recordPaymentSchema = z.object({
  invoice_id: z.coerce.number().int().positive("Pick an invoice"),
  amount: money.refine((v) => v > 0, "Enter the amount received"),
  paid_date: z.iso.date("Pick the payment date"),
  method: z.enum(MANUAL_PAYMENT_METHODS),
  reference: optionalText(100),
});

export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
