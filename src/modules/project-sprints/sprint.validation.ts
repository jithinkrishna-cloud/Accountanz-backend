import { z } from "zod";

const date = z.iso.date("Use a valid date").nullable().optional();

export const updateSprintSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name").max(80).optional(),
    goal: z.string().trim().max(500).nullable().optional().transform((v) => (v === undefined ? undefined : v || null)),
    start_date: date,
    end_date: date,
  })
  .refine((s) => !s.start_date || !s.end_date || s.end_date >= s.start_date, { path: ["end_date"], message: "End date must be on or after the start date" });

export const sprintParam = z.object({ key: z.string(), id: z.coerce.number().int().positive() });

/** Where unfinished items go when a sprint completes: the backlog (null) or a planned sprint. */
export const completeSprintSchema = z.object({ move_to_sprint_id: z.coerce.number().int().positive().nullable().default(null) });

export type SprintInput = { name: string; goal: string | null; start_date: string | null; end_date: string | null };
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;
