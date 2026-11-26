import { z } from "zod";
import { SPACE_ROLES, STATUS_CATEGORIES, TEMPLATES } from "./project.types.js";

export const spaceKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2–10 letters or digits, starting with a letter");

const nullableId = z.coerce.number().int().positive().nullable().optional();
const optionalDescription = z.string().trim().max(1000).nullable().optional().transform((v) => v || null);

export const createSpaceSchema = z
  .object({
    name: z.string().trim().min(2, "Enter a name").max(80),
    space_key: spaceKeySchema,
    template: z.enum(TEMPLATES),
    kind: z.enum(["internal", "client_project"]).default("internal"),
    client_id: nullableId,
    description: optionalDescription,
  })
  .superRefine((v, ctx) => {
    if (v.kind === "internal" && v.client_id) ctx.addIssue({ code: "custom", path: ["client_id"], message: "Internal spaces can't be linked to a client" });
    if (v.kind === "client_project" && !v.client_id) ctx.addIssue({ code: "custom", path: ["client_id"], message: "Choose a client" });
  });

export const updateSpaceSchema = z.object({
  name: z.string().trim().min(2, "Enter a name").max(80).optional(),
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

export const clientSpaceQuery = z.object({ client_id: z.coerce.number().int().positive() });
export const provisionSchema = z.object({ client_id: z.coerce.number().int().positive() });

const today = () => new Date().toISOString().slice(0, 10);
export const grantOverrideSchema = z.object({
  limit_type: z.enum(["workspaces", "staff_per_workspace"]),
  extra: z.coerce.number().int().min(1, "Enter 1 to 99").max(99, "Enter 1 to 99"),
  reason: z.string().trim().min(3, "Enter a reason").max(500),
  expires_at: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Use a date")
    .refine((v) => v >= today(), "Choose today or a later date")
    .nullable()
    .optional(),
});
export const overrideParam = z.object({ key: spaceKeySchema, id: z.coerce.number().int().positive() });

export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;
export type GrantOverrideInput = z.infer<typeof grantOverrideSchema>;
export type UpdateSpaceInput = z.infer<typeof updateSpaceSchema>;
export type StatusInput = z.infer<typeof statusSchema>;
export type AddMembersInput = z.infer<typeof addMembersSchema>;
