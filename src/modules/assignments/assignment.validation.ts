import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { ASSIGNMENT_STATUSES, TEAM_ROLES } from "./assignment.types.js";

const optionalDate = z
  .union([z.iso.date("Use a valid date"), z.literal("")])
  .nullish()
  .transform((v) => (v ? v : null));

export const assignmentBodySchema = z
  .object({
    client_id: z.coerce.number().int().positive("Choose a client"),
    user_id: z.coerce.number().int().positive("Choose a staff member"),
    team_role: z.enum(TEAM_ROLES, "Choose a team role"),
    valid_from: z.iso.date("Choose a start date"),
    valid_to: optionalDate,
    /** Active assignment on the same client that this one takes over; it is ended in the same transaction. */
    replaces_id: z.coerce.number().int().positive().nullish(),
  })
  .refine((v) => !v.valid_to || v.valid_to >= v.valid_from, { message: "End date can't be before the start date", path: ["valid_to"] });

export const assignmentUpdateSchema = z
  .object({
    valid_to: optionalDate.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const assignmentListQuerySchema = listQuerySchema.extend({
  status: z.enum(ASSIGNMENT_STATUSES).optional(),
  team_role: z.enum(TEAM_ROLES).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
});

export type AssignmentInput = z.infer<typeof assignmentBodySchema>;
export type AssignmentUpdateInput = z.infer<typeof assignmentUpdateSchema>;
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;
