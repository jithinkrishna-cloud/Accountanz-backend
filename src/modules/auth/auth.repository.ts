import type { PoolConnection } from "mysql2/promise";
import { execute, pool, queryOne } from "../../database/connection.js";
import type { RefreshTokenRow, UserTokenPurpose, UserTokenRow } from "./auth.types.js";

type Db = PoolConnection | typeof pool;

// ── Refresh tokens (stored as SHA-256 hashes) ──
export async function insertRefreshToken(userId: number, tokenHash: string, expiresAt: Date, db: Db = pool) {
  await execute(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`, [userId, tokenHash, expiresAt], db);
}

export function findRefreshTokenForUpdate(tokenHash: string, db: PoolConnection) {
  return queryOne<RefreshTokenRow>(
    `SELECT id, user_id, expires_at, revoked_at, expires_at < UTC_TIMESTAMP() AS expired
       FROM refresh_tokens WHERE token_hash = ? FOR UPDATE`,
    [tokenHash],
    db,
  );
}

export async function revokeRefreshToken(id: number, db: Db = pool) {
  await execute(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND revoked_at IS NULL`, [id], db);
}

export async function revokeRefreshTokenByHash(tokenHash: string) {
  await execute(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ? AND revoked_at IS NULL`, [tokenHash]);
}

export async function revokeAllRefreshTokens(userId: number, db: Db = pool) {
  await execute(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL`, [userId], db);
}

// ── One-time user tokens (password reset, invite) ──
export async function insertUserToken(userId: number, purpose: UserTokenPurpose, tokenHash: string, expiresAt: Date, db: Db = pool) {
  // A new link supersedes any earlier unused link for the same purpose.
  await execute(`UPDATE user_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND purpose = ? AND used_at IS NULL`, [userId, purpose], db);
  await execute(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [userId, purpose, tokenHash, expiresAt],
    db,
  );
}

/** Returns the token only if it is unused and unexpired. */
export function findUsableUserTokenForUpdate(tokenHash: string, purpose: UserTokenPurpose, db: PoolConnection) {
  return queryOne<UserTokenRow>(
    `SELECT id, user_id FROM user_tokens
      WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
      FOR UPDATE`,
    [tokenHash, purpose],
    db,
  );
}

export async function markUserTokenUsed(id: number, db: Db = pool) {
  await execute(`UPDATE user_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?`, [id], db);
}
