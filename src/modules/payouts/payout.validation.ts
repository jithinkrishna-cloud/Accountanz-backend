import { z } from "zod";
import { optionalText, periodSchema } from "../../utils/zod-helpers.js";

export const payoutPeriodQuerySchema = z.object({ period: periodSchema });
export const generateRunSchema = z.object({ period: periodSchema });
export const markPaidSchema = z.object({ reference: optionalText(100) });

export type PayoutPeriodQuery = z.infer<typeof payoutPeriodQuerySchema>;
export type MarkPaidInput = z.infer<typeof markPaidSchema>;
