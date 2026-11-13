import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { APPROVAL_STATUSES } from "./approval.types.js";

export const approvalListQuerySchema = listQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
  status: z.enum(APPROVAL_STATUSES).optional(),
});

/** Staff ask the client's owner (or anyone allowed to approve) to sign off on something. */
export const createApprovalSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  subject: z.string().trim().min(3, "Say what needs approval").max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((v) => v || null),
  related_task_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null),
});

export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;
export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;
