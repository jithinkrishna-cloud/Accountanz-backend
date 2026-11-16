import { z } from "zod";
import { optionalText, periodSchema } from "../../utils/zod-helpers.js";
import { mentionsSchema } from "../communication/communication.validation.js";
import { DOCUMENT_CATEGORIES } from "../documents/document.types.js";
import { clientBodySchema } from "../clients/client.validation.js";
import { NOTIFICATION_PREFS } from "./client-portal.types.js";

/**
 * What a company owner may change about their own company from the portal (Settings → business details).
 * Legal name, GSTIN, PAN and everything else are admin-only; clients ask for those via "Request correction".
 * Same rules as the admin form. A blank value clears the field.
 */
export const portalClientUpdateSchema = clientBodySchema.pick({ trade_name: true, state: true, address: true }).partial();

export const uploadMetaSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).default("other"),
  period: periodSchema.optional().or(z.literal("").transform(() => undefined)),
  request_id: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
});

/** "Sign in with JournL": the owner's JournL login, forwarded once to JournL and never stored. */
export const connectJournlSchema = z.object({
  journl_email: z.email("Enter your JournL email").max(150),
  journl_password: z.string().min(1, "Enter your JournL password").max(128),
  /** Needed only when the JournL account owns more than one company. */
  company_id: z.string().trim().max(100).optional(),
  authorize: z.literal(true, "Tick the box to authorize Accountanz"),
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
  mentions: mentionsSchema,
});

export const replySchema = z.object({ body: z.string().trim().min(1, "Write a message").max(5000), mentions: mentionsSchema });

export const MEETING_DURATIONS = [15, 30, 45, 60] as const;

/** A client asks for a meeting with 1-3 preferred start times; the team confirms one (or another time). */
export const meetingRequestSchema = z.object({
  topic: z.string().trim().min(2, "Tell us what you'd like to discuss").max(200),
  notes: optionalText(2000),
  preferred_times: z
    .array(z.iso.datetime({ offset: true, message: "Choose a date and time" }))
    .min(1, "Suggest at least one time")
    .max(3, "Suggest up to three times")
    .refine((ts) => ts.every((t) => new Date(t) > new Date()), "Suggest times in the future")
    .refine((ts) => new Set(ts.map((t) => new Date(t).getTime())).size === ts.length, "Suggest different times"),
  duration_minutes: z.coerce.number().refine((n) => (MEETING_DURATIONS as readonly number[]).includes(n), "Choose a length").default(30),
});

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
export type ReplyInput = z.infer<typeof replySchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
export type ConnectJournlInput = z.infer<typeof connectJournlSchema>;
export type MeetingRequestInput = z.infer<typeof meetingRequestSchema>;
export type PortalClientUpdateInput = z.infer<typeof portalClientUpdateSchema>;
