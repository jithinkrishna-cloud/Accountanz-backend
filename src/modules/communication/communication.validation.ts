import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { THREAD_VISIBILITIES } from "./communication.types.js";

const body = z.string().trim().min(1, "Write a message").max(5000, "Keep messages under 5000 characters");

export const threadListQuerySchema = listQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
  visibility: z.enum(THREAD_VISIBILITIES).optional(),
});

/** "client" threads are shared with the client; "internal" threads are staff-only discussion about the client. */
export const newThreadSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  visibility: z.enum(THREAD_VISIBILITIES),
  subject: z.string().trim().min(2, "Add a subject").max(200),
  body,
});

export const replySchema = z.object({ body });

export const meetingListQuerySchema = listQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
  when: z.enum(["upcoming", "past"]).default("upcoming"),
});

export const newMeetingSchema = z
  .object({
    client_id: z.coerce.number().int().positive(),
    title: z.string().trim().min(2, "Add a title").max(200),
    starts_at: z.iso.datetime({ offset: true, message: "Choose a start time" }),
    ends_at: z.iso.datetime({ offset: true, message: "Choose an end time" }),
    meeting_link: z
      .url("Enter a valid link")
      .max(500)
      .nullish()
      .or(z.literal("").transform(() => null))
      .transform((v) => v ?? null),
    /** Invite the client's portal users. */
    invite_client: z.boolean().default(true),
    /** Colleagues on the client's team to invite (the organiser always attends). */
    staff_ids: z.array(z.coerce.number().int().positive()).max(20).default([]),
  })
  .refine((v) => new Date(v.ends_at) > new Date(v.starts_at), { path: ["ends_at"], message: "End after the start" })
  .refine((v) => new Date(v.starts_at) > new Date(), { path: ["starts_at"], message: "Choose a time in the future" });

export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;
export type NewThreadInput = z.infer<typeof newThreadSchema>;
export type ReplyInput = z.infer<typeof replySchema>;
export type MeetingListQuery = z.infer<typeof meetingListQuerySchema>;
export type NewMeetingInput = z.infer<typeof newMeetingSchema>;
