import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { DEFAULT_STATUSES, WORKSPACE_ROLES, type MemberRow, type MemberSource, type SyncIssueReason, type SpaceRole, type SpaceRow, type StatusCategory, type StatusRow } from "./project.types.js";
import { activeAssignmentSql } from "../access/client-access.js";
import type { CreateSpaceInput, UpdateSpaceInput } from "./project.validation.js";

const STAFF_IN = WORKSPACE_ROLES.map(() => "?").join(",");

// ── Spaces ──
const SPACE_SELECT = `
  SELECT s.id, s.space_key, s.name, s.description, s.template, s.client_id,
         COALESCE(c.trade_name, c.legal_name) AS client_name, s.created_at,
         (SELECT COUNT(*) FROM project_items i WHERE i.space_id = s.id) AS item_count,
         (SELECT COUNT(*) FROM project_space_members pm WHERE pm.space_id = s.id) AS member_count,
         (SELECT GROUP_CONCAT(u.full_name ORDER BY u.full_name SEPARATOR ', ')
            FROM project_space_members pm JOIN users u ON u.id = pm.user_id
           WHERE pm.space_id = s.id AND pm.role = 'admin') AS admins,
         m.role AS my_role
    FROM project_spaces s
    LEFT JOIN clients c ON c.id = s.client_id
    LEFT JOIN project_space_members m ON m.space_id = s.id AND m.user_id = ?`;

/** Spaces the user can see: all for super admins, otherwise the ones they are a member of. */
export async function listSpaces(userId: number, all: boolean, f: { q?: string; client_id?: number }) {
  const where: string[] = [];
  const params: Param[] = [userId];
  if (!all) where.push("m.user_id IS NOT NULL");
  if (f.q) (where.push("(s.name LIKE ? OR s.space_key LIKE ?)"), params.push(`%${f.q}%`, `%${f.q}%`));
  if (f.client_id) (where.push("s.client_id = ?"), params.push(f.client_id));
  return query<SpaceRow>(`${SPACE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.name`, params);
}

export const findSpace = (userId: number, spaceId: number) => queryOne<SpaceRow>(`${SPACE_SELECT} WHERE s.id = ?`, [userId, spaceId]);

/** Plain (non-locking) read: a locking read on a missing key would take a gap lock and invite deadlocks. */
export const keyTaken = async (key: string, db?: PoolConnection) =>
  !!(await queryOne<{ id: number }>(`SELECT id FROM project_spaces WHERE space_key = ?`, [key], db));

export const clientExists = async (id: number) => !!(await queryOne<{ id: number }>(`SELECT id FROM clients WHERE id = ?`, [id]));

export type SpaceKind = "client_primary" | "client_project" | "internal";

/** Inserts a space with its default statuses; `createdBy` is the creator; `firstAdminId` (if any) also becomes an admin member. */
export async function insertSpace(input: CreateSpaceInput, kind: SpaceKind, createdBy: number, firstAdminId: number | null, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO project_spaces (space_key, name, description, template, client_id, kind, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.space_key, input.name, input.description ?? null, input.template, input.client_id ?? null, kind, createdBy],
    conn,
  );
  const spaceId = r.insertId;
  for (const [i, s] of DEFAULT_STATUSES.entries()) {
    await execute(`INSERT INTO project_statuses (space_id, name, category, position) VALUES (?, ?, ?, ?)`, [spaceId, s.name, s.category, i], conn);
  }
  if (firstAdminId !== null) {
    await execute(`INSERT INTO project_space_members (space_id, user_id, role, added_by) VALUES (?, ?, 'admin', ?)`, [spaceId, firstAdminId, firstAdminId], conn);
  }
  return spaceId;
}

export const findPrimarySpace = (clientId: number, conn: PoolConnection) =>
  queryOne<{ id: number; archived_at: Date | null }>(`SELECT id, archived_at FROM project_spaces WHERE client_id = ? AND kind = 'client_primary'`, [clientId], conn);

/** Locking read: sees the latest committed row even under REPEATABLE READ (used to recover from a create race). */
export const findPrimarySpaceLocking = (clientId: number, conn: PoolConnection) =>
  queryOne<{ id: number; archived_at: Date | null }>(`SELECT id, archived_at FROM project_spaces WHERE client_id = ? AND kind = 'client_primary' FOR SHARE`, [clientId], conn);

