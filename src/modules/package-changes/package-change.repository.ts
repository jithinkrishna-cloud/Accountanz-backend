import type { PoolConnection } from "mysql2/promise";
import { execute, pool, queryOne } from "../../database/connection.js";

type Db = PoolConnection | typeof pool;

export type ChangeStatus = "pending" | "approved" | "declined" | "withdrawn";

export interface PackageChangeRow {
  id: number;
  client_id: number;
  engagement_id: number;
  from_package_id: number;
  from_package_name: string;
  to_package_id: number;
  to_package_name: string;
  /** List price of the package asked for. */
  to_list_fee: number;
  source: "client" | "team";
  message: string | null;
  monthly_fee: number | null;
  status: ChangeStatus;
  requested_by: number | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

const SELECT = `
  SELECT r.id, r.client_id, r.engagement_id, r.from_package_id, fp.name AS from_package_name, r.to_package_id, tp.name AS to_package_name,
         tp.monthly_fee AS to_list_fee, r.source, r.message, r.monthly_fee, r.status, r.requested_by, rb.full_name AS requested_by_name,
         db.full_name AS decided_by_name, r.decided_at, r.decision_note, r.created_at
    FROM package_change_requests r
    JOIN packages fp ON fp.id = r.from_package_id
    JOIN packages tp ON tp.id = r.to_package_id
    LEFT JOIN users rb ON rb.id = r.requested_by
    LEFT JOIN users db ON db.id = r.decided_by`;

export const findChange = (id: number, db: Db = pool) => queryOne<PackageChangeRow>(`${SELECT} WHERE r.id = ?`, [id], db);

export const lockChange = (id: number, db: PoolConnection) =>
  queryOne<{ id: number; client_id: number; engagement_id: number; to_package_id: number; source: "client" | "team"; status: ChangeStatus; requested_by: number | null }>(
    `SELECT id, client_id, engagement_id, to_package_id, source, status, requested_by FROM package_change_requests WHERE id = ? FOR UPDATE`,
    [id],
    db,
  );

export const pendingForEngagement = (engagementId: number, db: Db = pool) =>
  queryOne<PackageChangeRow>(`${SELECT} WHERE r.engagement_id = ? AND r.status = 'pending' ORDER BY r.id DESC LIMIT 1`, [engagementId], db);

/** The client's open request, or the most recently answered one for a week after (so they see the answer). */
export const pendingForClient = (clientId: number, db: Db = pool) =>
  queryOne<PackageChangeRow>(
    `${SELECT} WHERE r.client_id = ? AND r.source = 'client'
        AND (r.status = 'pending' OR (r.status IN ('approved','declined') AND r.decided_at > UTC_TIMESTAMP() - INTERVAL 7 DAY))
      ORDER BY r.status = 'pending' DESC, r.id DESC LIMIT 1`,
    [clientId],
    db,
  );

/** For the portal's Packages page. */
export const pendingChangeForClient = (clientId: number) => pendingForClient(clientId);

export async function insertChange(
  input: { clientId: number; engagementId: number; fromPackageId: number; toPackageId: number; source: "client" | "team"; message: string | null; requestedBy: number; status?: ChangeStatus; monthlyFee?: number | null; decidedBy?: number | null; decisionNote?: string | null },
  db: Db = pool,
) {
  const decided = input.status && input.status !== "pending";
  const r = await execute(
    `INSERT INTO package_change_requests (client_id, engagement_id, from_package_id, to_package_id, source, message, monthly_fee, status, requested_by, decided_by, decided_at, decision_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${decided ? "UTC_TIMESTAMP()" : "NULL"}, ?)`,
    [input.clientId, input.engagementId, input.fromPackageId, input.toPackageId, input.source, input.message, input.monthlyFee ?? null, input.status ?? "pending", input.requestedBy, decided ? (input.decidedBy ?? null) : null, input.decisionNote ?? null],
    db,
  );
  return r.insertId;
}

/** Answers a pending request; false when it was already answered or withdrawn. */
export async function decideChange(id: number, status: Exclude<ChangeStatus, "pending">, by: number, note: string | null, monthlyFee: number | null, db: Db = pool) {
  const r = await execute(
    `UPDATE package_change_requests SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ?, monthly_fee = ? WHERE id = ? AND status = 'pending'`,
    [status, by, note, monthlyFee, id],
    db,
  );
  return r.affectedRows > 0;
}
