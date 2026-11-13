import { z } from "zod";

export const modulePermissionParams = z.object({
  id: z.coerce.number().int().positive(),
  moduleKey: z.string().regex(/^[a-z0-9_]{1,50}$/, "Unknown module"),
});

/** Action keys come from the catalogue; an empty list revokes the module. */
export const modulePermissionBody = z.object({
  actions: z.array(z.string().regex(/^[a-z0-9_]{1,50}$/)).max(50),
});

export type ModulePermissionParams = z.infer<typeof modulePermissionParams>;
export type ModulePermissionBody = z.infer<typeof modulePermissionBody>;
