import { z } from "zod";
import { money, optionalText } from "../../utils/zod-helpers.js";
import { BILLING_CYCLES } from "./package.types.js";

export const packageBodySchema = z.object({
  name: z.string().trim().min(2, "Enter a package name").max(150),
  description: optionalText(500),
  monthly_fee: money.refine((v) => v > 0, "Enter the monthly fee"),
  billing_cycle: z.enum(BILLING_CYCLES).default("monthly"),
  scope_notes: optionalText(1000),
  is_active: z.boolean().default(true),
  service_ids: z
    .array(z.coerce.number().int().positive())
    .min(1, "Pick at least one service")
    .transform((ids) => [...new Set(ids)]),
});

export const packageUpdateSchema = packageBodySchema.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type PackageInput = z.infer<typeof packageBodySchema>;
export type PackageUpdateInput = z.infer<typeof packageUpdateSchema>;
