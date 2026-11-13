import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import { activeAssignmentSql } from "../access/client-access.js";
import type { Scope } from "../documents/document.repository.js";
import type { MeetingRow, MessageRow, ThreadRow, ThreadVisibility } from "./communication.types.js";
import type { MeetingListQuery, ThreadListQuery } from "./communication.validation.js";

const CLIENT_AUTHOR = `u.portal_role IN ('client_owner', 'client_member')`;
const LAST = (col: string) => `(SELECT ${col} FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;
const THREAD_COLUMNS = `t.id, t.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, t.subject, t.visibility, t.created_at,
  (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
  (SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = t.id) AS last_at,
  ${LAST("m.body")} AS last_body, ${LAST("u.full_name")} AS last_author, ${LAST(CLIENT_AUTHOR)} AS last_from_client`;

export async function listThreads(q: ThreadListQuery, scope: Scope): Promise<Paged<ThreadRow>> {
  const where = [scope.sql];
  const params: Param[] = [...scope.params];
  if (q.client_id) (where.push("t.client_id = ?"), params.push(q.client_id));
  if (q.visibility) (where.push("t.visibility = ?"), params.push(q.visibility));
  if (q.q) (where.push("(t.subject LIKE ? OR c.legal_name LIKE ? OR c.trade_name LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const from = `FROM message_threads t JOIN clients c ON c.id = t.client_id`;
  const items = await query<ThreadRow>(`SELECT ${THREAD_COLUMNS} ${from} ${whereSql} ORDER BY COALESCE(last_at, t.created_at) DESC LIMIT ? OFFSET ?`, [
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
    `SELECT m.id, m.body, m.created_at, u.full_name AS author, m.author_id, COALESCE(${CLIENT_AUTHOR}, 0) AS from_client
       FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = ? ORDER BY m.created_at, m.id`,
    [threadId],
  );

export async function insertThread(clientId: number, visibility: ThreadVisibility, subject: string, userId: number, conn: PoolConnection) {
  return (await execute(`INSERT INTO message_threads (client_id, subject, visibility, created_by) VALUES (?, ?, ?, ?)`, [clientId, subject, visibility, userId], conn)).insertId;
}

export async function insertMessage(threadId: number, userId: number, body: string, conn: PoolConnection) {
  return (await execute(`INSERT INTO messages (thread_id, author_id, body) VALUES (?, ?, ?)`, [threadId, userId, body], conn)).insertId;
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
