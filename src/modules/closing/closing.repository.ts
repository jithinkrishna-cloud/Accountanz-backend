import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne } from "../../database/connection.js";
import type { ClosingStatus } from "./closing.types.js";

/** Owner of "is this client's period closed?" — used to keep tasks out of closed months. */
export async function isPeriodClosed(clientId: number, period: string, db?: PoolConnection) {
  const row = await queryOne<{ status: ClosingStatus }>(`SELECT status FROM period_closings WHERE client_id = ? AND period = ?`, [clientId, period], db);
  return row?.status === "closed";
}

/** Clients whose given period is closed (for bulk generation). */
export async function closedClientIds(period: string, db?: PoolConnection) {
  const rows = await query<{ client_id: number }>(`SELECT client_id FROM period_closings WHERE period = ? AND status = 'closed'`, [period], db);
  return new Set(rows.map((r) => r.client_id));
}

export const listClientsForGrid = () =>
  query<{ client_id: number; client_name: string; client_status: string }>(
    `SELECT id AS client_id, COALESCE(trade_name, legal_name) AS client_name, status AS client_status
       FROM clients WHERE status <> 'exited' ORDER BY client_name`,
  );

export function taskCounts(periods: string[]) {
  return query<{ client_id: number; period: string; approved: number; total: number }>(
    `SELECT client_id, period, SUM(status = 'approved') AS approved, COUNT(*) AS total
       FROM tasks WHERE period IN (${periods.map(() => "?").join(",")}) GROUP BY client_id, period`,
    periods,
  );
}

export function closings(periods: string[]) {
  return query<{ client_id: number; period: string; status: ClosingStatus; closed_by_email: string | null; closed_at: string | null }>(
    `SELECT pc.client_id, pc.period, pc.status, u.email AS closed_by_email, pc.closed_at
       FROM period_closings pc LEFT JOIN users u ON u.id = pc.closed_by
      WHERE pc.period IN (${periods.map(() => "?").join(",")})`,
    periods,
  );
}

export const findClient = (id: number) =>
  queryOne<{ id: number; name: string }>(`SELECT id, COALESCE(trade_name, legal_name) AS name FROM clients WHERE id = ?`, [id]);

export const currentStatus = (clientId: number, period: string, conn: PoolConnection) =>
  queryOne<{ status: ClosingStatus }>(`SELECT status FROM period_closings WHERE client_id = ? AND period = ? FOR UPDATE`, [clientId, period], conn);

/** Upserts the period's status; closing stamps who and when, any other status clears it. */
export async function setStatus(clientId: number, period: string, status: ClosingStatus, actorId: number, conn: PoolConnection) {
  const closed = status === "closed";
  await execute(
    `INSERT INTO period_closings (client_id, period, status, closed_by, closed_at) VALUES (?, ?, ?, ?, IF(?, UTC_TIMESTAMP(), NULL))
     ON DUPLICATE KEY UPDATE status = VALUES(status), closed_by = VALUES(closed_by), closed_at = VALUES(closed_at)`,
    [clientId, period, status, closed ? actorId : null, closed],
    conn,
  );
}
