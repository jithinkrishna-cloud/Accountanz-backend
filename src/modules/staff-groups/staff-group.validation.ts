import { z } from "zod";
import { TEAM_ROLES } from "../assignments/assignment.types.js";
import { optionalText } from "../../utils/zod-helpers.js";

const member = z.object({
  user_id: z.coerce.number().int().positive("Choose a person"),
  team_role: z.enum(TEAM_ROLES, "Choose a team role"),
  journl_access: z.boolean().default(false),
});

export const staffGroupBodySchema = z.object({
  name: z.string().trim().min(2, "Enter a group name").max(150),
  description: optionalText(500),
  members: z
    .array(member)
    .min(1, "Add at least one member")
    .max(30)
    .refine((ms) => new Set(ms.map((m) => `${m.user_id}:${m.team_role}`)).size === ms.length, "The same person is listed twice in the same role"),
});

const optionalDate = z
  .union([z.iso.date("Use a valid date"), z.literal("")])
  .nullish()
  .transform((v) => (v ? v : null));

export const assignGroupSchema = z
  .object({
    client_id: z.coerce.number().int().positive("Choose a client"),
    valid_from: z.iso.date("Choose a start date"),
    valid_to: optionalDate,
  })
  .refine((v) => !v.valid_to || v.valid_to >= v.valid_from, { message: "End date can't be before the start date", path: ["valid_to"] });

export type StaffGroupInput = z.infer<typeof staffGroupBodySchema>;
export type AssignGroupInput = z.infer<typeof assignGroupSchema>;
