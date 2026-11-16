import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { clientScope, isAdmin, requireClientAccess } from "../access/client-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyMeetingCancelled, notifyMeetingRequestDeclined, notifyMeetingScheduled, notifyMentioned, notifyTeamMessage } from "../notifications/notification.service.js";
import * as repo from "./communication.repository.js";
import type { MeetingListQuery, MeetingRequestListQuery, NewMeetingInput, NewThreadInput, ThreadListQuery } from "./communication.validation.js";

/**
 * Staff side of client communication. Client threads are the same conversations the client sees in the portal;
 * internal threads are never returned by the client portal (it filters visibility = 'client').
 */
export const listThreads = (actor: AuthUser, q: ThreadListQuery) => repo.listThreads(q, clientScope(actor, "t.client_id"), actor.id);

async function requireThread(actor: AuthUser, id: number) {
  const thread = await repo.findThread(id);
  if (!thread) throw AppError.notFound("Conversation");
  await requireClientAccess(actor, thread.client_id, "Conversation");
  return thread;
}

/** Messages with their @mentions as an array (never null). */
export const messagesWithMentions = <M extends { mentions: { user_id: number; full_name: string }[] | null }>(rows: M[]) =>
  rows.map((m) => ({ ...m, mentions: m.mentions ?? [] }));

export async function getThread(actor: AuthUser, id: number) {
  const thread = await requireThread(actor, id);
  return { ...thread, items: messagesWithMentions(await repo.threadMessages(id)) };
}

// ── @mentions ──
/** Who can be mentioned: the client's team today, plus the client's portal users on client-visible threads. */
export const mentionableFor = (clientId: number, visibility: "client" | "internal") => repo.mentionable(clientId, visibility === "client");

export async function listMentionable(actor: AuthUser, clientId: number, visibility: "client" | "internal") {
  await requireClientAccess(actor, clientId);
  return (await mentionableFor(clientId, visibility)).filter((p) => p.user_id !== actor.id).map(({ email: _email, ...p }) => p);
}

/** Keeps only people who may be mentioned here (and not the author). Unknown ids are an error, not silently dropped. */
export async function resolveMentions(clientId: number, visibility: "client" | "internal", ids: number[], authorId: number) {
  if (!ids.length) return [];
  const allowed = await mentionableFor(clientId, visibility);
  const unique = [...new Set(ids)].filter((id) => id !== authorId);
  const picked = unique.map((id) => allowed.find((p) => p.user_id === id));
  if (picked.some((p) => !p)) throw new AppError("VALIDATION_ERROR", "You can only mention people on this client's conversation", { fieldErrors: { mentions: ["Mention someone in this conversation"] } });
  return picked as repo.Mentionable[];
}

export async function startThread(actor: AuthUser, input: NewThreadInput) {
  await requireClientAccess(actor, input.client_id);
  const mentioned = await resolveMentions(input.client_id, input.visibility, input.mentions, actor.id);
  const { threadId, messageId } = await withTransaction(async (conn) => {
    const tid = await repo.insertThread(input.client_id, input.visibility, input.subject, actor.id, conn);
    const mid = await repo.insertMessage(tid, actor.id, input.body, conn);
    await repo.saveMentions(mid, mentioned.map((p) => p.user_id), conn);
    return { threadId: tid, messageId: mid };
  });
  const message = { clientId: input.client_id, threadId, messageId, authorId: actor.id, author: actor.fullName, subject: input.subject, body: input.body, visibility: input.visibility };
  void notifyMentioned({ ...message, mentioned });
  void notifyTeamMessage({ ...message, skipEmails: mentioned.map((p) => p.email) });
  return getThread(actor, threadId);
}

export async function reply(actor: AuthUser, threadId: number, body: string, mentionIds: number[] = []) {
  const thread = await requireThread(actor, threadId);
  const mentioned = await resolveMentions(thread.client_id, thread.visibility, mentionIds, actor.id);
  const messageId = await withTransaction(async (conn) => {
    const mid = await repo.insertMessage(threadId, actor.id, body, conn);
    await repo.saveMentions(mid, mentioned.map((p) => p.user_id), conn);
    return mid;
  });
  const message = { clientId: thread.client_id, threadId, messageId, authorId: actor.id, author: actor.fullName, subject: thread.subject ?? "Conversation", body, visibility: thread.visibility };
  void notifyMentioned({ ...message, mentioned });
  void notifyTeamMessage({ ...message, skipEmails: mentioned.map((p) => p.email) });
  return getThread(actor, threadId);
}

