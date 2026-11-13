import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { periodSchema } from "../../utils/zod-helpers.js";
import { REPORT_TYPES } from "./report.types.js";

export const reportListQuerySchema = listQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
  state: z.enum(["draft", "published"]).optional(),
});

/** Multipart fields of a new report draft; the file is optional (a summary-only update is allowed). */
export const createReportSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  period: periodSchema,
  report_type: z.enum(REPORT_TYPES),
  summary: z
    .string()
    .trim()
    .max(2000, "Keep the summary under 2000 characters")
    .optional()
    .transform((v) => v || null),
});

export type ReportListQuery = z.infer<typeof reportListQuerySchema>;
export type CreateReportInput = z.infer<typeof createReportSchema>;
