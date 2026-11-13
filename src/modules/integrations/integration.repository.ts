import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { IntegrationRow } from "./integration.types.js";
import type { CreateConnectionInput, IntegrationListQuery } from "./integration.validation.js";

const SELECT = `
  SELECT ic.id, ic.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, ic.provider,
         ic.external_org_id, ic.external_org_name, ic.status, ic.last_health_check, ic.last_error,
         ic.verified_at, vu.full_name AS verified_by_name, ic.verification_note, ic.disconnected_at,
         ic.authorized_at, au.full_name AS authorized_by_name,
         CASE WHEN ic.access_token_enc IS NOT NULL AND ic.token_expires_at > UTC_TIMESTAMP() THEN ic.token_expires_at END AS journl_session_until
    FROM integration_connections ic JOIN clients c ON c.id = ic.client_id
    LEFT JOIN users vu ON vu.id = ic.verified_by
    LEFT JOIN users au ON au.id = ic.authorized_by`;

export async function listConnections(q: IntegrationListQuery): Promise<Paged<IntegrationRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) (where.push("(ic.external_org_name LIKE ? OR ic.external_org_id LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`));
  if (q.provider) (where.push("ic.provider = ?"), params.push(q.provider));
  if (q.status) (where.push("ic.status = ?"), params.push(q.status));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<IntegrationRow>(`${SELECT} ${whereSql} ORDER BY client_name, ic.provider LIMIT ? OFFSET ?`, [...params, q.pageSize, offsetOf(q)]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM integration_connections ic ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findConnection = (id: number) => queryOne<IntegrationRow>(`${SELECT} WHERE ic.id = ?`, [id]);

export const connectionExists = async (clientId: number, provider: string) =>
  !!(await queryOne<{ id: number }>(`SELECT id FROM integration_connections WHERE client_id = ? AND provider = ?`, [clientId, provider]));

export const clientExists = async (id: number) => !!(await queryOne<{ id: number }>(`SELECT id FROM clients WHERE id = ?`, [id]));

export async function insertConnection(c: CreateConnectionInput, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO integration_connections (client_id, provider, external_org_name, external_org_id, status) VALUES (?, ?, ?, ?, 'pending')`,
    [c.client_id, c.provider, c.external_org_name, c.external_org_id],
    conn,
  );
  return r.insertId;
}

/** An admin checked the organisation in JournL by hand; records who, when and how. */
export async function recordManualVerification(id: number, userId: number, note: string, conn: PoolConnection) {
  await execute(
    `UPDATE integration_connections SET status = 'connected', last_error = NULL, verified_by = ?, verified_at = UTC_TIMESTAMP(), verification_note = ? WHERE id = ?`,
    [userId, note, id],
    conn,
  );
}

export async function recordHealthCheck(id: number, status: "connected" | "error", error: string | null, conn: PoolConnection) {
  await execute(`UPDATE integration_connections SET status = ?, last_error = ?, last_health_check = UTC_TIMESTAMP() WHERE id = ?`, [status, error, id], conn);
}

/** Keeps the client's "accounting software" field in step with its connection. */
export async function setClientSoftware(clientId: number, software: "journl" | "none", conn: PoolConnection) {
  await execute(`UPDATE clients SET accounting_software = ? WHERE id = ?`, [software, clientId], conn);
}
