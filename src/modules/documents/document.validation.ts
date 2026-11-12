import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { DOCUMENT_CATEGORIES, DOCUMENT_STATUSES } from "./document.types.js";

export const documentListQuerySchema = listQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
});

export const documentStatusSchema = z.object({ status: z.enum(DOCUMENT_STATUSES) });

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
export type DocumentStatusInput = z.infer<typeof documentStatusSchema>;
