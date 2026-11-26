import type { PoolConnection } from "mysql2/promise";
import { execute } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { logger } from "../../utils/logger.js";
import { recordAudit } from "../audit/audit.service.js";
import { archivePrimaryForClient, ensurePrimarySpace, syncPrimaryMembers } from "./client-spaces.js";
import * as repo from "./project.repository.js";

/**
 * Runs `work` under a savepoint so a Workspace failure never fails, or leaves partial rows in, the
 * caller's transaction. Never throws.
 */
async function guarded(actor: AuthUser, clientId: number, label: string, conn: PoolConnection, work: () => Promise<void>) {
  try {
    await execute("SAVEPOINT ws_hook", [], conn);
    await work();
    await execute("RELEASE SAVEPOINT ws_hook", [], conn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await execute("ROLLBACK TO SAVEPOINT ws_hook", [], conn);
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr, clientId }, "Workspace hook rollback failed");
    }
    logger.error({ err, clientId, hook: label }, "Workspace sync failed");
    try {
      await recordAudit(actor, { action: "Workspace sync failed", entityType: "Client", entityId: clientId, clientId, details: `${label}: ${message}`.slice(0, 500) }, conn);
    } catch (auditErr) {
      logger.error({ err: auditErr, clientId }, "Workspace sync failure audit could not be written");
    }
  }
}

export const onEngagementActivated = (actor: AuthUser, clientId: number, conn: PoolConnection) =>
  guarded(actor, clientId, "engagement activated", conn, async () => {
    await ensurePrimarySpace(actor, clientId, conn);
    await syncPrimaryMembers(actor, clientId, conn);
  });

export const onEngagementEnded = (actor: AuthUser, clientId: number, conn: PoolConnection) =>
  guarded(actor, clientId, "engagement ended", conn, () => archivePrimaryForClient(actor, clientId, conn));

export const onClientTeamChanged = (actor: AuthUser, clientId: number, conn: PoolConnection) =>
  guarded(actor, clientId, "team changed", conn, async () => {
    const primary = await repo.findPrimarySpace(clientId, conn);
    if (!primary || primary.archived_at) return;
    await syncPrimaryMembers(actor, clientId, conn);
  });
