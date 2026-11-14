import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { CONNECTION_STATUSES, PROVIDERS } from "./integration.types.js";

export const integrationListQuerySchema = listQuerySchema.extend({
  provider: z.enum(PROVIDERS).optional(),
  status: z.enum(CONNECTION_STATUSES).optional(),
});

export type IntegrationListQuery = z.infer<typeof integrationListQuerySchema>;

/** Period for the read-only JournL view. Defaults: Indian financial year start (1 April) to today. */
export const journlDataQuerySchema = z
  .object({
    from: z.iso.date("Use a valid date").optional(),
    to: z.iso.date("Use a valid date").optional(),
  })
  .transform((q) => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const [y, m] = today.split("-").map(Number);
    const fyStart = `${m >= 4 ? y : y - 1}-04-01`;
    return { from: q.from ?? fyStart, to: q.to ?? today };
  })
  .refine((q) => q.from <= q.to, { message: "The start date must be on or before the end date", path: ["from"] });
export type JournlDataQuery = z.infer<typeof journlDataQuerySchema>;