export const setArchived = (spaceId: number, archived: boolean, conn: PoolConnection) =>
  execute(`UPDATE project_spaces SET archived_at = ${archived ? "UTC_TIMESTAMP()" : "NULL"} WHERE id = ?`, [spaceId], conn);

export async function clientDisplayName(clientId: number, conn: PoolConnection) {
  return (await queryOne<{ name: string }>(`SELECT COALESCE(trade_name, legal_name) AS name FROM clients WHERE id = ?`, [clientId], conn))?.name ?? null;
}

/** What deleting a space removes (for the audit log), and the stored files to delete afterwards. */
export async function spaceDeletionInfo(spaceId: number, conn: PoolConnection) {
  const counts = (await queryOne<{ items: number; sprints: number; comments: number }>(
    `SELECT (SELECT COUNT(*) FROM project_items WHERE space_id = ?) AS items,
            (SELECT COUNT(*) FROM project_sprints WHERE space_id = ?) AS sprints,
            (SELECT COUNT(*) FROM project_item_comments c JOIN project_items i ON i.id = c.item_id WHERE i.space_id = ?) AS comments`,
    [spaceId, spaceId, spaceId],
    conn,
  ))!;
  const files = await query<{ file_key: string }>(
    `SELECT a.file_key FROM project_item_attachments a JOIN project_items i ON i.id = a.item_id WHERE i.space_id = ? FOR UPDATE`,
    [spaceId],
    conn,
  );
  return { ...counts, fileKeys: files.map((f) => f.file_key) };
}

/**
 * Deletes a space and everything in it. Items go first (subtasks, then the rest), because items point at the
 * space's statuses without ON DELETE; removing the space then cascades statuses, sprints and members.
 */
export async function deleteSpaceRows(spaceId: number, conn: PoolConnection) {
  await execute(`DELETE FROM project_items WHERE space_id = ? AND parent_id IS NOT NULL`, [spaceId], conn);
  await execute(`DELETE FROM project_items WHERE space_id = ?`, [spaceId], conn);
  await execute(`DELETE FROM project_spaces WHERE id = ?`, [spaceId], conn);
}

export async function updateSpace(spaceId: number, input: UpdateSpaceInput) {
  const sets: string[] = [];
  const params: Param[] = [];
  if (input.name !== undefined) (sets.push("name = ?"), params.push(input.name));
  if (input.client_id !== undefined) (sets.push("client_id = ?"), params.push(input.client_id ?? null));
  if (input.description !== undefined) (sets.push("description = ?"), params.push(input.description ?? null));
  if (sets.length) await execute(`UPDATE project_spaces SET ${sets.join(", ")} WHERE id = ?`, [...params, spaceId]);
}

/** Clients a staff member may link a space or item to (id + display name only). */
/** Clients the user may link: everyone's for admins, otherwise the clients they're assigned to. */
export const clientOptions = (scope: { sql: string; params: number[] }) =>
  query<{ id: number; name: string }>(`SELECT id, COALESCE(trade_name, legal_name) AS name FROM clients WHERE ${scope.sql} ORDER BY name`, scope.params);

// ── Statuses ──
export const listStatuses = (spaceId: number, db?: PoolConnection) =>
  query<StatusRow>(
    `SELECT st.id, st.name, st.category, st.position, (SELECT COUNT(*) FROM project_items i WHERE i.status_id = st.id) AS item_count
       FROM project_statuses st WHERE st.space_id = ? ORDER BY st.position, st.id`,
    [spaceId],
    db,
  );

export const findStatus = (spaceId: number, id: number, db?: PoolConnection) =>
  queryOne<{ id: number; name: string; category: StatusCategory }>(`SELECT id, name, category FROM project_statuses WHERE space_id = ? AND id = ?`, [spaceId, id], db);

export const statusNameTaken = async (spaceId: number, name: string, exceptId?: number) =>
  !!(await queryOne<{ id: number }>(`SELECT id FROM project_statuses WHERE space_id = ? AND name = ? AND id <> ?`, [spaceId, name, exceptId ?? 0]));

export async function insertStatus(spaceId: number, name: string, category: StatusCategory) {
  const max = await queryOne<{ p: number | null }>(`SELECT MAX(position) AS p FROM project_statuses WHERE space_id = ?`, [spaceId]);
  const r = await execute(`INSERT INTO project_statuses (space_id, name, category, position) VALUES (?, ?, ?, ?)`, [spaceId, name, category, (max?.p ?? -1) + 1]);
  return r.insertId;
}

