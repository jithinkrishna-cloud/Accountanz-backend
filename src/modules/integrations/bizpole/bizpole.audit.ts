import type { AuthUser } from "../../../types/auth.types.js";
import { AppError } from "../../../utils/app-error.js";
import { logger } from "../../../utils/logger.js";
import { recordAudit, type AuditOutcome } from "../../audit/audit.service.js";
import type { RequestContext } from "../../audit/journl-read-audit.js";

/**
 * Read-audit for Bizpole Books data: Bizpole only sees Accountanz's partner grant, so these rows are the only record of
 * which Accountanz user read which client's books. Exactly one row per read, whatever the outcome. Metadata only:
 * no tokens, credentials or accounting data.
 */

const ACTION: Record<AuditOutcome, string> = {
  success: "Bizpole Books data viewed",
  denied: "Bizpole Books data access denied",
  failed: "Bizpole Books data access failed",
};

const outcomeOf = (err: unknown): AuditOutcome => (err instanceof AppError && (err.status === 403 || err.status === 404) ? "denied" : "failed");

export async function auditedBizpoleRead<T>(actor: AuthUser, clientId: number, ctx: RequestContext, resource: string, details: string, run: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (err) {
    await write(actor, clientId, ctx, resource, details, outcomeOf(err), err);
    throw err;
  }
  await write(actor, clientId, ctx, resource, details, "success");
  return result;
}

/** Never throws: an audit failure must not block the read, but it is logged at error level. */
async function write(actor: AuthUser, clientId: number, ctx: RequestContext, resource: string, details: string, outcome: AuditOutcome, err?: unknown) {
  const reason = err instanceof AppError ? ` [${err.status} ${err.code}]` : err ? " [error]" : "";
  const entry = {
    action: ACTION[outcome],
    entityType: "BizpoleResource",
    entityId: resource,
    clientId,
    details: `${details}${reason}`.slice(0, 1000),
    outcome,
    endpoint: ctx.endpoint ?? null,
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress ?? null,
  };
  try {
    await recordAudit(actor, entry);
  } catch (auditErr) {
    let failure = auditErr;
    // A probe of a client id that doesn't exist fails the client foreign key: keep the row, with the id in details.
    if ((auditErr as { code?: string }).code === "ER_NO_REFERENCED_ROW_2") {
      try {
        await recordAudit(actor, { ...entry, clientId: null, details: `client #${clientId}: ${entry.details}` });
        return;
      } catch (retryErr) {
        failure = retryErr;
      }
    }
    logger.error({ err: failure, audit: { actorId: actor.id, clientId, resource, outcome, requestId: ctx.requestId ?? null } }, "Bizpole read-audit write failed");
  }
}
