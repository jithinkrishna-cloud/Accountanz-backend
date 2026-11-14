import { z } from "zod";
import { SPACE_ROLES, STATUS_CATEGORIES, TEMPLATES } from "./project.types.js";

export const spaceKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2–10 letters or digits, starting with a letter");

const nullableId = z.coerce.number().int().positive().nullable().optional();
const optionalDescription = z.string().trim().max(1000).nullable().optional().transform((v) => v || null);

export const createSpaceSchema = z.object({
  name: z.string().trim().min(2, "Enter a name").max(80),
  space_key: spaceKeySchema,
  template: z.enum(TEMPLATES),
  client_id: nullableId,
  description: optionalDescription,
});

export const updateSpaceSchema = z.object({
  name: z.string().trim().min(2, "Enter a name").max(80).optional(),
  client_id: nullableId,
  description: optionalDescription,
});

export const keyParam = z.object({ key: spaceKeySchema });
export const keyAvailableQuery = z.object({ key: spaceKeySchema });
export const searchQuery = z.object({ q: z.string().trim().max(100).optional() });

export const statusSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(40),
  category: z.enum(STATUS_CATEGORIES),
});
export const updateStatusSchema = statusSchema.partial();
export const statusIdParam = z.object({ key: spaceKeySchema, id: z.coerce.number().int().positive() });
export const deleteStatusSchema = z.object({ move_to_status_id: z.coerce.number().int().positive() });
export const reorderStatusesSchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1) });

export const addMembersSchema = z.object({
  user_ids: z.array(z.coerce.number().int().positive()).min(1, "Pick at least one person").max(50),
  role: z.enum(SPACE_ROLES),
});
export const memberParam = z.object({ key: spaceKeySchema, userId: z.coerce.number().int().positive() });
export const updateMemberSchema = z.object({ role: z.enum(SPACE_ROLES) });

export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;
export type UpdateSpaceInput = z.infer<typeof updateSpaceSchema>;
export type StatusInput = z.infer<typeof statusSchema>;
export type AddMembersInput = z.infer<typeof addMembersSchema>;
