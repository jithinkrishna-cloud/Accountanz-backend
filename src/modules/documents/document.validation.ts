import { z } from "zod";
import { createFolderSchema } from "../document-folders/document-folder.validation.js";
import { listQuerySchema } from "../../utils/pagination.js";
import { periodSchema } from "../../utils/zod-helpers.js";
import { DOCUMENT_CATEGORIES, DOCUMENT_STATUSES, REQUEST_STATUSES } from "./document.types.js";

const blankToUndefined = z.literal("").transform(() => undefined);

export const documentListQuerySchema = listQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
});

export const requestListQuerySchema = listQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
  status: z.enum(REQUEST_STATUSES).default("open"),
});

export const documentStatusSchema = z.object({ status: z.enum(DOCUMENT_STATUSES) });

/** Staff ask a client for a document, optionally for a period and one of the client's tasks. */
export const createRequestSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  description: z.string().trim().min(3, "Describe what you need").max(500),
  period: periodSchema.nullish().transform((v) => v ?? null),
  due_date: z.iso.date("Use a valid date").nullish().transform((v) => v ?? null),
  task_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null),
});

/** Staff upload (multipart fields), e.g. a document the client sent by e-mail or WhatsApp. */
export const staffUploadSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  category: z.enum(DOCUMENT_CATEGORIES).default("other"),
  period: periodSchema.optional().or(blankToUndefined),
  task_id: z.coerce.number().int().positive().optional().or(blankToUndefined),
  /** Document Centre folder to file it in (blank = top level). */
  folder_id: z.coerce.number().int().positive().optional().or(blankToUndefined),
});

export const staffFolderListQuerySchema = z.object({ client_id: z.coerce.number().int().positive() });
export const staffCreateFolderSchema = createFolderSchema.extend({ client_id: z.coerce.number().int().positive() });

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
export type RequestListQuery = z.infer<typeof requestListQuerySchema>;
export type DocumentStatusInput = z.infer<typeof documentStatusSchema>;
export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type StaffUploadInput = z.infer<typeof staffUploadSchema>;
export type StaffCreateFolderInput = z.infer<typeof staffCreateFolderSchema>;
