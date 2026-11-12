import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./closing.repository.js";
import type { ClosingGrid, ClosingStatus } from "./closing.types.js";

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
          },
        ];
      }),
    ),
  }));
  return { periods, rows };
}

const ACTIONS: Record<ClosingStatus, string> = { open: "Period reopened", ready: "Period marked ready", closed: "Period closed" };

/** Sets a client's period to open / ready / closed. Every change writes an audit entry. */
export async function setStatus(actor: AuthUser, clientId: number, period: string, status: ClosingStatus) {
  const client = await repo.findClient(clientId);
  if (!client) throw AppError.notFound("Client");
  await withTransaction(async (conn) => {
    const before = (await repo.currentStatus(clientId, period, conn))?.status ?? "open";
    if (before === status) return;
    await repo.setStatus(clientId, period, status, actor.id, conn);
    await recordAudit(actor, { action: ACTIONS[status], entityType: "PeriodClosing", entityId: period, clientId, details: `${period} ${status} for ${client.name}` }, conn);
  });
}
