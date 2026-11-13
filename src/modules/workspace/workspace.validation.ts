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
