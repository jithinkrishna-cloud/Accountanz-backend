import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { gstinSchema, optionalText, panSchema } from "../../utils/zod-helpers.js";
import { ACCOUNTING_SOFTWARE, BUSINESS_TYPES, CLIENT_STATUSES, REGISTRATION_STATUSES, STAKEHOLDER_TYPES } from "./client.types.js";

const optionalEmail = z.string().trim().max(255).email("Enter a valid email address").nullish().or(z.literal("")).transform((v) => (v ? v.trim().toLowerCase() : null));
const optionalDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullish().or(z.literal("")).transform((v) => (v ? v : null));

/** Every client field, with no defaults: defaults belong to creating a client, never to a partial update. */
const clientFields = z.object({
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
  status: z.enum(CLIENT_STATUSES),
  accounting_software: z.enum(ACCOUNTING_SOFTWARE),
});

export const clientBodySchema = clientFields.extend({
  status: clientFields.shape.status.default("lead"),
  accounting_software: clientFields.shape.accounting_software.default("none"),
});

/**
 * Only the fields sent are changed. (Built from the default-free fields: with defaults, a PATCH that left out status
 * or accounting_software would reset them to "lead" / "none".)
 */
export const clientUpdateSchema = clientFields.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update");

/** The company owner keeps their own business details up to date; only status stays with Accountanz. */
export const portalClientUpdateSchema = clientFields
  .omit({ status: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const clientListQuerySchema = listQuerySchema.extend({
  status: z.enum(CLIENT_STATUSES).optional(),
});

export type ClientInput = z.infer<typeof clientBodySchema>;
export type ClientUpdateInput = z.infer<typeof clientUpdateSchema>;
export type ClientListQuery = z.infer<typeof clientListQuerySchema>;

export const inviteClientUserSchema = z.object({
  full_name: z.string().trim().min(2, "Enter the full name").max(150),
  email: z.email("Enter a valid email address").max(255).transform((v) => v.trim().toLowerCase()),
  phone: optionalText(30),
  role: z.enum(["owner", "member"]).default("member"),
  can_approve: z.boolean().default(false),
});
export type InviteClientUserInput = z.infer<typeof inviteClientUserSchema>;

/** A branch / additional place of business. Same-state branches may share the company's GSTIN. */
export const branchBodySchema = z.object({
  name: z.string().trim().min(2, "Enter the branch name").max(150),
  gstin: gstinSchema,
  external_branch_ref: optionalText(60),
});
export const branchParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  branchId: z.coerce.number().int().positive(),
});
export type BranchInput = z.infer<typeof branchBodySchema>;
export type BranchParams = z.infer<typeof branchParamsSchema>;

const regStatus = z.enum(REGISTRATION_STATUSES).nullish().transform((v) => v ?? null);
const upperOptional = (max: number) => z.string().trim().max(max).transform((v) => v.toUpperCase()).nullish().or(z.literal("")).transform((v) => (v ? v : null));

export const companyTaxDetailsSchema = z.object({
  pan_number: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid PAN").nullish().or(z.literal("")).transform((v) => (v ? v : null)),
  pan_status: regStatus,
  tan_number: upperOptional(10),
  tan_status: regStatus,
  gstin: gstinSchema,
  gstin_status: regStatus,
  cin: upperOptional(21),
  cin_status: regStatus,
  llpin: upperOptional(8),
  llpin_status: regStatus,
  msme_udyam_number: upperOptional(19),
  msme_status: regStatus,
  professional_tax_registration: optionalText(50),
  professional_tax_status: regStatus,
});

export const stakeholderSchema = z.object({
  stakeholder_type: z.enum(STAKEHOLDER_TYPES),
  full_name: z.string().trim().min(2, "Enter the full name").max(150),
  email: optionalEmail,
  phone: optionalText(30),
  designation: optionalText(100),
  ownership_percentage: z.coerce.number().min(0).max(100).nullish().transform((v) => (v == null || Number.isNaN(v) ? null : v)),
  pan_number: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid PAN").nullish().or(z.literal("")).transform((v) => (v ? v : null)),
  din_number: optionalText(20),
  address: optionalText(500),
  is_primary: z.boolean().optional().default(false),
});

export const stakeholderListSchema = z.object({
  stakeholders: z
    .array(stakeholderSchema)
    .max(100)
    .refine((list) => list.filter((s) => s.is_primary).length <= 1, "Only one stakeholder can be primary")
    .refine((list) => list.reduce((sum, s) => sum + (s.ownership_percentage ?? 0), 0) <= 100.0001, "Total ownership across stakeholders can't exceed 100%"),
});

export const stakeholderParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  stakeholderId: z.coerce.number().int().positive(),
});

export const financialProfileSchema = z.object({
  financial_year_start_month: z.coerce.number().int().min(1).max(12).nullish().transform((v) => (v == null || Number.isNaN(v) ? null : v)),
  annual_turnover: z.coerce.number().min(0).nullish().transform((v) => (v == null || Number.isNaN(v) ? null : v)),
  monthly_transaction_volume: z.coerce.number().int().min(0).nullish().transform((v) => (v == null || Number.isNaN(v) ? null : v)),
  employee_count: z.coerce.number().int().min(0).nullish().transform((v) => (v == null || Number.isNaN(v) ? null : v)),
  monthly_invoice_count: z.coerce.number().int().min(0).nullish().transform((v) => (v == null || Number.isNaN(v) ? null : v)),
  current_accounting_software: optionalText(100),
  notes: optionalText(1000),
});

export type CompanyTaxDetailsInput = z.infer<typeof companyTaxDetailsSchema>;
export type StakeholderInput = z.infer<typeof stakeholderSchema>;
export type FinancialProfileInput = z.infer<typeof financialProfileSchema>;
