import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { ENGAGEMENT_STATUSES } from "./engagement.types.js";

const optionalDate = z
  .union([z.iso.date("Use a valid date"), z.literal("")])
  .nullish()
  .transform((v) => (v ? v : null));

const datesInOrder = (v: { start_date?: string | null; renewal_date?: string | null }) =>
  !v.start_date || !v.renewal_date || v.renewal_date > v.start_date;
const datesError = { message: "Renewal date must be after the start date", path: ["renewal_date"] };

export const engagementBodySchema = z
  .object({
    client_id: z.coerce.number().int().positive("Choose a client"),
    package_id: z.coerce.number().int().positive("Choose a package"),
    start_date: optionalDate,
    renewal_date: optionalDate,
    /** Admin onboarding a client directly: the package is active at once (no agreement, no first invoice). */
    activate_now: z.boolean().optional().default(false),
  })
  .refine(datesInOrder, datesError);

export const engagementUpdateSchema = z
  .object({
    package_id: z.coerce.number().int().positive("Choose a package").optional(),
    start_date: optionalDate.optional(),
    renewal_date: optionalDate.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .refine(datesInOrder, datesError);

export const statusBodySchema = z.object({ to: z.enum(ENGAGEMENT_STATUSES) });

export const engagementListQuerySchema = listQuerySchema.extend({
  status: z.enum(ENGAGEMENT_STATUSES).optional(),
  clientId: z.coerce.number().int().positive().optional(),
});

export type EngagementInput = z.infer<typeof engagementBodySchema>;
export type EngagementUpdateInput = z.infer<typeof engagementUpdateSchema>;
export type StatusInput = z.infer<typeof statusBodySchema>;
export type EngagementListQuery = z.infer<typeof engagementListQuerySchema>;