/**
 * The author corrects their own message, only within MESSAGE_EDIT_MINUTES of sending it. Shared by the team
 * and client portal routes (each checks the caller may see the thread first). Only newly @mentioned people are notified.
 */
export async function editOwnMessage(
  actor: AuthUser,
  thread: { id: number; client_id: number; visibility: "client" | "internal"; subject: string | null },
  messageId: number,
  body: string,
  mentionIds: number[] = [],
) {
  const message = await repo.findMessage(thread.id, messageId);
  if (!message) throw AppError.notFound("Message");
  if (message.author_id !== actor.id) throw AppError.forbidden("You can only edit your own messages");
  if (!message.editable) throw AppError.conflict(`Messages can only be edited for ${repo.MESSAGE_EDIT_MINUTES} minutes after sending`);
  const mentioned = await resolveMentions(thread.client_id, thread.visibility, mentionIds, actor.id);
  const before = await withTransaction(async (conn) => {
    if (!(await repo.updateOwnMessage(thread.id, messageId, actor.id, body, conn))) {
      throw AppError.conflict(`Messages can only be edited for ${repo.MESSAGE_EDIT_MINUTES} minutes after sending`);
    }
    return repo.replaceMentions(messageId, mentioned.map((p) => p.user_id), conn);
  });
  await recordAudit(actor, { action: "Message edited", entityType: "Message", entityId: messageId, clientId: thread.client_id, details: thread.subject ?? undefined });
  const added = mentioned.filter((p) => !before.includes(p.user_id));
  void notifyMentioned({ clientId: thread.client_id, threadId: thread.id, messageId, authorId: actor.id, author: actor.fullName, subject: thread.subject ?? "Conversation", body, mentioned: added });
}

export async function editMessage(actor: AuthUser, threadId: number, messageId: number, body: string, mentionIds: number[] = []) {
  const thread = await requireThread(actor, threadId);
  await editOwnMessage(actor, thread, messageId, body, mentionIds);
  return getThread(actor, threadId);
}

// ── Meetings ──
export const listMeetings = (actor: AuthUser, q: MeetingListQuery) => repo.listMeetings(q, clientScope(actor, "mt.client_id"));

/** DATETIME columns hold UTC (the portal compares them with UTC_TIMESTAMP()). */
const toUtcDateTime = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace("T", " ");
const formatWhen = (iso: string) => `${new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST`;

/** `alsoInTransaction` runs inside the meeting's transaction (used to close the client's request atomically). */
export async function scheduleMeeting(actor: AuthUser, input: NewMeetingInput, alsoInTransaction?: (meetingId: number, conn: PoolConnection) => Promise<void>) {
  await requireClientAccess(actor, input.client_id);
  const [team, clientUsers, organiser] = await Promise.all([repo.clientTeamUsers(input.client_id), input.invite_client ? repo.clientPortalUsers(input.client_id) : [], repo.findUserContact(actor.id)]);
  const invalid = input.staff_ids.filter((id) => !team.some((t) => t.id === id));
  if (invalid.length) throw new AppError("VALIDATION_ERROR", "Only people on this client's team can be invited", { fieldErrors: { staff_ids: ["Choose people on this client's team"] } });
  if (!input.invite_client && input.staff_ids.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Invite the client or at least one colleague", { fieldErrors: { staff_ids: ["Invite the client or a colleague"] } });
  }

  const staff = team.filter((t) => input.staff_ids.includes(t.id) && t.id !== actor.id);
  const attendees = [
    ...(organiser ? [{ ...organiser, isClient: false }] : []),
    ...staff.map((s) => ({ ...s, isClient: false })),
    ...clientUsers.map((c) => ({ ...c, isClient: true })),
  ];
  const id = await withTransaction(async (conn) => {
    const meetingId = await repo.insertMeeting(
      { clientId: input.client_id, organiserId: actor.id, title: input.title, startsAt: toUtcDateTime(input.starts_at), endsAt: toUtcDateTime(input.ends_at), link: input.meeting_link },
      conn,
    );
    await repo.insertAttendees(meetingId, attendees.map((a) => ({ email: a.email, userId: a.id })), conn);
    await recordAudit(actor, { action: "Meeting scheduled", entityType: "Meeting", entityId: meetingId, clientId: input.client_id, details: `${input.title} · ${formatWhen(input.starts_at)}` }, conn);
    if (alsoInTransaction) await alsoInTransaction(meetingId, conn);
    return meetingId;
  });
  void notifyMeetingScheduled(id, {
    clientId: input.client_id,
    organiser: actor.fullName,
    title: input.title,
    when: formatWhen(input.starts_at),
    link: input.meeting_link,
    attendees: attendees.filter((a) => a.id !== actor.id).map((a) => ({ email: a.email, name: a.full_name, isClient: a.isClient })),
  });
  return (await repo.findMeeting(id))!;
}

