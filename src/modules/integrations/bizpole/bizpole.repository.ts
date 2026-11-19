import type { PoolConnection } from "mysql2/promise";
import { execute, queryOne } from "../../../database/connection.js";
import type { BizpoleConnectionRow, CompanyChoice } from "./bizpole.types.js";

/**
 * integration_connections rows with provider = 'bizpole_books'. Every query here filters on that provider, so JournL
 * rows are never read or changed. Token columns hold AES-GCM sealed values only; token_expires_at is UTC.
 */

const COLUMNS = `id, client_id, status, external_org_id, external_org_name, external_gstin, grant_id, access_token_enc, refresh_token_enc,
  token_expires_at, available_companies, authorized_at, last_health_check, last_error, disconnected_at`;

export const findByClient = (clientId: number, db?: PoolConnection) =>
  queryOne<BizpoleConnectionRow>(`SELECT ${COLUMNS} FROM integration_connections WHERE client_id = ? AND provider = 'bizpole_books'`, [clientId], db);

/** Row lock for one client's connection (state changes and token refresh run under it). */
export const lockByClient = (clientId: number, conn: PoolConnection) =>
  queryOne<BizpoleConnectionRow>(`SELECT ${COLUMNS} FROM integration_connections WHERE client_id = ? AND provider = 'bizpole_books' FOR UPDATE`, [clientId], conn);

export const lockById = (id: number, conn: PoolConnection) =>
  queryOne<BizpoleConnectionRow>(`SELECT ${COLUMNS} FROM integration_connections WHERE id = ? AND provider = 'bizpole_books' FOR UPDATE`, [id], conn);

/** The Accountanz client's own GSTIN (for the mismatch rule). */
export const clientGstin = async (clientId: number, db?: PoolConnection) =>
  (await queryOne<{ gstin: string | null }>(`SELECT gstin FROM clients WHERE id = ?`, [clientId], db))?.gstin ?? null;

/** Another Accountanz client already linked to this Bizpole company (one company serves one client). */
export const companyTakenBy = (companyId: string, clientId: number, conn: PoolConnection) =>
  queryOne<{ client_id: number }>(
    `SELECT client_id FROM integration_connections
      WHERE provider = 'bizpole_books' AND external_org_id = ? AND client_id <> ? AND status IN ('connected','pending','error') LIMIT 1`,
    [companyId, clientId],
    conn,
  );

export interface SealedTokens {
  accessEnc: string;
  refreshEnc: string;
  expiresAt: Date;
  grantId: string;
}

/**
 * Saves a freshly exchanged grant: either connected to one company, or pending with the companies to choose from.
 * Reuses the client's existing bizpole_books row (after a disconnect or revocation) or inserts it.
 */
export async function saveNewGrant(
  clientId: number,
  existingId: number | null,
  tokens: SealedTokens,
  state: { status: "connected"; company: CompanyChoice } | { status: "pending"; companies: CompanyChoice[] },
  ownerId: number,
  conn: PoolConnection,
): Promise<number> {
  const company = state.status === "connected" ? state.company : null;
  const companies = state.status === "pending" ? JSON.stringify(state.companies) : null;
  const params = [
    state.status,
    company?.id ?? null,
    company?.name ?? null,
    company?.gstin ?? null,
    tokens.grantId,
    tokens.accessEnc,
    tokens.refreshEnc,
    tokens.expiresAt,
    companies,
    ownerId,
  ];
  if (existingId) {
    await execute(
      `UPDATE integration_connections SET status = ?, external_org_id = ?, external_org_name = ?, external_gstin = ?, grant_id = ?,
              access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, available_companies = ?, authorized_by = ?,
              authorized_at = UTC_TIMESTAMP(), last_health_check = UTC_TIMESTAMP(), last_error = NULL, disconnected_at = NULL
        WHERE id = ? AND provider = 'bizpole_books'`,
      [...params, existingId],
      conn,
    );
    return existingId;
  }
  const r = await execute(
    `INSERT INTO integration_connections
       (client_id, provider, status, external_org_id, external_org_name, external_gstin, grant_id, access_token_enc, refresh_token_enc,
        token_expires_at, available_companies, authorized_by, authorized_at, last_health_check)
     VALUES (?, 'bizpole_books', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [clientId, ...params],
    conn,
  );
  return r.insertId;
}

/** The owner chose a company from a pending grant. */
export async function setCompany(id: number, company: CompanyChoice, conn: PoolConnection) {
  await execute(
    `UPDATE integration_connections SET status = 'connected', external_org_id = ?, external_org_name = ?, external_gstin = ?,
            available_companies = NULL, last_error = NULL, last_health_check = UTC_TIMESTAMP()
      WHERE id = ? AND provider = 'bizpole_books'`,
    [company.id, company.name, company.gstin, id],
    conn,
  );
}

/** Rotated tokens, written in the same transaction (and under the same row lock) as the refresh that produced them. */
export async function saveRotatedTokens(id: number, tokens: SealedTokens, conn: PoolConnection) {
  await execute(
    `UPDATE integration_connections SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, grant_id = ?
      WHERE id = ? AND provider = 'bizpole_books'`,
    [tokens.accessEnc, tokens.refreshEnc, tokens.expiresAt, tokens.grantId, id],
    conn,
  );
}

/** Bizpole refused the grant (revoked, reused or expired): tokens are useless, so drop them. The owner reconnects. */
export async function markRevoked(id: number, reason: string, db?: PoolConnection) {
  await execute(
    `UPDATE integration_connections SET status = 'revoked', last_error = ?, access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL
      WHERE id = ? AND provider = 'bizpole_books'`,
    [reason.slice(0, 500), id],
    db,
  );
}

/** A problem that needs attention but where the stored tokens may still be valid (e.g. company no longer shared). */
export async function markError(id: number, reason: string, db?: PoolConnection) {
  await execute(`UPDATE integration_connections SET status = 'error', last_error = ? WHERE id = ? AND provider = 'bizpole_books'`, [reason.slice(0, 500), id], db);
}

/** The owner disconnected: tokens and the pending choice are dropped; the company details stay for reference. */
export async function markDisconnected(id: number, conn: PoolConnection) {
  await execute(
    `UPDATE integration_connections SET status = 'disconnected', disconnected_at = UTC_TIMESTAMP(), last_error = NULL, grant_id = NULL,
            access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL, available_companies = NULL
      WHERE id = ? AND provider = 'bizpole_books'`,
    [id],
    conn,
  );
}

/** A data read succeeded: record the check time (and clear a stale error). */
export async function touchHealthy(id: number) {
  await execute(
    `UPDATE integration_connections SET last_health_check = UTC_TIMESTAMP(), last_error = NULL, status = IF(status = 'error', 'connected', status)
      WHERE id = ? AND provider = 'bizpole_books'`,
    [id],
  );
}
