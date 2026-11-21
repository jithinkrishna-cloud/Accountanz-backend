import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import { ENGAGEMENT_STATUSES, type EngagementCounts, type EngagementRow, type EngagementStatus } from "./engagement.types.js";
import type { EngagementInput, EngagementListQuery, EngagementUpdateInput } from "./engagement.validation.js";

type Db = PoolConnection | typeof pool;

const SELECT = `
  SELECT e.id, e.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, c.status AS client_status,
         e.package_id, p.name AS package_name, COALESCE(e.monthly_fee, p.monthly_fee) AS monthly_fee, p.monthly_fee AS list_fee, p.billing_cycle, e.status,
         e.start_date, e.end_date, e.renewal_date, e.agreement_file_name,
         e.agreement_uploaded_at, au.full_name AS agreement_uploaded_by_name,
         (SELECT COUNT(*) FROM service_invoices i WHERE i.engagement_id = e.id AND i.status <> 'cancelled') AS invoice_count,
         (SELECT i.invoice_number FROM service_invoices i WHERE i.engagement_id = e.id AND i.status <> 'cancelled' ORDER BY i.period, i.id LIMIT 1) AS first_invoice_number,
         pcr.id AS pending_change_id, pcr.source AS pending_change_source, pcr.to_package_id AS pending_change_package_id,
         tp.name AS pending_change_package_name, pcr.message AS pending_change_message, pcr.created_at AS pending_change_at,
         e.created_at, e.updated_at
    FROM engagements e
    JOIN clients c ON c.id = e.client_id
    JOIN packages p ON p.id = e.package_id
    LEFT JOIN users au ON au.id = e.agreement_uploaded_by
    LEFT JOIN package_change_requests pcr ON pcr.id = (SELECT MAX(r.id) FROM package_change_requests r WHERE r.engagement_id = e.id AND r.status = 'pending')
    LEFT JOIN packages tp ON tp.id = pcr.to_package_id`;

export async function listEngagements(q: EngagementListQuery): Promise<Paged<EngagementRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(c.legal_name LIKE ? OR c.trade_name LIKE ? OR p.name LIKE ?)");
    params.push(like, like, like);
  }
  if (q.status) {
    where.push("e.status = ?");
    params.push(q.status);
  }
  if (q.clientId) {
    where.push("e.client_id = ?");
    params.push(q.clientId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<EngagementRow>(
    `${SELECT} ${whereSql}
      ORDER BY FIELD(e.status, 'accepted', 'sent', 'draft', 'active', 'ended'), e.updated_at DESC, e.id DESC
      LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM engagements e JOIN clients c ON c.id = e.client_id JOIN packages p ON p.id = e.package_id ${whereSql}`,
    params,
  );
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export async function statusCounts(): Promise<EngagementCounts> {
  const rows = await query<{ status: EngagementStatus; n: number }>(`SELECT status, COUNT(*) AS n FROM engagements GROUP BY status`);
  const counts = Object.fromEntries(ENGAGEMENT_STATUSES.map((s) => [s, 0])) as EngagementCounts;
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export function findEngagement(id: number, db: Db = pool) {
  return queryOne<EngagementRow>(`${SELECT} WHERE e.id = ?`, [id], db);
}

export interface LockedEngagement {
  id: number;
  client_id: number;
  package_id: number;
  status: EngagementStatus;
  start_date: string | null;
  agreement_file_path: string | null;
  agreement_file_name: string | null;
}

export function lockEngagement(id: number, db: PoolConnection) {
  return queryOne<LockedEngagement>(
    `SELECT id, client_id, package_id, status, start_date, agreement_file_path, agreement_file_name FROM engagements WHERE id = ? FOR UPDATE`,
    [id],
    db,
  );
}

export function findAgreement(id: number) {
  return queryOne<{ agreement_file_path: string | null; agreement_file_name: string | null }>(
    `SELECT agreement_file_path, agreement_file_name FROM engagements WHERE id = ?`,
    [id],
  );
}

/** The client's engagement that hasn't ended yet, if any (a client has at most one). */
export function findOpenEngagement(clientId: number, db: Db = pool, exceptId?: number) {
  return queryOne<{ id: number; status: EngagementStatus }>(
    `SELECT id, status FROM engagements WHERE client_id = ? AND status <> 'ended' ${exceptId ? "AND id <> ?" : ""} ORDER BY id DESC LIMIT 1`,
    exceptId ? [clientId, exceptId] : [clientId],
    db,
  );
}

export interface OpenEngagementTerms {
  id: number;
  status: Exclude<EngagementStatus, "ended">;
  package_id: number;
  package_name: string;
  /** Agreed fee, or the package's list price. */
  monthly_fee: number;
}

/** The client's open engagement with its package and fee: the record the onboarding case follows. */
export async function findOpenTerms(clientId: number, db: Db = pool) {
  const row = await queryOne<OpenEngagementTerms>(
    `SELECT e.id, e.status, e.package_id, p.name AS package_name, COALESCE(e.monthly_fee, p.monthly_fee) AS monthly_fee
       FROM engagements e JOIN packages p ON p.id = e.package_id
      WHERE e.client_id = ? AND e.status <> 'ended' ORDER BY e.id DESC LIMIT 1`,
    [clientId],
    db,
  );
  return row ? { ...row, monthly_fee: Number(row.monthly_fee) } : null;
}

/** `monthly_fee`: the agreed fee when it differs from the package's list price (e.g. from a proposal); null = list price. */
export async function insertEngagement(input: EngagementInput & { monthly_fee?: number | null }, db: Db = pool): Promise<number> {
  const r = await execute(
    `INSERT INTO engagements (client_id, package_id, monthly_fee, status, start_date, renewal_date) VALUES (?, ?, ?, 'draft', ?, ?)`,
    [input.client_id, input.package_id, input.monthly_fee ?? null, input.start_date, input.renewal_date],
    db,
  );
  return r.insertId;
}

/**
 * `monthly_fee` is the agreed fee (null = list price). Changing the package without giving a fee resets it to the
 * new package's list price, so a fee agreed for one package never carries over to another.
 */
export async function updateEngagement(id: number, input: EngagementUpdateInput & { monthly_fee?: number | null }, db: Db = pool) {
  const values: Record<string, unknown> = {};
  for (const k of ["package_id", "start_date", "renewal_date", "monthly_fee"] as const) if (input[k] !== undefined) values[k] = input[k] ?? null;
  if (input.package_id !== undefined && input.monthly_fee === undefined) values.monthly_fee = null;
  const keys = Object.keys(values);
  if (!keys.length) return;
  await execute(`UPDATE engagements SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => values[k] as Param), id], db);
}

export async function setStatus(id: number, status: EngagementStatus, db: Db = pool) {
  await execute(
    `UPDATE engagements
        SET status = ?,
            start_date = CASE WHEN ? = 'active' THEN COALESCE(start_date, CURDATE()) ELSE start_date END,
            end_date   = CASE WHEN ? = 'ended'  THEN COALESCE(end_date, CURDATE())   ELSE end_date END
      WHERE id = ?`,
    [status, status, status, id],
    db,
  );
}

export async function setAgreement(id: number, filePath: string, fileName: string, uploadedBy: number, db: Db = pool) {
  await execute(
    `UPDATE engagements SET agreement_file_path = ?, agreement_file_name = ?, agreement_uploaded_by = ?, agreement_uploaded_at = NOW() WHERE id = ?`,
    [filePath, fileName, uploadedBy, id],
    db,
  );
}
