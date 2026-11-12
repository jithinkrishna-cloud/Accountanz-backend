import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { optionalText } from "../../utils/zod-helpers.js";
import { CONNECTION_STATUSES, PROVIDERS } from "./integration.types.js";

export const integrationListQuerySchema = listQuerySchema.extend({
  provider: z.enum(PROVIDERS).optional(),
  status: z.enum(CONNECTION_STATUSES).optional(),
});

export const createConnectionSchema = z.object({
  client_id: z.coerce.number().int().positive("Pick a client"),
  provider: z.enum(PROVIDERS),
  external_org_name: optionalText(200),
  external_org_id: optionalText(100),
});

export type IntegrationListQuery = z.infer<typeof integrationListQuerySchema>;
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