export async function updateStatus(spaceId: number, id: number, patch: { name?: string; category?: StatusCategory }, conn: PoolConnection) {
  if (patch.name !== undefined) await execute(`UPDATE project_statuses SET name = ? WHERE space_id = ? AND id = ?`, [patch.name, spaceId, id], conn);
  if (patch.category !== undefined) await execute(`UPDATE project_statuses SET category = ? WHERE space_id = ? AND id = ?`, [patch.category, spaceId, id], conn);
}

export const countDoneStatuses = async (spaceId: number, conn: PoolConnection) =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM project_statuses WHERE space_id = ? AND category = 'done'`, [spaceId], conn))?.n ?? 0;

/** Keeps resolved_at in step with a status's category (set on entering done, cleared on leaving). */
export async function syncResolvedForStatus(statusId: number, category: StatusCategory, conn: PoolConnection) {
  if (category === "done") await execute(`UPDATE project_items SET resolved_at = COALESCE(resolved_at, UTC_TIMESTAMP()) WHERE status_id = ?`, [statusId], conn);
  else await execute(`UPDATE project_items SET resolved_at = NULL WHERE status_id = ?`, [statusId], conn);
}

export async function moveItemsToStatus(fromId: number, toId: number, conn: PoolConnection) {
  await execute(`UPDATE project_items SET status_id = ? WHERE status_id = ?`, [toId, fromId], conn);
}

export const deleteStatus = (id: number, conn: PoolConnection) => execute(`DELETE FROM project_statuses WHERE id = ?`, [id], conn);

export async function reorderStatuses(spaceId: number, ids: number[], conn: PoolConnection) {
  for (const [i, id] of ids.entries()) await execute(`UPDATE project_statuses SET position = ? WHERE space_id = ? AND id = ?`, [i, spaceId, id], conn);
}

// ── Members ──
export const listMembers = (spaceId: number) =>
  query<MemberRow>(
    `SELECT u.id AS user_id, u.full_name, u.email, u.portal_role, m.role, m.added_at
       FROM project_space_members m JOIN users u ON u.id = m.user_id
      WHERE m.space_id = ? ORDER BY m.role = 'admin' DESC, u.full_name`,
    [spaceId],
  );

export const findMember = (spaceId: number, userId: number, db?: PoolConnection) =>
  queryOne<{ role: SpaceRole; full_name: string }>(
    `SELECT m.role, u.full_name FROM project_space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? AND m.user_id = ?`,
    [spaceId, userId],
    db,
  );

export const isMember = async (spaceId: number, userId: number) => !!(await findMember(spaceId, userId));

export const countAdmins = async (spaceId: number, conn: PoolConnection) =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM project_space_members WHERE space_id = ? AND role = 'admin' FOR UPDATE`, [spaceId], conn))?.n ?? 0;

/** Active staff users among the given ids (others are silently ignored by the caller's check). */
export const activeStaff = (ids: number[]) =>
  ids.length
    ? query<{ id: number; full_name: string }>(
        `SELECT id, full_name FROM users WHERE id IN (${ids.map(() => "?").join(",")}) AND status <> 'disabled' AND portal_role IN (${STAFF_IN})`,
        [...ids, ...WORKSPACE_ROLES],
      )
    : Promise.resolve([]);

export async function addMember(spaceId: number, userId: number, role: SpaceRole, addedBy: number, conn: PoolConnection, source: MemberSource = "manual") {
  await execute(
    `INSERT INTO project_space_members (space_id, user_id, role, added_by, source) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = role`,
    [spaceId, userId, role, addedBy, source],
    conn,
  );
}

/** Distinct users with an active assignment on the client, in order of their first assignment. */
export const listClientTeam = (clientId: number, conn: PoolConnection) =>
  query<{ user_id: number; full_name: string; portal_role: string }>(
    `SELECT u.id AS user_id, u.full_name, u.portal_role
       FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")}
      GROUP BY u.id, u.full_name, u.portal_role ORDER BY MIN(a.id)`,
    [clientId],
    conn,
  );

