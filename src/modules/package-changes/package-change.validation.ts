import { z } from "zod";
import { money, optionalText } from "../../utils/zod-helpers.js";

/** Client: ask to move the company's engagement to another package. */
export const packageChangeRequestSchema = z.object({
  package_id: z.coerce.number().int().positive("Choose a package"),
  message: optionalText(1000),
});

/** Staff: change the package on an engagement directly (recorded as an approved request). */
export const staffPackageChangeSchema = z.object({
  package_id: z.coerce.number().int().positive("Choose a package"),
  /** Agreed fee; empty = the new package's list price. */
  monthly_fee: money.nullish().transform((v) => v ?? null),
  note: optionalText(1000),
});

export const packageChangeDecisionSchema = z
  .object({
    decision: z.enum(["approved", "declined"]),
    monthly_fee: money.nullish().transform((v) => v ?? null),
    note: optionalText(1000),
  })
  // A decline must say why: the client reads it.
  .refine((v) => v.decision === "approved" || !!v.note, { message: "Tell the client why", path: ["note"] });

export type PackageChangeRequestInput = z.infer<typeof packageChangeRequestSchema>;
export type StaffPackageChangeInput = z.infer<typeof staffPackageChangeSchema>;
export type PackageChangeDecisionInput = z.infer<typeof packageChangeDecisionSchema>;
