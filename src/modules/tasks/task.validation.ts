import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { optionalText, periodSchema } from "../../utils/zod-helpers.js";
import { TASK_SOURCES, TASK_STATUSES } from "./task.types.js";

export const taskListQuerySchema = listQuerySchema.extend({
  status: z.enum(TASK_STATUSES).optional(),
  period: periodSchema.optional(),
  source: z.enum(TASK_SOURCES).optional(),
  /** Accountant portal: "mine" = assigned to me, "clients" = every task on my clients (managers only). */
  scope: z.enum(["mine", "clients"]).default("mine"),
});

export const generateTasksSchema = z.object({ period: periodSchema });

const checklistTexts = z
  .array(z.string().trim().max(200, "Keep each point under 200 characters"))
  .transform((points) => points.filter(Boolean))
  .pipe(z.array(z.string()).min(1, "Add at least one checklist point").max(30, "Use at most 30 points"));

const taskFields = {
  title: z.string().trim().min(2, "Enter a title").max(200),
  description: optionalText(5000),
  assignee_id: z.coerce.number().int().positive("Pick an assignee"),
  reviewer_id: z.coerce.number().int().positive("Pick a reviewer"),
  period: periodSchema.optional(),
  due_date: z.iso.date("Pick a due date"),
  client_visible: z.boolean().default(true),
  checklist: checklistTexts,
};

export const createTaskSchema = z.object({
  client_id: z.coerce.number().int().positive("Pick a client"),
  engagement_id: z.coerce.number().int().positive("Pick an engagement"),
  ...taskFields,
});

export const updateTaskSchema = z
  .object(taskFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const checklistProgressSchema = z.object({ done: z.array(z.boolean()).min(1).max(30) });

export const workLogSchema = z.object({
  minutes: z.coerce.number().int("Use whole minutes").min(1, "Log at least 1 minute").max(720, "Log at most 12 hours per entry"),
  note: optionalText(500),
  logged_on: z.iso.date("Pick the date"),
});

export const optionsQuerySchema = z.object({ client_id: z.coerce.number().int().positive().optional() });

export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type GenerateTasksInput = z.infer<typeof generateTasksSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type WorkLogInput = z.infer<typeof workLogSchema>;
