import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { optionalText } from "../../utils/zod-helpers.js";

export const teamListQuerySchema = listQuerySchema;
export const clientIdParam = z.object({ clientId: z.coerce.number().int().positive() });
export const teamNameSchema = z.object({ name: z.string().trim().min(2, "Enter a team name").max(150) });

/** Name is optional: it defaults to the client name plus "Team". */
export const createTeamSchema = z.object({
  client_id: z.coerce.number().int().positive("Pick a client"),
  name: optionalText(150).refine((v) => v === null || v.length >= 2, "Enter at least 2 characters"),
});

export type TeamListQuery = z.infer<typeof teamListQuerySchema>;
export type ClientIdParam = z.infer<typeof clientIdParam>;
export type TeamNameInput = z.infer<typeof teamNameSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
