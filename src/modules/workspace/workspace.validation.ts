import { z } from "zod";
import { periodSchema } from "../../utils/zod-helpers.js";
import { overrideReasonSchema } from "../closing/closing.validation.js";

export const checklistQuerySchema = z.object({ period: periodSchema.optional() });

export const closingParamsSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  period: periodSchema,
});

/** Staff mark a period ready for closing (or take it back); closing itself stays with admins. */
export const readinessSchema = z.object({ status: z.enum(["open", "ready"]), reason: overrideReasonSchema });

export type ChecklistQuery = z.infer<typeof checklistQuerySchema>;
export type ClosingParams = z.infer<typeof closingParamsSchema>;
export type ReadinessInput = z.infer<typeof readinessSchema>;

/** Paging, period and filters for one read-only JournL view. Period defaults: 1 April to today. */
export const journlViewQuerySchema = z
  .object({
    from: z.iso.date("Use a valid date").optional(),
    to: z.iso.date("Use a valid date").optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    page_size: z.coerce.number().int().min(5).max(100).default(25),
    search: z.string().trim().max(100).optional(),
    ledger_id: z.coerce.number().int().positive().optional(),
  })
  .transform((q) => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const [y, m] = today.split("-").map(Number);
    return { from: q.from ?? `${m >= 4 ? y : y - 1}-04-01`, to: q.to ?? today, page: q.page, pageSize: q.page_size, search: q.search || undefined, ledgerId: q.ledger_id };
  })
  .refine((q) => q.from <= q.to, { message: "The start date must be on or before the end date", path: ["from"] });
export const journlViewParamsSchema = z.object({ id: z.coerce.number().int().positive(), view: z.string().regex(/^[a-z0-9_]{2,40}$/) });
export type JournlViewQuery = z.infer<typeof journlViewQuerySchema>;
export type JournlViewParams = z.infer<typeof journlViewParamsSchema>;
