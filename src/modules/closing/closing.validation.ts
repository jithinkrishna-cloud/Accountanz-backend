import { z } from "zod";
import { periodSchema } from "../../utils/zod-helpers.js";
import { CLOSING_STATUSES } from "./closing.types.js";

export const closingParams = z.object({
  clientId: z.coerce.number().int().positive(),
  period: periodSchema,
});

export const closingStatusSchema = z.object({ status: z.enum(CLOSING_STATUSES) });

export type ClosingParams = z.infer<typeof closingParams>;
export type ClosingStatusInput = z.infer<typeof closingStatusSchema>;
