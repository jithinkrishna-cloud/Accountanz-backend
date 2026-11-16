import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import { activeAssignmentSql } from "../access/client-access.js";
import type { Scope } from "../documents/document.repository.js";
import type { MeetingRequestRow, MeetingRequestStatus, MeetingRow, MessageRow, ThreadRow, ThreadVisibility } from "./communication.types.js";
import type { MeetingListQuery, MeetingRequestListQuery, ThreadListQuery } from "./communication.validation.js";

const CLIENT_AUTHOR = `u.portal_role IN ('client_owner', 'client_member')`;
const LAST = (col: string) => `(SELECT ${col} FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;
const THREAD_COLUMNS = `t.id, t.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, t.subject, t.visibility, t.created_at,
  (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
  (SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = t.id) AS last_at,
  ${LAST("m.body")} AS last_body, ${LAST("u.full_name")} AS last_author, ${LAST("m.author_id")} AS last_author_id, ${LAST(CLIENT_AUTHOR)} AS last_from_client`;

/** `userId` marks (and, with q.mentioned, limits to) threads where that person has been @mentioned. */
export async function listThreads(q: ThreadListQuery, scope: Scope, userId: number): Promise<Paged<ThreadRow>> {
  const where = [scope.sql];
  const params: Param[] = [...scope.params];
  const mentionsMe = `(SELECT COUNT(*) FROM message_mentions mm JOIN messages mx ON mx.id = mm.message_id WHERE mx.thread_id = t.id AND mm.user_id = ?)`;
  if (q.mentioned) (where.push(`${mentionsMe} > 0`), params.push(userId));
  if (q.client_id) (where.push("t.client_id = ?"), params.push(q.client_id));
  if (q.visibility) (where.push("t.visibility = ?"), params.push(q.visibility));
  if (q.q) (where.push("(t.subject LIKE ? OR c.legal_name LIKE ? OR c.trade_name LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const from = `FROM message_threads t JOIN clients c ON c.id = t.client_id`;
  const items = await query<ThreadRow>(`SELECT ${THREAD_COLUMNS}, ${mentionsMe} AS mentions_me ${from} ${whereSql} ORDER BY COALESCE(last_at, t.created_at) DESC LIMIT ? OFFSET ?`, [
    userId,
    ...params,
    q.pageSize,
    offsetOf(q),
  ]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findThread = (id: number) =>
  queryOne<ThreadRow>(`SELECT ${THREAD_COLUMNS} FROM message_threads t JOIN clients c ON c.id = t.client_id WHERE t.id = ?`, [id]);

export const threadMessages = (threadId: number) =>
  query<MessageRow>(
    `SELECT m.id, m.body, m.created_at, ${MESSAGE_EDIT_SQL}, u.full_name AS author, m.author_id, COALESCE(${CLIENT_AUTHOR}, 0) AS from_client, ${MESSAGE_MENTIONS_SQL}
       FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = ? ORDER BY m.created_at, m.id`,
    [threadId],
  );

export async function insertThread(clientId: number, visibility: ThreadVisibility, subject: string, userId: number, conn: PoolConnection) {
  return (await execute(`INSERT INTO message_threads (client_id, subject, visibility, created_by) VALUES (?, ?, ?, ?)`, [clientId, subject, visibility, userId], conn)).insertId;
}

export async function insertMessage(threadId: number, userId: number, body: string, conn: PoolConnection) {
  return (await execute(`INSERT INTO messages (thread_id, author_id, body) VALUES (?, ?, ?)`, [threadId, userId, body], conn)).insertId;
}

// ── Editing a sent message ──
/** How long an author can edit a message after sending it. */
export const MESSAGE_EDIT_MINUTES = 5;

/** Select-list columns (alias m = messages): when it was edited, and how many seconds its author can still edit it. */
export const MESSAGE_EDIT_SQL = `m.edited_at, GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), m.created_at + INTERVAL ${MESSAGE_EDIT_MINUTES} MINUTE)) AS edit_seconds_left`;

export const findMessage = (threadId: number, messageId: number) =>
  queryOne<{ id: number; author_id: number | null; body: string; editable: 0 | 1 }>(
    `SELECT id, author_id, body, created_at >= NOW() - INTERVAL ${MESSAGE_EDIT_MINUTES} MINUTE AS editable FROM messages WHERE id = ? AND thread_id = ?`,
    [messageId, threadId],
  );

/** Edits the author's own message only while it's inside the edit window (checked again in the UPDATE, so a slow request can't slip past it). */
export async function updateOwnMessage(threadId: number, messageId: number, authorId: number, body: string, conn: PoolConnection) {
  const r = await execute(
    `UPDATE messages SET body = ?, edited_at = NOW()
      WHERE id = ? AND thread_id = ? AND author_id = ? AND created_at >= NOW() - INTERVAL ${MESSAGE_EDIT_MINUTES} MINUTE`,
    [body, messageId, threadId, authorId],
    conn,
  );
  return r.affectedRows > 0;
}

/** Replaces a message's @mentions; returns who was mentioned before, so only newly mentioned people are notified. */
export async function replaceMentions(messageId: number, userIds: number[], conn: PoolConnection) {
  const before = (await query<{ user_id: number }>(`SELECT user_id FROM message_mentions WHERE message_id = ?`, [messageId], conn)).map((r) => r.user_id);
  await execute(`DELETE FROM message_mentions WHERE message_id = ?`, [messageId], conn);
  await saveMentions(messageId, userIds, conn);
  return before;
}

// ── Meetings ──
const MEETING_SELECT = `
  SELECT mt.id, mt.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, mt.title, mt.starts_at, mt.ends_at,
         mt.meeting_link, mt.organiser_id, u.full_name AS organiser,
         (SELECT GROUP_CONCAT(ma.email ORDER BY ma.email SEPARATOR ', ') FROM meeting_attendees ma WHERE ma.meeting_id = mt.id) AS attendees
    FROM meetings mt JOIN clients c ON c.id = mt.client_id LEFT JOIN users u ON u.id = mt.organiser_id`;

export async function listMeetings(q: MeetingListQuery, scope: Scope): Promise<Paged<MeetingRow>> {
  const upcoming = q.when === "upcoming";
  const where = [scope.sql, upcoming ? "mt.ends_at >= UTC_TIMESTAMP()" : "mt.ends_at < UTC_TIMESTAMP()"];
  const params: Param[] = [...scope.params];
  if (q.client_id) (where.push("mt.client_id = ?"), params.push(q.client_id));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const items = await query<MeetingRow>(`${MEETING_SELECT} ${whereSql} ORDER BY mt.starts_at ${upcoming ? "ASC" : "DESC"} LIMIT ? OFFSET ?`, [...params, q.pageSize, offsetOf(q)]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM meetings mt ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findMeeting = (id: number) => queryOne<MeetingRow & { upcoming: 0 | 1 }>(`${MEETING_SELECT.replace("SELECT mt.id,", "SELECT mt.starts_at > UTC_TIMESTAMP() AS upcoming, mt.id,")} WHERE mt.id = ?`, [id]);

export async function insertMeeting(m: { clientId: number; organiserId: number; title: string; startsAt: string; endsAt: string; link: string | null }, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO meetings (client_id, organiser_id, title, starts_at, ends_at, meeting_link) VALUES (?, ?, ?, ?, ?, ?)`,
    [m.clientId, m.organiserId, m.title, m.startsAt, m.endsAt, m.link],
    conn,
  );
  return r.insertId;
}

