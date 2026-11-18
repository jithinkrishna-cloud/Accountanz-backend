import { execute, queryOne, withTransaction, type Param } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import type { RequestContext } from "../audit/journl-read-audit.js";
import { toCorrectionRow } from "./correction.repository.js";
import { correctionRef, type CorrectionRow, type CorrectionStatus } from "./correction.types.js";

/** posting -> approved exists only for the "session/branch" refusal path (nothing was sent to JournL). */
export const ALLOWED: Record<CorrectionStatus, CorrectionStatus[]> = {
  draft: ["pending_approval"],
  pending_approval: ["approved", "rejected", "draft"],
  approved: ["posting", "rejected"],
  posting: ["posted", "rejected", "unknown", "approved"],
  unknown: ["posted", "rejected"],
  posted: [],
  rejected: [],
};

/** Columns transition may set besides status. Never built from input names. */
const SETTABLE = [
  "approved_by",
  "approved_at",
  "review_comment",
  "journl_session_owner",
  "journl_voucher_id",
  "rejected_by_source",
  "journl_message",
] as const;

/**
 * Moves a correction from `from` to `to` atomically. The conditional UPDATE (WHERE id=? AND status=?) is the
 * single-send gate: of any number of concurrent callers exactly one matches the row; the rest get 409.
 */
export async function transition(
  id: number,
  from: CorrectionStatus,
  to: CorrectionStatus,
  actor: AuthUser | null,
  ctx: RequestContext,
  fields: Partial<CorrectionRow> = {},
  note?: string,
): Promise<CorrectionRow> {
  if (!Object.hasOwn(ALLOWED, from) || !ALLOWED[from].includes(to)) {
    throw new AppError("VALIDATION_ERROR", `A correction cannot move from ${from} to ${to}`);
  }
  return withTransaction(async (conn) => {
    const sets = ["status = ?"];
    const params: Param[] = [to];
    for (const col of SETTABLE) {
      const v = (fields as Record<string, unknown>)[col];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(col === "journl_message" && typeof v === "string" ? v.slice(0, 1000) : ((v ?? null) as Param));
    }
    params.push(id, from);
    const res = await execute(`UPDATE journl_corrections SET ${sets.join(", ")} WHERE id = ? AND status = ?`, params, conn);
    if (res.affectedRows === 0) {
      const cur = await queryOne<{ status: string }>("SELECT status FROM journl_corrections WHERE id = ?", [id], conn);
      if (!cur) throw AppError.notFound("Correction");
      throw AppError.conflict(`This correction was already ${cur.status}`);
    }
    await execute(
      "INSERT INTO journl_correction_events (correction_id, from_status, to_status, actor_id, note, request_id) VALUES (?, ?, ?, ?, ?, ?)",
      [id, from, to, actor?.id ?? null, note?.slice(0, 1000) ?? null, ctx.requestId?.slice(0, 64) ?? null],
      conn,
    );
    const raw = await queryOne<Record<string, unknown>>("SELECT * FROM journl_corrections WHERE id = ?", [id], conn);
    const row = toCorrectionRow(raw as Record<string, unknown>);
    await recordAudit(
      actor,
      {
        action: `JournL correction ${to}`,
        entityType: "JournlCorrection",
        entityId: correctionRef(id),
        clientId: row.client_id,
        details: `${from} -> ${to}`,
        outcome: "success",
        endpoint: ctx.endpoint ?? null,
        requestId: ctx.requestId ?? null,
        ipAddress: ctx.ipAddress ?? null,
      },
      conn,
    );
    return row;
  });
}
