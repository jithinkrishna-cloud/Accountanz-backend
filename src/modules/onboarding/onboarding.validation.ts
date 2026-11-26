import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { gstinSchema, money, optionalText, panSchema } from "../../utils/zod-helpers.js";
import { ACCOUNTING_SOFTWARE, BUSINESS_TYPES } from "../clients/client.types.js";
import { COMPLEXITIES, ONBOARDING_STAGES } from "./onboarding.types.js";

const optionalEmail = z.string().trim().max(255).email("Enter a valid email address").nullish().or(z.literal("")).transform((v) => (v ? v.trim().toLowerCase() : null));
const optionalDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullish().or(z.literal("")).transform((v) => (v ? v : null));

/** A new prospect: creates the client as a lead together with its onboarding case. */
export const prospectBodySchema = z.object({
  legal_name: z.string().trim().min(2, "Enter the legal name").max(200),
  trade_name: optionalText(200),
  business_type: z.enum(BUSINESS_TYPES).nullish().transform((v) => v ?? null),
  date_of_establishment: optionalDate,
  gstin: gstinSchema,
  pan: panSchema,
  state: optionalText(60),
  address: optionalText(500),
  primary_contact_name: optionalText(150),
  primary_contact_email: optionalEmail,
  primary_contact_phone: optionalText(30),
  accounting_software: z.enum(ACCOUNTING_SOFTWARE).default("none"),
  notes: optionalText(2000),
});

export const assessmentBodySchema = z.object({
  monthly_transaction_volume: z.coerce.number().int("Use a whole number").min(0).max(10_000_000).nullable(),
  complexity: z.enum(COMPLEXITIES).nullable(),
  suggested_package_id: z.coerce.number().int().positive().nullable(),
  suggested_monthly_fee: money.nullable(),
  notes: optionalText(2000),
  /** Shown to the client with the proposal. */
  proposal_message: optionalText(2000),
});

export const stageBodySchema = z.object({
  to: z.enum(ONBOARDING_STAGES),
  reason: optionalText(500),
  /** Sending a proposal while onboarding data is incomplete needs a reason (recorded in the audit log). */
  override_reason: optionalText(500),
});

export const onboardingListQuerySchema = listQuerySchema.extend({
  stage: z.enum(ONBOARDING_STAGES).optional(),
  client_id: z.coerce.number().int().positive().optional(),
});

export const serviceRequirementsSchema = z.object({
  bookkeeping: z.boolean().default(false),
  gst_filing: z.boolean().default(false),
  income_tax_filing: z.boolean().default(false),
  payroll: z.boolean().default(false),
  audit_support: z.boolean().default(false),
  other_services: optionalText(500),
  notes: optionalText(1000),
});

export type ProspectInput = z.infer<typeof prospectBodySchema>;
export type AssessmentInput = z.infer<typeof assessmentBodySchema>;
export type StageInput = z.infer<typeof stageBodySchema>;
export type OnboardingListQuery = z.infer<typeof onboardingListQuerySchema>;
export type ServiceRequirementsInput = z.infer<typeof serviceRequirementsSchema>;