export async function insertAttendees(meetingId: number, attendees: { email: string; userId: number }[], conn: PoolConnection) {
  for (const a of attendees) await execute(`INSERT IGNORE INTO meeting_attendees (meeting_id, email, user_id) VALUES (?, ?, ?)`, [meetingId, a.email, a.userId], conn);
}

/** A meeting's invitees as stored, with whether each is one of the client's portal users (locked with the meeting). */
export const meetingAttendees = (meetingId: number, clientId: number, conn: PoolConnection) =>
  query<{ email: string; full_name: string | null; is_client: 0 | 1 }>(
    `SELECT ma.email, u.full_name, EXISTS (SELECT 1 FROM client_users cu WHERE cu.client_id = ? AND cu.user_id = ma.user_id) AS is_client
       FROM meeting_attendees ma LEFT JOIN users u ON u.id = ma.user_id WHERE ma.meeting_id = ? FOR UPDATE`,
    [clientId, meetingId],
    conn,
  );

export async function deleteMeeting(id: number, conn: PoolConnection) {
  await execute(`DELETE FROM meetings WHERE id = ?`, [id], conn);
}

/** Who can be invited: the client's active portal users and today's team on the client. */
export const clientPortalUsers = (clientId: number) =>
  query<{ id: number; email: string; full_name: string }>(
    `SELECT u.id, u.email, u.full_name FROM client_users cu JOIN users u ON u.id = cu.user_id WHERE cu.client_id = ? AND u.status = 'active'`,
    [clientId],
  );

export const clientTeamUsers = (clientId: number) =>
  query<{ id: number; email: string; full_name: string }>(
    `SELECT DISTINCT u.id, u.email, u.full_name FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")} AND u.status = 'active'`,
    [clientId],
  );

