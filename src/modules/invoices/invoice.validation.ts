import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { periodSchema } from "../../utils/zod-helpers.js";
import { INVOICE_STATUSES } from "./invoice.types.js";

export const invoiceListQuerySchema = listQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
});

export const createInvoiceSchema = z.object({
  engagement_id: z.coerce.number().int().positive("Pick an engagement"),
  period: periodSchema,
});

export const invoiceStatusSchema = z.object({ status: z.enum(INVOICE_STATUSES) });

export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type InvoiceStatusInput = z.infer<typeof invoiceStatusSchema>;
