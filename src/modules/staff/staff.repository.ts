import type { PoolConnection } from "mysql2/promise";
import { activeAssignmentSql } from "../access/client-access.js";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { StaffRow, StaffType } from "./staff.types.js";
import type { StaffListQuery, UpdateStaffInput } from "./staff.validation.js";

type Db = PoolConnection | typeof pool;

/**
 * Records that tie a person to real work. Deleting the user would cascade-delete some of these
 * (assignments, work logs) or be blocked by others (payouts), so any of them means "keep and disable".
 */
export async function workHistory(userId: number, db: Db = pool) {
  const row = await queryOne<Record<string, number>>(
    `SELECT
       (SELECT COUNT(*) FROM assignments WHERE user_id = ?) AS assignments,
       (SELECT COUNT(*) FROM tasks WHERE assignee_id = ? OR reviewer_id = ? OR created_by = ?) AS tasks,
       (SELECT COUNT(*) FROM task_reviews WHERE reviewer_id = ?) AS reviews,
       (SELECT COUNT(*) FROM work_logs WHERE user_id = ?) AS time_logs,
       (SELECT COUNT(*) FROM accountant_payouts WHERE user_id = ?) AS payouts,
       (SELECT COUNT(*) FROM documents WHERE uploaded_by = ? OR reviewed_by = ?) AS documents`,
    Array(9).fill(userId),
    db,
  );
  return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)])) as Record<string, number>;
}

/** Removes the account; its staff profile, sessions and invite links go with it (ON DELETE CASCADE). */
export async function deleteUser(userId: number, db: PoolConnection) {
  await execute(`DELETE FROM users WHERE id = ?`, [userId], db);
}

const SELECT = `
  SELECT u.id AS user_id, u.email, u.full_name, u.phone, u.portal_role, u.status,
         sp.staff_type, sp.hourly_rate, sp.expertise, sp.verification_status,
         sp.bank_account_name, sp.bank_account_number, sp.bank_ifsc,
         (SELECT COUNT(DISTINCT a.client_id) FROM assignments a
           WHERE a.user_id = u.id AND ${activeAssignmentSql("a")}) AS active_clients
    FROM users u JOIN staff_profiles sp ON sp.user_id = u.id`;

export async function listStaff(q: StaffListQuery): Promise<Paged<StaffRow>> {
  const where = ["sp.staff_type = ?"];
  const params: Param[] = [q.type];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(u.full_name LIKE ? OR u.email LIKE ?)");
    params.push(like, like);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const items = await query<StaffRow>(`${SELECT} ${whereSql} ORDER BY u.full_name LIMIT ? OFFSET ?`, [...params, q.pageSize, offsetOf(q)]);
  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users u JOIN staff_profiles sp ON sp.user_id = u.id ${whereSql}`,
    params,
  );
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findStaffById = (userId: number, db: Db = pool) => queryOne<StaffRow>(`${SELECT} WHERE u.id = ?`, [userId], db);

export async function insertStaffProfile(userId: number, staffType: StaffType, db: Db) {
  await execute(`INSERT INTO staff_profiles (user_id, staff_type) VALUES (?, ?)`, [userId, staffType], db);
}

const USER_FIELDS = ["full_name", "phone", "portal_role", "status"] as const;
const PROFILE_FIELDS = ["hourly_rate", "expertise", "verification_status", "bank_account_name", "bank_account_number", "bank_ifsc"] as const;

export async function updateStaff(userId: number, input: UpdateStaffInput, db: Db) {
  const userKeys = USER_FIELDS.filter((k) => k in input);
  if (userKeys.length) {
    await execute(
      `UPDATE users SET ${userKeys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      [...userKeys.map((k) => (input[k] ?? null) as Param), userId],
      db,
    );
  }
  const profileKeys = PROFILE_FIELDS.filter((k) => k in input);
  if (profileKeys.length) {
    await execute(
      `UPDATE staff_profiles SET ${profileKeys.map((k) => `${k} = ?`).join(", ")} WHERE user_id = ?`,
      [...profileKeys.map((k) => (k === "expertise" ? JSON.stringify(input.expertise ?? []) : ((input[k] ?? null) as Param))), userId],
      db,
    );
  }
}
