import { listAuditLogs } from "../audit/audit.repository.js";
import * as repo from "./dashboard.repository.js";
import type { AdminDashboard } from "./dashboard.types.js";

const CLOSING_CHECK_FROM_DAY = 20;

export async function getAdminDashboard(now = new Date()): Promise<AdminDashboard> {
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const closingCheckActive = now.getDate() > CLOSING_CHECK_FROM_DAY;

  const [clients, engagements, tasks, reviews, revenue, behind, audit] = await Promise.all([
    repo.clientCounts(),
    repo.engagementCounts(),
    repo.taskCounts(period),
    repo.reviewCounts(),
    repo.revenue(period),
    closingCheckActive ? repo.behindOnClosing(period) : Promise.resolve([]),
    listAuditLogs({ page: 1, pageSize: 10 }),
  ]);

  return {
    period,
    clients,
    engagements,
    tasks,
    reviews,
    revenue,
    behindOnClosing: behind,
    closingCheckActive,
    latestAudit: audit.items,
  };
}