export const listMembersWithSource = (spaceId: number, conn: PoolConnection) =>
  query<{ user_id: number; role: SpaceRole; source: MemberSource; portal_role: string }>(
    `SELECT m.user_id, m.role, m.source, u.portal_role
       FROM project_space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ?`,
    [spaceId],
    conn,
  );

/** Opens (or re-opens) an issue. Returns true only when it was not already open. */
export async function upsertSyncIssue(spaceId: number, userId: number, reason: SyncIssueReason, conn: PoolConnection): Promise<boolean> {
  const existing = await queryOne<{ id: number; resolved_at: Date | null }>(`SELECT id, resolved_at FROM project_space_sync_issues WHERE space_id = ? AND user_id = ? FOR UPDATE`, [spaceId, userId], conn);
  if (!existing) {
    await execute(`INSERT INTO project_space_sync_issues (space_id, user_id, reason) VALUES (?, ?, ?)`, [spaceId, userId, reason], conn);
    return true;
  }
  if (existing.resolved_at) {
    await execute(`UPDATE project_space_sync_issues SET reason = ?, resolved_at = NULL, created_at = UTC_TIMESTAMP() WHERE id = ?`, [reason, existing.id], conn);
    return true;
  }
  await execute(`UPDATE project_space_sync_issues SET reason = ? WHERE id = ?`, [reason, existing.id], conn);
  return false;
}

/** Resolves every open issue of the space except those for the `keepOpen` users. */
export async function resolveSyncIssues(spaceId: number, keepOpen: number[], conn: PoolConnection) {
  await execute(
    `UPDATE project_space_sync_issues SET resolved_at = UTC_TIMESTAMP()
      WHERE space_id = ? AND resolved_at IS NULL ${keepOpen.length ? `AND user_id NOT IN (${keepOpen.map(() => "?").join(",")})` : ""}`,
    [spaceId, ...keepOpen],
    conn,
  );
}

export const listSyncIssues = (spaceId: number) =>
  query<{ user_id: number; full_name: string; email: string; reason: SyncIssueReason; created_at: string }>(
    `SELECT i.user_id, u.full_name, u.email, i.reason, i.created_at
       FROM project_space_sync_issues i JOIN users u ON u.id = i.user_id
      WHERE i.space_id = ? AND i.resolved_at IS NULL ORDER BY i.created_at, i.id`,
    [spaceId],
  );

export const setMemberRole = (spaceId: number, userId: number, role: SpaceRole, conn: PoolConnection) =>
  execute(`UPDATE project_space_members SET role = ? WHERE space_id = ? AND user_id = ?`, [role, spaceId, userId], conn);

export const removeMember = (spaceId: number, userId: number, conn: PoolConnection) =>
  execute(`DELETE FROM project_space_members WHERE space_id = ? AND user_id = ?`, [spaceId, userId], conn);

/** Staff the caller can add: active staff matching the search, flagged when already in the space. */
export const searchStaff = (spaceId: number, q: string | undefined) =>
  query<{ id: number; full_name: string; email: string; portal_role: string; in_space: number }>(
    `SELECT u.id, u.full_name, u.email, u.portal_role,
            EXISTS(SELECT 1 FROM project_space_members m WHERE m.space_id = ? AND m.user_id = u.id) AS in_space
       FROM users u
      WHERE u.status <> 'disabled' AND u.portal_role IN (${STAFF_IN}) ${q ? "AND (u.full_name LIKE ? OR u.email LIKE ?)" : ""}
      ORDER BY u.full_name LIMIT 20`,
    [spaceId, ...WORKSPACE_ROLES, ...(q ? [`%${q}%`, `%${q}%`] : [])],
  );

