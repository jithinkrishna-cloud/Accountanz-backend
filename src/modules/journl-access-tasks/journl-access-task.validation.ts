import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { optionalText } from "../../utils/zod-helpers.js";
import { ACCESS_TASK_STATUSES } from "./journl-access-task.types.js";

export const accessTaskListQuerySchema = listQuerySchema.extend({
  status: z.enum(["open", "done", "all"]).default("open"),
  clientId: z.coerce.number().int().positive().optional(),
});

export const accessTaskUpdateSchema = z
  .object({
    status: z.enum(ACCESS_TASK_STATUSES).optional(),
    responsible_id: z.coerce.number().int().positive().nullish(),
    notes: optionalText(2000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  // Access only counts as changed once someone says how they confirmed it.
  .refine((v) => v.status !== "completed" || (v.notes?.length ?? 0) >= 3, { message: "Say how you confirmed it in JournL", path: ["notes"] });

export type AccessTaskListQuery = z.infer<typeof accessTaskListQuerySchema>;
export type AccessTaskUpdateInput = z.infer<typeof accessTaskUpdateSchema>;
