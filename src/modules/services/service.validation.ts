import { z } from "zod";
import { optionalText } from "../../utils/zod-helpers.js";

export const serviceBodySchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,20}$/, "Use 2–20 letters, digits or dashes (e.g. BK-M)"),
  name: z.string().trim().min(2, "Enter a name").max(150),
  description: optionalText(500),
});

export const serviceUpdateSchema = serviceBodySchema.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type ServiceInput = z.infer<typeof serviceBodySchema>;
export type ServiceUpdateInput = z.infer<typeof serviceUpdateSchema>;