export const findUserContact = (id: number) => queryOne<{ id: number; email: string; full_name: string }>(`SELECT id, email, full_name FROM users WHERE id = ?`, [id]);

// ── Meeting requests (client asks, team schedules or declines) ──
const REQUEST_SELECT = `
  SELECT r.id, r.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, r.requested_by, ru.full_name AS requester,
         r.topic, r.notes, r.preferred_times, r.duration_minutes, r.status, r.meeting_id,
         du.full_name AS decided_by_name, r.decided_at, r.decline_reason, r.created_at
    FROM meeting_requests r JOIN clients c ON c.id = r.client_id
    LEFT JOIN users ru ON ru.id = r.requested_by LEFT JOIN users du ON du.id = r.decided_by`;

export async function listMeetingRequests(q: MeetingRequestListQuery, scope: Scope): Promise<Paged<MeetingRequestRow>> {
  const where = [scope.sql];
  const params: Param[] = [...scope.params];
  if (q.status) (where.push("r.status = ?"), params.push(q.status));
  if (q.client_id) (where.push("r.client_id = ?"), params.push(q.client_id));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const items = await query<MeetingRequestRow>(`${REQUEST_SELECT} ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`, [...params, q.pageSize, offsetOf(q)]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM meeting_requests r ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

/** A client's own requests: everything still pending, plus decisions from the last 30 days. */
export const clientMeetingRequests = (clientId: number) =>
  query<MeetingRequestRow>(
    `${REQUEST_SELECT} WHERE r.client_id = ? AND (r.status = 'pending' OR r.created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY) ORDER BY r.created_at DESC, r.id DESC`,
    [clientId],
  );

export const findMeetingRequest = (id: number) => queryOne<MeetingRequestRow>(`${REQUEST_SELECT} WHERE r.id = ?`, [id]);

export const countPendingRequests = async (clientId: number) =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM meeting_requests WHERE client_id = ? AND status = 'pending'`, [clientId]))?.n ?? 0;

export async function insertMeetingRequest(r: { clientId: number; requestedBy: number; topic: string; notes: string | null; preferredTimes: string[]; durationMinutes: number }) {
  return (
    await execute(
      `INSERT INTO meeting_requests (client_id, requested_by, topic, notes, preferred_times, duration_minutes) VALUES (?, ?, ?, ?, ?, ?)`,
      [r.clientId, r.requestedBy, r.topic, r.notes, JSON.stringify(r.preferredTimes), r.durationMinutes],
    )
  ).insertId;
}

/** Moves a pending request to its outcome. False when it was no longer pending (someone else got there first). */
export async function closeMeetingRequest(
  id: number,
  outcome: { status: Exclude<MeetingRequestStatus, "pending">; decidedBy: number; meetingId?: number; reason?: string | null },
  db?: PoolConnection,
) {
  const r = await execute(
    `UPDATE meeting_requests SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(), meeting_id = ?, decline_reason = ? WHERE id = ? AND status = 'pending'`,
    [outcome.status, outcome.decidedBy, outcome.meetingId ?? null, outcome.reason ?? null, id],
    db,
  );
  return r.affectedRows === 1;
}

// ── @mentions ──
/** Someone who can be @mentioned in a client's conversations: today's team, plus (client threads) the client's portal users. */
export interface Mentionable {
  user_id: number;
  full_name: string;
  email: string;
  kind: "team" | "client";
  role: string;
}

export const mentionable = (clientId: number, includeClientUsers: boolean) =>
  query<Mentionable>(
    `SELECT u.id AS user_id, u.full_name, u.email, 'team' AS kind,
            SUBSTRING_INDEX(GROUP_CONCAT(a.team_role ORDER BY FIELD(a.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper')), ',', 1) AS role
       FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")} AND u.status = 'active'
      GROUP BY u.id, u.full_name, u.email
     ${includeClientUsers ? `UNION ALL
     SELECT u.id, u.full_name, u.email, 'client', cu.role FROM client_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.client_id = ? AND u.status = 'active'` : ""}
      ORDER BY full_name`,
    includeClientUsers ? [clientId, clientId] : [clientId],
  );

export async function saveMentions(messageId: number, userIds: number[], conn: PoolConnection) {
  for (const id of userIds) await execute(`INSERT IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)`, [messageId, id], conn);
}

/** Select-list column: the people a message mentions, as JSON (alias m = messages). */
export const MESSAGE_MENTIONS_SQL = `(SELECT JSON_ARRAYAGG(JSON_OBJECT('user_id', mm.user_id, 'full_name', mu.full_name))
   FROM message_mentions mm JOIN users mu ON mu.id = mm.user_id WHERE mm.message_id = m.id) AS mentions`;
