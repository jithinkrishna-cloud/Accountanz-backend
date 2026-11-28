import { z } from "zod";
import { optionalText, periodSchema } from "../../utils/zod-helpers.js";
import { mentionsSchema } from "../communication/communication.validation.js";
import { DOCUMENT_CATEGORIES } from "../documents/document.types.js";
import { financialProfileSchema, portalClientUpdateSchema, stakeholderSchema } from "../clients/client.validation.js";
import { serviceRequirementsSchema } from "../onboarding/onboarding.validation.js";
import { NOTIFICATION_PREFS } from "./client-portal.types.js";

/**
 * What a company owner may change about their own company from the portal (Settings → business details).
 * Everything on the client record except status (company names, type, registrations, address, accounting software
 * and primary contact), which stays with Accountanz. Same rules as the admin form; a blank value clears the field. Defined next to the client schemas so it
 * shares their default-free fields.
 */
export { portalClientUpdateSchema };

/*
 * The rest of My Business, as the portal sees it. Stakeholders' personal identifiers and contact details and the team's
 * internal notes are never sent to the portal, so they aren't accepted from it either; saves keep the stored values.
 */
export const portalStakeholderSchema = stakeholderSchema.pick({ stakeholder_type: true, full_name: true, designation: true, ownership_percentage: true, is_primary: true });
export const portalFinancialProfileSchema = financialProfileSchema.omit({ notes: true });
export const portalServicesSchema = serviceRequirementsSchema.omit({ notes: true });
export const portalStakeholderParams = z.object({ id: z.coerce.number().int().positive() });

export const uploadMetaSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).default("other"),
  period: periodSchema.optional().or(z.literal("").transform(() => undefined)),
  request_id: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
  /** Document Centre folder to put the file in; blank = top level. */
  folder_id: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
});

export const tasksQuerySchema = z.object({ period: periodSchema.optional() });

/** Company owner asks for a task. People and engagement are assigned automatically. */
export const clientTaskSchema = z.object({
  title: z.string().trim().min(2, "Enter a title").max(200),
  description: optionalText(5000),
  due_date: z.iso.date("Pick a due date"),
  checklist: z
    .array(z.string().trim().max(200, "Keep each point under 200 characters"))
    .default([])
    .transform((points) => points.filter(Boolean))
    .pipe(z.array(z.string()).max(30, "Use at most 30 points")),
});
export type ClientTaskInput = z.infer<typeof clientTaskSchema>;

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
export type MeetingRequestInput = z.infer<typeof meetingRequestSchema>;
export type PortalClientUpdateInput = z.infer<typeof portalClientUpdateSchema>;
