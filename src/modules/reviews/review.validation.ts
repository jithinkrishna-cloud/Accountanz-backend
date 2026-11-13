import { z } from "zod";
import { optionalText } from "../../utils/zod-helpers.js";
import { REVIEW_DECISIONS } from "./review.types.js";

export const reviewDecisionSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    comments: optionalText(2000),
  })
  // A returned task goes back to the accountant; without a comment they can't tell what to correct.
  .refine((v) => v.decision !== "returned" || !!v.comments?.trim(), { message: "Say what needs correcting", path: ["comments"] });

export const taskIdParam = z.object({ taskId: z.coerce.number().int().positive() });

export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
export type TaskIdParam = z.infer<typeof taskIdParam>;
