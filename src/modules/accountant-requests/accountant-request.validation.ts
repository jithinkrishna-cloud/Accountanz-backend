import { z } from "zod";
import { optionalText } from "../../utils/zod-helpers.js";
import { TEAM_ROLES } from "../assignments/assignment.types.js";

export const accountantRequestSchema = z.object({
  kind: z.enum(["join_team", "one_off"]).default("join_team"),
  message: z.string().trim().min(10, "Tell us a little about the work (at least 10 characters)").max(2000),
  preferred_start: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .nullish()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
});

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const decisionSchema = z
  .object({
    decision: z.enum(["approved", "declined"]),
    note: optionalText(1000),
    /** Approve and assign in one step: creates the assignment (same rules as Assignments → New assignment). */
    assign: z
      .object({
        team_role: z.enum(TEAM_ROLES, "Choose a team role"),
        valid_from: isoDate,
        valid_to: isoDate.nullish().or(z.literal("")).transform((v) => (v ? v : null)),
      })
      .refine((a) => !a.valid_to || a.valid_to >= a.valid_from, { message: "End date can't be before the start date", path: ["valid_to"] })
      .nullish(),
  })
  // A decline must say why: the client reads it.
  .refine((v) => v.decision === "approved" || !!v.note, { message: "Tell the client why", path: ["note"] })
  .refine((v) => v.decision === "approved" || !v.assign, { message: "Only an approval can assign", path: ["assign"] });

export const adminListQuerySchema = z.object({ status: z.enum(["pending", "approved", "declined", "withdrawn"]).optional() });

export type AccountantRequestInput = z.infer<typeof accountantRequestSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;
