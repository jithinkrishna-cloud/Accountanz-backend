import { z } from "zod";
import { money, optionalText } from "../../utils/zod-helpers.js";
import { BILLING_CYCLES, PACKAGE_ROLES } from "./package.types.js";

const limitSchema = z.number().int().min(0).max(999).nullable();

export const packageBodySchema = z.object({
  name: z.string().trim().min(2, "Enter a package name").max(150),
  description: optionalText(500),
  monthly_fee: money.refine((v) => v > 0, "Enter the monthly fee"),
  billing_cycle: z.enum(BILLING_CYCLES).default("monthly"),
  scope_notes: optionalText(1000),
  /** The team the client gets with this package. */
  team_roles: z
    .array(z.enum(PACKAGE_ROLES))
    .min(1, "Include at least one role")
    .default(["bookkeeper", "finance_manager"])
    .transform((roles) => PACKAGE_ROLES.filter((r) => roles.includes(r))),
  /** Client workspaces the package allows. NULL = unlimited. */
  workspace_limit: limitSchema.default(1),
  /** Staff seats per workspace. NULL = unlimited. */
  staff_per_workspace: limitSchema.default(null),
  is_active: z.boolean().default(true),
  service_ids: z
    .array(z.coerce.number().int().positive())
    .min(1, "Pick at least one service")
    .transform((ids) => [...new Set(ids)]),
});

/* Limits are re-declared without defaults: zod 4 keeps .default() under .partial(), which would reset them on every update. */
export const packageUpdateSchema = packageBodySchema
  .partial()
  .extend({ workspace_limit: limitSchema.optional(), staff_per_workspace: limitSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type PackageInput = z.infer<typeof packageBodySchema>;
export type PackageUpdateInput = z.infer<typeof packageUpdateSchema>;