/** The organiser (or an admin) can cancel a meeting that hasn't started. */
export async function cancelMeeting(actor: AuthUser, id: number) {
  const meeting = await repo.findMeeting(id);
  if (!meeting) throw AppError.notFound("Meeting");
  await requireClientAccess(actor, meeting.client_id, "Meeting");
  if (meeting.organiser_id !== actor.id && !isAdmin(actor)) throw AppError.forbidden("Only the organiser or an admin can cancel this meeting");
  if (!meeting.upcoming) throw AppError.conflict("This meeting has already started");
  const when = formatWhen(`${meeting.starts_at.replace(" ", "T")}Z`);
  const attendees = await withTransaction(async (conn) => {
    const invited = await repo.meetingAttendees(id, meeting.client_id, conn);
    await repo.deleteMeeting(id, conn);
    await recordAudit(actor, { action: "Meeting cancelled", entityType: "Meeting", entityId: id, clientId: meeting.client_id, details: `${meeting.title} · ${when}` }, conn);
    return invited;
  });
  void notifyMeetingCancelled(id, {
    clientId: meeting.client_id,
    cancelledBy: actor.fullName,
    title: meeting.title,
    when,
    attendees: attendees.filter((a) => a.email !== actor.email).map((a) => ({ email: a.email, name: a.full_name ?? a.email, isClient: a.is_client === 1 })),
  });
}

// ── Meeting requests from clients ──
export const listMeetingRequests = (actor: AuthUser, q: MeetingRequestListQuery) => repo.listMeetingRequests(q, clientScope(actor, "r.client_id"));

const ALREADY_ANSWERED = "Someone has already answered this request";

async function requirePendingRequest(actor: AuthUser, id: number) {
  const request = await repo.findMeetingRequest(id);
  if (!request) throw AppError.notFound("Meeting request");
  await requireClientAccess(actor, request.client_id, "Meeting request");
  if (request.status !== "pending") throw AppError.conflict(request.status === "withdrawn" ? "The client withdrew this request" : ALREADY_ANSWERED);
  return request;
}

/** Schedules the meeting and closes the request in one transaction, so two colleagues can't both schedule it. */
export async function scheduleFromRequest(actor: AuthUser, id: number, input: NewMeetingInput) {
  const request = await requirePendingRequest(actor, id);
  if (input.client_id !== request.client_id) throw new AppError("VALIDATION_ERROR", "This request is from a different client");
  return scheduleMeeting(actor, input, async (meetingId, conn) => {
    if (!(await repo.closeMeetingRequest(id, { status: "scheduled", decidedBy: actor.id, meetingId }, conn))) throw AppError.conflict(ALREADY_ANSWERED);
    await recordAudit(actor, { action: "Meeting request scheduled", entityType: "MeetingRequest", entityId: id, clientId: request.client_id, details: request.topic }, conn);
  });
}

export async function declineMeetingRequest(actor: AuthUser, id: number, reason: string) {
  const request = await requirePendingRequest(actor, id);
  await withTransaction(async (conn) => {
    if (!(await repo.closeMeetingRequest(id, { status: "declined", decidedBy: actor.id, reason }, conn))) throw AppError.conflict(ALREADY_ANSWERED);
    await recordAudit(actor, { action: "Meeting request declined", entityType: "MeetingRequest", entityId: id, clientId: request.client_id, details: `${request.topic} · ${reason}` }, conn);
  });
  void notifyMeetingRequestDeclined(id, { clientId: request.client_id, requestedBy: request.requested_by, topic: request.topic, decidedBy: actor.fullName, reason });
}
