import { z } from "zod";
import { optionalText, periodSchema } from "../../utils/zod-helpers.js";
import { DOCUMENT_CATEGORIES } from "../documents/document.types.js";
import { NOTIFICATION_PREFS } from "./client-portal.types.js";

export const uploadMetaSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).default("other"),
  period: periodSchema.optional().or(z.literal("").transform(() => undefined)),
  request_id: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
});

export const tasksQuerySchema = z.object({ period: periodSchema.optional() });

export const approvalDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    comment: optionalText(1000),
  })
  .refine((v) => v.decision === "approved" || !!v.comment, { path: ["comment"], message: "Tell your team why you're rejecting this" });

export const newThreadSchema = z.object({
  subject: z.string().trim().min(2, "Add a subject").max(200),
  body: z.string().trim().min(1, "Write a message").max(5000),
});

export const replySchema = z.object({ body: z.string().trim().min(1, "Write a message").max(5000) });

export const settingsSchema = z
  .object({
    full_name: z.string().trim().min(2, "Enter your name").max(150),
    phone: optionalText(30),
    notification_prefs: z.object(Object.fromEntries(NOTIFICATION_PREFS.map((k) => [k, z.boolean()])) as Record<(typeof NOTIFICATION_PREFS)[number], z.ZodBoolean>),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type UploadMeta = z.infer<typeof uploadMetaSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type NewThreadInput = z.infer<typeof newThreadSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
