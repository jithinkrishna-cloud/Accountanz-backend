import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { gstinSchema, money, optionalText, panSchema } from "../../utils/zod-helpers.js";
import { COMPLEXITIES, ONBOARDING_STAGES } from "./onboarding.types.js";

/** A new prospect: creates the client as a lead together with its onboarding case. */
export const prospectBodySchema = z.object({
  legal_name: z.string().trim().min(2, "Enter the legal name").max(200),
  trade_name: optionalText(200),
  gstin: gstinSchema,
  pan: panSchema,
  state: optionalText(60),
  notes: optionalText(2000),
});

export const assessmentBodySchema = z.object({
  monthly_transaction_volume: z.coerce.number().int("Use a whole number").min(0).max(10_000_000).nullable(),
  complexity: z.enum(COMPLEXITIES).nullable(),
  suggested_package_id: z.coerce.number().int().positive().nullable(),
  suggested_monthly_fee: money.nullable(),
  notes: optionalText(2000),
});

export const stageBodySchema = z.object({
  to: z.enum(ONBOARDING_STAGES),
  reason: optionalText(500),
});

export const onboardingListQuerySchema = listQuerySchema.extend({
  stage: z.enum(ONBOARDING_STAGES).optional(),
});

export type ProspectInput = z.infer<typeof prospectBodySchema>;
export type AssessmentInput = z.infer<typeof assessmentBodySchema>;
export type StageInput = z.infer<typeof stageBodySchema>;
export type OnboardingListQuery = z.infer<typeof onboardingListQuerySchema>;
