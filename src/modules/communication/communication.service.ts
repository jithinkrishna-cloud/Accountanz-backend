import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { clientScope, isAdmin, requireClientAccess } from "../access/client-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyMeetingCancelled, notifyMeetingRequestDeclined, notifyMeetingScheduled, notifyTeamMessage } from "../notifications/notification.service.js";
import * as repo from "./communication.repository.js";
import type { MeetingListQuery, MeetingRequestListQuery, NewMeetingInput, NewThreadInput, ThreadListQuery } from "./communication.validation.js";

/**
 * Staff side of client communication. Client threads are the same conversations the client sees in the portal;
 * internal threads are never returned by the client portal (it filters visibility = 'client').
 */
export const listThreads = (actor: AuthUser, q: ThreadListQuery) => repo.listThreads(q, clientScope(actor, "t.client_id"));

async function requireThread(actor: AuthUser, id: number) {
  const thread = await repo.findThread(id);
  if (!thread) throw AppError.notFound("Conversation");
  await requireClientAccess(actor, thread.client_id, "Conversation");
  return thread;
}

export async function getThread(actor: AuthUser, id: number) {
  const thread = await requireThread(actor, id);
  return { ...thread, items: await repo.threadMessages(id) };
}

export async function startThread(actor: AuthUser, input: NewThreadInput) {
  await requireClientAccess(actor, input.client_id);
  const { threadId, messageId } = await withTransaction(async (conn) => {
    const tid = await repo.insertThread(input.client_id, input.visibility, input.subject, actor.id, conn);
    return { threadId: tid, messageId: await repo.insertMessage(tid, actor.id, input.body, conn) };
  });
  void notifyTeamMessage({ clientId: input.client_id, threadId, messageId, authorId: actor.id, author: actor.fullName, subject: input.subject, body: input.body, visibility: input.visibility });
  return getThread(actor, threadId);
}

export async function reply(actor: AuthUser, threadId: number, body: string) {
  const thread = await requireThread(actor, threadId);
  const messageId = await withTransaction((conn) => repo.insertMessage(threadId, actor.id, body, conn));
  void notifyTeamMessage({
    clientId: thread.client_id,
    threadId,
    messageId,
    authorId: actor.id,
    author: actor.fullName,
    subject: thread.subject ?? "Conversation",
    body,
    visibility: thread.visibility,
  });
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