// ── Summary ──
export async function summary(spaceId: number, assigneeId?: number) {
  const a = assigneeId ? "AND i.assignee_id = ?" : "";
  const p = (...xs: Param[]): Param[] => (assigneeId ? [...xs, assigneeId] : xs);
  const counts = await queryOne<{ completed: number; updated: number; created: number; due_soon: number; total: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(i.resolved_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY), 0) AS completed,
            COALESCE(SUM(i.updated_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY), 0) AS updated,
            COALESCE(SUM(i.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY), 0) AS created,
            COALESCE(SUM(i.resolved_at IS NULL AND i.due_date BETWEEN UTC_DATE() AND UTC_DATE() + INTERVAL 7 DAY), 0) AS due_soon
       FROM project_items i WHERE i.space_id = ? ${a}`,
    p(spaceId),
  );
  const byStatus = await query<{ id: number; name: string; category: StatusCategory; count: number }>(
    `SELECT st.id, st.name, st.category, COUNT(i.id) AS count
       FROM project_statuses st LEFT JOIN project_items i ON i.status_id = st.id ${a}
      WHERE st.space_id = ? GROUP BY st.id ORDER BY st.position`,
    assigneeId ? [assigneeId, spaceId] : [spaceId],
  );
  const byPriority = await query<{ priority: string; count: number }>(
    `SELECT i.priority, COUNT(*) AS count FROM project_items i WHERE i.space_id = ? ${a} GROUP BY i.priority`,
    p(spaceId),
  );
  const byType = await query<{ type: string; count: number }>(`SELECT i.type, COUNT(*) AS count FROM project_items i WHERE i.space_id = ? ${a} GROUP BY i.type`, p(spaceId));
  const activity = await query<{ id: number; item_number: number; item_title: string; actor: string | null; action: string; field: string | null; new_value: string | null; created_at: string }>(
    `SELECT ac.id, i.number AS item_number, i.title AS item_title, u.full_name AS actor, ac.action, ac.field, ac.new_value, ac.created_at
       FROM project_item_activity ac JOIN project_items i ON i.id = ac.item_id LEFT JOIN users u ON u.id = ac.actor_id
      WHERE i.space_id = ? ${a} ORDER BY ac.created_at DESC, ac.id DESC LIMIT 10`,
    p(spaceId),
  );
  // Work in an "in progress" status: soonest due first, undated last.
  const running = await query<{ number: number; title: string; type: string; priority: string; status_name: string; assignee_id: number | null; assignee_name: string | null; start_date: string | null; due_date: string | null }>(
    `SELECT i.number, i.title, i.type, i.priority, st.name AS status_name, i.assignee_id, u.full_name AS assignee_name, i.start_date, i.due_date
       FROM project_items i JOIN project_statuses st ON st.id = i.status_id LEFT JOIN users u ON u.id = i.assignee_id
      WHERE i.space_id = ? AND st.category = 'in_progress' ${a}
      ORDER BY i.due_date IS NULL, i.due_date, i.updated_at DESC LIMIT 12`,
    p(spaceId),
  );
  // Due dates for the calendar: three months back to six ahead covers any month someone browses to in practice.
  const due = await query<{ number: number; title: string; priority: string; status_category: StatusCategory; assignee_name: string | null; due_date: string }>(
    `SELECT i.number, i.title, i.priority, st.category AS status_category, u.full_name AS assignee_name, i.due_date
       FROM project_items i JOIN project_statuses st ON st.id = i.status_id LEFT JOIN users u ON u.id = i.assignee_id
      WHERE i.space_id = ? AND i.due_date BETWEEN UTC_DATE() - INTERVAL 3 MONTH AND UTC_DATE() + INTERVAL 6 MONTH ${a}
      ORDER BY i.due_date, i.number LIMIT 400`,
    p(spaceId),
  );
  // Open and finished work per person (everyone, regardless of the assignee filter: it's the people card).
  const byAssignee = await query<{ assignee_id: number; open: number; done: number }>(
    `SELECT i.assignee_id, COALESCE(SUM(st.category <> 'done'), 0) AS open, COALESCE(SUM(st.category = 'done'), 0) AS done
       FROM project_items i JOIN project_statuses st ON st.id = i.status_id
      WHERE i.space_id = ? AND i.assignee_id IS NOT NULL GROUP BY i.assignee_id`,
    [spaceId],
  );
  const activeSprint = await queryOne<{ id: number; name: string; start_date: string | null; end_date: string | null; item_count: number; done_count: number }>(
    `SELECT sp.id, sp.name, sp.start_date, sp.end_date, COUNT(i.id) AS item_count, COALESCE(SUM(st.category = 'done'), 0) AS done_count
       FROM project_sprints sp LEFT JOIN project_items i ON i.sprint_id = sp.id LEFT JOIN project_statuses st ON st.id = i.status_id
      WHERE sp.space_id = ? AND sp.status = 'active' GROUP BY sp.id ORDER BY sp.start_date DESC LIMIT 1`,
    [spaceId],
  );
  return { counts, byStatus, byPriority, byType, activity, running, due, byAssignee, activeSprint };
}
