import { AppError } from "../../utils/app-error.js";
import { recentPeriods } from "../closing/closing.service.js";
import * as repo from "./progress.repository.js";

const TREND_MONTHS = 6;

/** "2026-11" → { start: "2026-11-01", end: "2026-12-01" }. */
export function monthRange(period: string): repo.MonthRange {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start: `${period}-01`, end: `${next}-01` };
}

const currentPeriod = () => recentPeriods(new Date(), 1)[0]!;

/** mysql2 returns SUM()/boolean expressions as strings; make every count a number. */
const num = (v: unknown) => Number(v ?? 0);

function summary(r: repo.SummaryRow) {
  const reviewed = num(r.approved) + num(r.returned);
  return {
    user_id: r.user_id,
    full_name: r.full_name,
    email: r.email,
    portal_role: r.portal_role,
    status: r.status,
    staff_type: r.staff_type,
    active_clients: num(r.active_clients),
    open_tasks: num(r.open_tasks),
    overdue: num(r.overdue),
    awaiting_review: num(r.awaiting_review),
    to_review: num(r.to_review),
    approved: num(r.approved),
    returned: num(r.returned),
    /** Share of this month's reviews that were approvals; null when nothing was reviewed. */
    approval_rate: reviewed ? Math.round((num(r.approved) / reviewed) * 100) : null,
    hours: Math.round(num(r.minutes) / 6) / 10,
  };
}

/** Everyone on the team with their headline numbers for the month. */
export async function listProgress(period = currentPeriod()) {
  const rows = await repo.listSummaries(monthRange(period));
  return { period, periods: recentPeriods(new Date(), 12), items: rows.map(summary) };
}

/** One person's progress: headline numbers, per-client work, a 6-month trend, open tasks and recent reviews. */
export async function personProgress(userId: number, period = currentPeriod()) {
  const months = recentPeriods(new Date(), TREND_MONTHS).reverse();
  const [row, clients, trend, open, reviews] = await Promise.all([
    repo.findSummary(userId, monthRange(period)),
    repo.clientBreakdown(userId, period),
    repo.monthlyTrend(userId, monthRange(months[0]!).start, monthRange(months.at(-1)!).end),
    repo.openTasks(userId),
    repo.recentReviews(userId),
  ]);
  if (!row) throw AppError.notFound("Team member");

  const byMonth = <T extends { month: string }>(list: T[]) => new Map(list.map((x) => [x.month, x]));
  const reviewMap = byMonth(trend.reviews);
  const timeMap = byMonth(trend.time);

  return {
    period,
    periods: recentPeriods(new Date(), 12),
    person: summary(row),
    clients: clients.map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      roles: c.roles ? c.roles.split(",") : [],
      period_total: num(c.period_total),
      period_approved: num(c.period_approved),
      open_tasks: num(c.open_tasks),
      overdue: num(c.overdue),
      awaiting_review: num(c.awaiting_review),
    })),
    trend: months.map((month) => ({
      month,
      approved: num(reviewMap.get(month)?.approved),
      returned: num(reviewMap.get(month)?.returned),
      hours: Math.round(num(timeMap.get(month)?.minutes) / 6) / 10,
    })),
    open_tasks: open.map((t) => ({ ...t, overdue: Boolean(num(t.overdue)) })),
    recent_reviews: reviews,
  };
}
