import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne } from "../../database/connection.js";
import type { StaffGroupMember, StaffGroupRow } from "./staff-group.types.js";
import type { StaffGroupInput } from "./staff-group.validation.js";

type Db = PoolConnection | typeof pool;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** Groups with their members and the clients still holding an active assignment made from them. */
export async function listGroups(ids?: number[], db: Db = pool): Promise<StaffGroupRow[]> {
  if (ids && !ids.length) return [];
  const where = ids ? `WHERE g.id IN (${placeholders(ids.length)})` : "";
  const groups = await query<Omit<StaffGroupRow, "members" | "clients">>(
    `SELECT g.id, g.name, g.description, g.created_at, g.updated_at FROM staff_groups g ${where} ORDER BY g.name`,
    ids ?? [],
    db,
  );
  if (!groups.length) return [];
  const gids = groups.map((g) => g.id);
  const in_ = placeholders(gids.length);
  const [members, clients] = await Promise.all([
    query<StaffGroupMember & { group_id: number }>(
      `SELECT m.group_id, m.user_id, u.full_name, u.email, m.team_role, m.journl_access,
              (u.status = 'active' AND sp.staff_type = 'accountant' AND sp.verification_status = 'verified') AS assignable
         FROM staff_group_members m JOIN users u ON u.id = m.user_id LEFT JOIN staff_profiles sp ON sp.user_id = u.id
        WHERE m.group_id IN (${in_})
        ORDER BY FIELD(m.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name`,
      gids,
      db,
    ),
    query<{ group_id: number; id: number; name: string }>(
      `SELECT DISTINCT a.source_group_id AS group_id, c.id, COALESCE(c.trade_name, c.legal_name) AS name
         FROM assignments a JOIN clients c ON c.id = a.client_id
        WHERE a.source_group_id IN (${in_}) AND a.status = 'active'
        ORDER BY name`,
      gids,
      db,
    ),
  ]);
  return groups.map((g) => ({
    ...g,
    members: members
      .filter((m) => m.group_id === g.id)
      .map(({ group_id: _g, ...m }) => ({ ...m, journl_access: Boolean(m.journl_access), assignable: Boolean(m.assignable) })),
    clients: clients.filter((c) => c.group_id === g.id).map(({ group_id: _g, ...c }) => c),
  }));
}

export const findGroup = async (id: number, db: Db = pool) => (await listGroups([id], db))[0] ?? null;

export const lockGroup = (id: number, db: PoolConnection) =>
  queryOne<{ id: number; name: string }>(`SELECT id, name FROM staff_groups WHERE id = ? FOR UPDATE`, [id], db);

export const findByName = (name: string, exceptId: number) =>
  queryOne<{ id: number }>(`SELECT id FROM staff_groups WHERE name = ? AND id <> ?`, [name, exceptId]);

/** Of the given people, those who can be put in a group (active accountants). */
export const findAccountants = (userIds: number[]) =>
  userIds.length
    ? query<{ id: number }>(
        `SELECT u.id FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
          WHERE u.id IN (${placeholders(userIds.length)}) AND u.status = 'active' AND sp.staff_type = 'accountant'`,
        userIds,
      )
    : Promise.resolve([]);

export async function insertGroup(input: StaffGroupInput, actorId: number, db: Db) {
  const r = await execute(`INSERT INTO staff_groups (name, description, created_by) VALUES (?, ?, ?)`, [input.name, input.description, actorId], db);
  return r.insertId;
}

export async function updateGroup(id: number, input: StaffGroupInput, db: Db) {
  await execute(`UPDATE staff_groups SET name = ?, description = ? WHERE id = ?`, [input.name, input.description, id], db);
}

/** Replaces the member list. Assignments already made from the group are untouched. */
export async function replaceMembers(id: number, members: StaffGroupInput["members"], db: Db) {
  await execute(`DELETE FROM staff_group_members WHERE group_id = ?`, [id], db);
  for (const m of members) {
    await execute(`INSERT INTO staff_group_members (group_id, user_id, team_role, journl_access) VALUES (?, ?, ?, ?)`, [id, m.user_id, m.team_role, m.journl_access], db);
  }
}

export async function deleteGroup(id: number, db: Db) {
  await execute(`DELETE FROM staff_groups WHERE id = ?`, [id], db);
}

/** Takes a person out of every group (when they're disabled or rejected); returns the groups they left. */
export async function removeUserFromAllGroups(userId: number, db: Db) {
  const groups = await query<{ id: number; name: string }>(
    `SELECT DISTINCT g.id, g.name FROM staff_group_members m JOIN staff_groups g ON g.id = m.group_id WHERE m.user_id = ? FOR UPDATE`,
    [userId],
    db,
  );
  if (groups.length) await execute(`DELETE FROM staff_group_members WHERE user_id = ?`, [userId], db);
  return groups;
}
