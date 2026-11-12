import { z } from "zod";
import { gstinSchema, optionalText, panSchema } from "../../utils/zod-helpers.js";

export const updateSettingsSchema = z
  .object({
    company_name: z.string().trim().min(2).max(150),
    legal_name: optionalText(200),
    gstin: gstinSchema,
    pan: panSchema,
    address: optionalText(500),
    email: z
      .email("Enter a valid email address")
      .max(255)
      .nullish()
      .or(z.literal("").transform(() => null)),
    phone: optionalText(30),
    gst_rate: z.coerce.number().min(0, "GST rate can't be negative").max(28, "GST rate can't exceed 28%"),
    remind_document_due: z.boolean(),
    remind_task_overdue: z.boolean(),
    remind_invoice_overdue: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
