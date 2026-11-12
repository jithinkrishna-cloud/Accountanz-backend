import { z } from "zod";
import { RECURRENCES } from "./task-template.types.js";

export const templateBodySchema = z.object({
  name: z.string().trim().min(2, "Enter a template name").max(150),
  service_id: z.coerce.number().int().positive("Pick a service"),
  recurrence: z.enum(RECURRENCES).default("monthly"),
  due_day_of_period: z.coerce.number().int().min(1, "Use a day from 1 to 31").max(31, "Use a day from 1 to 31"),
});

export const itemBodySchema = z.object({
  title: z.string().trim().min(2, "Enter a title").max(200),
  checklist: z
    .array(z.string().trim().max(200))
    .transform((points) => points.filter(Boolean))
    .pipe(z.array(z.string()).min(1, "Add at least one checklist point").max(30, "Use at most 30 points")),
  client_visible: z.boolean().default(true),
});

export const itemUpdateSchema = itemBodySchema.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const itemIdParam = z.object({ itemId: z.coerce.number().int().positive() });

export type TemplateInput = z.infer<typeof templateBodySchema>;
export type ItemInput = z.infer<typeof itemBodySchema>;
export type ItemUpdateInput = z.infer<typeof itemUpdateSchema>;
export type ItemIdParam = z.infer<typeof itemIdParam>;
