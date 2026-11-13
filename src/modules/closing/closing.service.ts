import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./closing.repository.js";
import type { ChecklistRow, ClosingGrid, ClosingStatus } from "./closing.types.js";

const PERIODS_SHOWN = 4;

/** The current month and the three before it, newest first ('YYYY-MM'). */
export function recentPeriods(now = new Date(), count = PERIODS_SHOWN) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

export async function getGrid(): Promise<ClosingGrid> {
  const periods = recentPeriods();
  const [clients, counts, closings] = await Promise.all([repo.listClientsForGrid(), repo.taskCounts(periods), repo.closings(periods)]);
  const rows = clients.map((c) => ({
    ...c,
    cells: Object.fromEntries(
      periods.map((p) => {
        const count = counts.find((x) => x.client_id === c.client_id && x.period === p);
        const closing = closings.find((x) => x.client_id === c.client_id && x.period === p);
        return [
          p,
          {
            status: closing?.status ?? "open",
            approved: Number(count?.approved ?? 0),
            total: Number(count?.total ?? 0),
            closed_by_email: closing?.closed_by_email ?? null,
            closed_at: closing?.closed_at ?? null,
            ready_override: closing?.ready_override ?? null,
          },
        ];
      }),
    ),
  }));
  return { periods, rows };
}

const ACTIONS: Record<ClosingStatus, string> = { open: "Period reopened", ready: "Period marked ready", closed: "Period closed" };

const count = (v: unknown) => Number(v ?? 0);

/** The month-end checklist rule: what is done, whether everything is, and what is still open (in words). */
export function assessChecklist(r: ChecklistRow) {
  const facts = {
    tasks_total: count(r.tasks_total),
    tasks_approved: count(r.tasks_approved),
    tasks_submitted: count(r.tasks_submitted),
    open_requests: count(r.open_requests),
    pending_approvals: count(r.pending_approvals),
    reports_published: count(r.reports_published),
    reports_draft: count(r.reports_draft),
  };
  const done = {
    tasks: facts.tasks_total > 0 && facts.tasks_approved === facts.tasks_total,
    documents: facts.open_requests === 0,
    approvals: facts.pending_approvals === 0,
    reports: facts.reports_published > 0,
  };
  const missing = [
    !done.tasks && (facts.tasks_total === 0 ? "no tasks for this month" : `${facts.tasks_total - facts.tasks_approved} of ${facts.tasks_total} tasks not approved`),
    !done.documents && `${facts.open_requests} document request(s) outstanding`,
    !done.approvals && `${facts.pending_approvals} client approval(s) pending`,
    !done.reports && "no report published",
  ].filter((m): m is string => !!m);
  return { ...facts, done, complete: missing.length === 0, missing };
}

/**
 * Sets a client's period to open / ready / closed; every change writes an audit entry. Marking a period ready needs
 * a complete checklist, or an override reason from the caller (an admin, or a reviewer on the client: the routes
 * decide who may call this). Callers check their own authority; this owns the readiness rule.
 */
export async function setStatus(actor: AuthUser, clientId: number, period: string, status: ClosingStatus, overrideReason?: string) {
  const client = await repo.findClient(clientId);
  if (!client) throw AppError.notFound("Client");
  await withTransaction(async (conn) => {
    const before = (await repo.currentStatus(clientId, period, conn))?.status ?? "open";
    if (before === status) return;
    let override: string | null = null;
    let details = `${period} ${status} for ${client.name}`;
    if (status === "ready") {
      const row = (await repo.checklist({ sql: "{c} = ?", params: [clientId] }, period))[0];
      const missing = row ? assessChecklist(row).missing : ["client is not onboarding or active"];
      if (missing.length) {
        if (!overrideReason) {
          const message = `The checklist isn't complete: ${missing.join("; ")}. Give a reason to mark it ready anyway.`;
          throw new AppError("CONFLICT", message, { missing, fieldErrors: { reason: ["A reason is required while checklist items are open"] } });
        }
        override = overrideReason;
        details += ` with open items (${missing.join("; ")}). Reason: ${overrideReason}`;
      }
    }
    await repo.setStatus(clientId, period, status, actor.id, override, conn);
    await recordAudit(actor, { action: override ? "Period marked ready (override)" : ACTIONS[status], entityType: "PeriodClosing", entityId: period, clientId, details }, conn);
  });
}
