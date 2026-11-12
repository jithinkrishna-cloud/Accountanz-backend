import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { ifscSchema, optionalText } from "../../utils/zod-helpers.js";
import { STAFF_TYPES, VERIFICATION_STATUSES } from "./staff.types.js";

const staffRole = z.enum(["bookkeeper", "finance_manager", "cfo", "ops_admin"]);

export const staffListQuerySchema = listQuerySchema.extend({
  type: z.enum(STAFF_TYPES),
});

export const inviteStaffSchema = z.object({
  staff_type: z.enum(STAFF_TYPES),
  full_name: z.string().trim().min(2, "Enter the full name").max(150),
  email: z.email("Enter a valid email address").max(255).transform((v) => v.trim().toLowerCase()),
  phone: optionalText(30),
  portal_role: staffRole,
});

export const updateStaffSchema = z
  .object({
    full_name: z.string().trim().min(2).max(150),
    phone: optionalText(30),
    portal_role: staffRole,
    status: z.enum(["active", "disabled"]),
    hourly_rate: z.coerce.number().min(0).max(100000).nullable(),
    expertise: z.array(z.string().trim().min(1).max(60)).max(20),
    verification_status: z.enum(VERIFICATION_STATUSES),
    bank_account_name: optionalText(150),
    bank_account_number: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || /^\d{9,18}$/.test(v), "Enter 9–18 digits"),
    bank_ifsc: ifscSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type StaffListQuery = z.infer<typeof staffListQuerySchema>;
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
