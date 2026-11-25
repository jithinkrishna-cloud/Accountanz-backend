import { z } from "zod";

/** Plain names only: no slashes (they'd read as a path). */
export const folderName = z
  .string()
  .trim()
  .min(1, "Enter a folder name")
  .max(100, "Keep folder names under 100 characters")
  .refine((n) => !/[\\/]/.test(n), "Folder names can't contain / or \\")
  .refine((n) => n !== "." && n !== "..", "Pick a different name");

export const createFolderSchema = z.object({
  name: folderName,
  parent_id: z.coerce.number().int().positive().nullable().default(null),
});

export const renameFolderSchema = z.object({ name: folderName });

/** The full list of people the folder should be shared with (empty = private again). */
export const shareFolderSchema = z.object({ user_ids: z.array(z.coerce.number().int().positive()).max(50) });

/** Answer a document request with a file already in the Document Centre. */
export const attachDocumentSchema = z.object({ document_id: z.coerce.number().int().positive("Pick a file") });

export const moveDocumentSchema = z.object({ folder_id: z.coerce.number().int().positive().nullable() });

export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type RenameFolderInput = z.infer<typeof renameFolderSchema>;
export type MoveDocumentInput = z.infer<typeof moveDocumentSchema>;
