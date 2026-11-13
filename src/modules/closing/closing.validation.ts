import { z } from "zod";
import { periodSchema } from "../../utils/zod-helpers.js";
import { CLOSING_STATUSES } from "./closing.types.js";

export const closingParams = z.object({
  clientId: z.coerce.number().int().positive(),
  period: periodSchema,
});

/** Why a period is marked ready while checklist items are still open; required only in that case. */
export const overrideReasonSchema = z.string().trim().min(10, "Explain in at least 10 characters").max(500).optional();

export const closingStatusSchema = z.object({ status: z.enum(CLOSING_STATUSES), reason: overrideReasonSchema });

export type ClosingParams = z.infer<typeof closingParams>;
export type ClosingStatusInput = z.infer<typeof closingStatusSchema>;
