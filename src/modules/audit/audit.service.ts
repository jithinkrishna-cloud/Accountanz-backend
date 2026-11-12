import type { PoolConnection } from "mysql2/promise";
import { execute, pool } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  clientId?: number | null;
  details?: string | null;
}

/** Records who did what. Pass the transaction connection when the change itself is transactional. */
export async function recordAudit(actor: AuthUser | null, entry: AuditEntry, db: PoolConnection | typeof pool = pool) {
  await execute(
    `INSERT INTO audit_logs (actor_id, actor_email, actor_role, client_id, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actor?.id ?? null,
      actor?.email ?? null,
      actor?.role ?? null,
      entry.clientId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId == null ? null : String(entry.entityId),
      entry.details?.slice(0, 1000) ?? null,
    ],
    db,
  );
}
