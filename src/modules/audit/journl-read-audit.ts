import type { Request } from "express";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { logger } from "../../utils/logger.js";
import { recordAudit, type AuditOutcome } from "./audit.service.js";

/**
 * Read-audit for client JournL data. JournL only sees the client owner's session, so these rows are the only record
 * of which Accountanz user (staff or admin) read which client's books. One row per read, whatever the outcome.
 */

/** Who/where for a read-audit row. */
export interface RequestContext {
  requestId?: string | null;
  ipAddress?: string | null;
  endpoint?: string | null;
}

/** What a JournL read was for: the feature key (or "overview"), a readable label and the period asked for. */
export interface ReadTarget {
  feature: string;
  label: string;
  from?: string;
  to?: string;
  extra?: string;
}

/** The path only (no query string), so nothing user-typed beyond the route lands in audit. */
export function requestContext(req: Request): RequestContext {
  return { requestId: req.id == null ? null : String(req.id), ipAddress: req.ip ?? null, endpoint: `${req.method} ${req.baseUrl}${req.path}` };
}

const AUDIT_ACTION: Record<AuditOutcome, string> = {
  success: "JournL data viewed",
  denied: "JournL data access denied",
  failed: "JournL data access failed",
};

/** 403/404 are access decisions; anything else (409 session/connection, JournL errors) is a failure. */
function outcomeOf(err: unknown): AuditOutcome {
  return err instanceof AppError && (err.status === 403 || err.status === 404) ? "denied" : "failed";
}

/**
 * Runs one client JournL read and writes exactly one audit row for it. The read's own result or error is passed
 * through unchanged (same HTTP response; a 404 still hides whether the client exists).
 */
export async function auditedJournlRead<T>(
  actor: AuthUser,
  clientId: number | null,
  ctx: RequestContext,
  target: ReadTarget,
  run: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (err) {
    await writeReadAudit(actor, clientId, ctx, target, outcomeOf(err), err);
    throw err;
  }
  await writeReadAudit(actor, clientId, ctx, target, "success");
  return result;
}

/**
 * Never throws: an audit-write failure must not block an accounting read, but it is never swallowed silently either
 * (logged at error level for monitoring). Only metadata is written: no tokens, credentials or accounting data.
 */
async function writeReadAudit(
  actor: AuthUser,
  clientId: number | null,
  ctx: RequestContext,
  t: ReadTarget,
  outcome: AuditOutcome,
  err?: unknown,
) {
  const range = t.from || t.to ? ` ${t.from ?? "…"} to ${t.to ?? "…"}` : "";
  const reason = err instanceof AppError ? ` [${err.status} ${err.code}]` : err ? " [error]" : "";
  const entry = {
    action: AUDIT_ACTION[outcome],
    entityType: "JournlFeature",
    entityId: t.feature,
    clientId,
    details: `${t.label}${range}${t.extra ? ` (${t.extra})` : ""}${reason}`,
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
    if (clientId != null && (auditErr as { code?: string }).code === "ER_NO_REFERENCED_ROW_2") {
      try {
        await recordAudit(actor, { ...entry, clientId: null, details: `client #${clientId}: ${entry.details}` });
        return;
      } catch (retryErr) {
        failure = retryErr;
      }
    }
    logger.error(
      { err: failure, audit: { actorId: actor.id, clientId, feature: t.feature, outcome, requestId: ctx.requestId ?? null } },
      "JournL read-audit write failed",
    );
  }
}
