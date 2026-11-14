import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { IntegrationRow } from "./integration.types.js";
import type { IntegrationListQuery } from "./integration.validation.js";

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
  if (q.q) (where.push("(ic.external_org_name LIKE ? OR ic.external_org_id LIKE ? OR c.legal_name LIKE ? OR c.trade_name LIKE ?)"), params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`));
  if (q.provider) (where.push("ic.provider = ?"), params.push(q.provider));
  if (q.status) (where.push("ic.status = ?"), params.push(q.status));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<IntegrationRow>(`${SELECT} ${whereSql} ORDER BY client_name, ic.provider LIMIT ? OFFSET ?`, [...params, q.pageSize, offsetOf(q)]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM integration_connections ic ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export async function setClientSoftware(clientId: number, software: "journl" | "none", conn: PoolConnection) {
  await execute(`UPDATE clients SET accounting_software = ? WHERE id = ?`, [software, clientId], conn);
}
