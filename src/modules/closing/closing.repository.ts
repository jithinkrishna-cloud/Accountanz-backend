import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne } from "../../database/connection.js";
import type { Scope } from "../documents/document.repository.js";
import type { ChecklistRow, ClosingStatus } from "./closing.types.js";

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
  return query<{ client_id: number; period: string; status: ClosingStatus; ready_override: string | null; closed_by_email: string | null; closed_at: string | null }>(
    `SELECT pc.client_id, pc.period, pc.status, pc.ready_override, u.email AS closed_by_email, pc.closed_at
       FROM period_closings pc LEFT JOIN users u ON u.id = pc.closed_by
      WHERE pc.period IN (${periods.map(() => "?").join(",")})`,
    periods,
  );
}

export const findClient = (id: number) =>
  queryOne<{ id: number; name: string }>(`SELECT id, COALESCE(trade_name, legal_name) AS name FROM clients WHERE id = ?`, [id]);

export const currentStatus = (clientId: number, period: string, conn: PoolConnection) =>
  queryOne<{ status: ClosingStatus }>(`SELECT status FROM period_closings WHERE client_id = ? AND period = ? FOR UPDATE`, [clientId, period], conn);

/**
 * Upserts the period's status. Closing stamps who and when and keeps the readiness override reason; any other
 * status clears the closing stamp and stores the given override (NULL when the checklist was complete).
 */
export async function setStatus(clientId: number, period: string, status: ClosingStatus, actorId: number, override: string | null, conn: PoolConnection) {
  const closed = status === "closed";
  await execute(
    `INSERT INTO period_closings (client_id, period, status, ready_override, closed_by, closed_at) VALUES (?, ?, ?, ?, ?, IF(?, UTC_TIMESTAMP(), NULL))
     ON DUPLICATE KEY UPDATE ready_override = IF(VALUES(status) = 'closed', ready_override, VALUES(ready_override)),
       status = VALUES(status), closed_by = VALUES(closed_by), closed_at = VALUES(closed_at)`,
    [clientId, period, status, closed ? null : override, closed ? actorId : null, closed],
    conn,
  );
}

// ── Month-end checklist: the facts "complete" is built from ──
/** Checklist facts per onboarding/active client in scope; the scope SQL uses "{c}" for the client column. */
export const checklist = (scope: Scope, period: string) =>
  query<ChecklistRow>(
    `SELECT c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name,
            COALESCE(pc.status, 'open') AS closing_status, pc.ready_override,
            (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.period = ?) AS tasks_total,
            (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.period = ? AND t.status = 'approved') AS tasks_approved,
            (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.period = ? AND t.status = 'submitted') AS tasks_submitted,
            (SELECT COUNT(*) FROM document_requests r WHERE r.client_id = c.id AND r.status = 'open' AND (r.period = ? OR r.period IS NULL)) AS open_requests,
            (SELECT COUNT(*) FROM client_approvals a WHERE a.client_id = c.id AND a.status = 'pending') AS pending_approvals,
            (SELECT COUNT(*) FROM published_reports p WHERE p.client_id = c.id AND p.period = ? AND p.published_date IS NOT NULL) AS reports_published,
            (SELECT COUNT(*) FROM published_reports p WHERE p.client_id = c.id AND p.period = ? AND p.published_date IS NULL) AS reports_draft
       FROM clients c LEFT JOIN period_closings pc ON pc.client_id = c.id AND pc.period = ?
      WHERE c.status IN ('onboarding', 'active') AND ${scope.sql.replaceAll("{c}", "c.id")} ORDER BY client_name`,
    [period, period, period, period, period, period, period, ...scope.params],
  );
