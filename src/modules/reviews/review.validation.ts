import { z } from "zod";
import { optionalText } from "../../utils/zod-helpers.js";
import { REVIEW_DECISIONS } from "./review.types.js";

export const reviewDecisionSchema = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  comments: optionalText(2000),
});

export const taskIdParam = z.object({ taskId: z.coerce.number().int().positive() });

export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
export type TaskIdParam = z.infer<typeof taskIdParam>;
