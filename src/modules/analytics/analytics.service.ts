import { recentPeriods } from "../closing/closing.service.js";
import * as repo from "./analytics.repository.js";
import type { AnalyticsOverview } from "./analytics.types.js";

/** Throughput, turnaround, revenue and portfolio mix over the last four months. */
export async function getOverview(): Promise<AnalyticsOverview> {
  const months = recentPeriods().reverse();
  const [turnaround, approvals, revenue, booked, clients] = await Promise.all([
    repo.avgReviewTurnaroundDays(months),
    repo.approvalsByAccountantMonth(months),
    repo.revenueByMonth(months),
    repo.revenueBooked(),
    repo.clientsByStatus(),
  ]);

  const people = new Map<number, { user_id: number; full_name: string; counts: number[] }>();
  for (const a of approvals) {
    const p = people.get(a.user_id) ?? { user_id: a.user_id, full_name: a.full_name, counts: months.map(() => 0) };
    p.counts[months.indexOf(a.month)] = Number(a.n);
    people.set(a.user_id, p);
  }

  return {
    months,
    avg_review_turnaround_days: Math.round(Number(turnaround) * 10) / 10,
    tasks_approved: approvals.reduce((sum, a) => sum + Number(a.n), 0),
    revenue_booked: Number(booked),
    tasks_by_accountant: [...people.values()].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    revenue_by_month: months.map((m) => Number(revenue.find((r) => r.period === m)?.total ?? 0)),
    clients_by_status: clients.map((c) => ({ status: c.status, count: Number(c.count) })),
  };
}
