import type { PoolConnection } from "mysql2/promise";
import { execute, pool, queryOne } from "../../database/connection.js";
import type { PortalRole } from "../../types/auth.types.js";
import type { UserRow } from "./user.types.js";

type Db = PoolConnection | typeof pool;

const USER_COLUMNS = "id, email, password_hash, full_name, phone, portal_role, status, last_login_at, created_at";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function findUserByEmail(email: string, db: Db = pool) {
  return queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`, [normalizeEmail(email)], db);
}

export function findUserById(id: number, db: Db = pool) {
  return queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id], db);
}

/** Staff whose verification was rejected may not use the app, whatever their account status. */
const NOT_REJECTED = `NOT EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = users.id AND sp.verification_status = 'rejected')`;

/** The per-request check: an active account that isn't rejected staff. */
export function findActiveUserById(id: number) {
  return queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND status = 'active' AND ${NOT_REJECTED}`, [id]);
}

export async function isRejectedStaff(userId: number, db: Db = pool) {
  return !(await queryOne<{ ok: 1 }>(`SELECT 1 AS ok FROM users WHERE id = ? AND ${NOT_REJECTED}`, [userId], db));
}

export interface NewUser {
  email: string;
  fullName: string;
  phone?: string | null;
  role: PortalRole;
  passwordHash: string | null;
  status: "invited" | "active" | "disabled";
}

export async function insertUser(u: NewUser, db: Db = pool): Promise<number> {
  const r = await execute(
    `INSERT INTO users (email, password_hash, full_name, phone, portal_role, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [normalizeEmail(u.email), u.passwordHash, u.fullName.trim(), u.phone ?? null, u.role, u.status],
    db,
  );
  return r.insertId;
}

/** Sets the password and activates an invited account. */
export async function setPassword(userId: number, passwordHash: string, db: Db = pool) {
  await execute(
    `UPDATE users SET password_hash = ?, status = IF(status = 'invited', 'active', status) WHERE id = ?`,
    [passwordHash, userId],
    db,
  );
}

export async function touchLastLogin(userId: number) {
  await execute(`UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?`, [userId]);
}
