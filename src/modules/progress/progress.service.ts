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
  const [row, clients, trend, open, reviews, prof, groups, assignments] = await Promise.all([
    repo.findSummary(userId, monthRange(period)),
    repo.clientBreakdown(userId, period),
    repo.monthlyTrend(userId, monthRange(months[0]!).start, monthRange(months.at(-1)!).end),
    repo.openTasks(userId),
    repo.recentReviews(userId),
    repo.profile(userId),
    repo.memberGroups(userId),
    repo.assignmentHistory(userId),
  ]);
  if (!row) throw AppError.notFound("Team member");

  const byMonth = <T extends { month: string }>(list: T[]) => new Map(list.map((x) => [x.month, x]));
  const reviewMap = byMonth(trend.reviews);
  const timeMap = byMonth(trend.time);

  return {
    period,
    periods: recentPeriods(new Date(), 12),
    person: summary(row),
    profile: prof && {
      phone: prof.phone,
      verification_status: prof.verification_status,
      expertise: Array.isArray(prof.expertise) ? prof.expertise : [],
      hourly_rate: prof.hourly_rate == null ? null : Number(prof.hourly_rate),
      member_since: prof.created_at,
      last_login_at: prof.last_login_at,
    },
    groups,
    assignments,
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

/**
 * Firm progress: every client's work for the month (with who is on it), plus each staff group's combined numbers.
 * The per-person view is personProgress; this is the per-client one.
 */
export async function firmProgress(period = currentPeriod()) {
  const [clients, teams, backlog, people, groups] = await Promise.all([
    repo.firmClients(period),
    repo.firmTeams(),
    repo.reviewBacklog(),
    repo.listSummaries(monthRange(period)),
    repo.groupMembers(),
  ]);

  const teamOf = new Map<number, { user_id: number; full_name: string; team_role: string }[]>();
  for (const t of teams) teamOf.set(t.client_id, [...(teamOf.get(t.client_id) ?? []), { user_id: t.user_id, full_name: t.full_name, team_role: t.team_role }]);

  const items = clients.map((c) => ({
    client_id: c.client_id,
    client_name: c.client_name,
    status: c.status,
    package_name: c.package_name,
    period_total: num(c.period_total),
    period_approved: num(c.period_approved),
    open_tasks: num(c.open_tasks),
    overdue: num(c.overdue),
    awaiting_review: num(c.awaiting_review),
    closing_status: c.closing_status,
    team: teamOf.get(c.client_id) ?? [],
  }));

  // Group numbers are the sum of their members' own numbers (a person in two groups counts in both).
  const personById = new Map(people.map((p) => [p.user_id, summary(p)]));
  const groupMap = new Map<number, { group_id: number; name: string; members: { user_id: number; full_name: string }[] }>();
  for (const g of groups) {
    const p = personById.get(g.user_id);
    if (!p) continue; // disabled accounts
    const entry = groupMap.get(g.group_id) ?? { group_id: g.group_id, name: g.group_name, members: [] };
    entry.members.push({ user_id: p.user_id, full_name: p.full_name });
    groupMap.set(g.group_id, entry);
  }
  const totals = (ids: number[]) => {
    const list = ids.map((id) => personById.get(id)!);
    return {
      open_tasks: list.reduce((s, p) => s + p.open_tasks, 0),
      overdue: list.reduce((s, p) => s + p.overdue, 0),
      awaiting_review: list.reduce((s, p) => s + p.awaiting_review, 0),
      approved: list.reduce((s, p) => s + p.approved, 0),
    };
  };
  const grouped = new Set(groups.map((g) => g.user_id));
  const ungrouped = people.filter((p) => !grouped.has(p.user_id) && (num(p.open_tasks) + num(p.awaiting_review) + num(p.approved) > 0));

  const active = items.filter((c) => c.status === "active");
  return {
    period,
    periods: recentPeriods(new Date(), 12),
    totals: {
      active_clients: active.length,
      open_tasks: items.reduce((s, c) => s + c.open_tasks, 0),
      overdue: items.reduce((s, c) => s + c.overdue, 0),
      awaiting_review: num(backlog?.waiting),
      awaiting_over_two_days: num(backlog?.over_two_days),
      period_total: items.reduce((s, c) => s + c.period_total, 0),
      period_approved: items.reduce((s, c) => s + c.period_approved, 0),
      /** Active clients whose month is marked ready or closed. */
      closing_done: active.filter((c) => c.closing_status !== "open").length,
    },
    clients: items,
    groups: [
      ...[...groupMap.values()].map((g) => ({ ...g, ...totals(g.members.map((m) => m.user_id)) })),
      ...(ungrouped.length
        ? [{ group_id: null, name: "Not in a group", members: ungrouped.map((p) => ({ user_id: p.user_id, full_name: p.full_name })), ...totals(ungrouped.map((p) => p.user_id)) }]
        : []),
    ],
  };
}

/** One page of a person's tasks for a view (open, overdue, review, returned, approved, all), with the count per view. */
export async function personTaskList(userId: number, q: { view: repo.TaskView; q?: string; client_id?: number; page: number; pageSize: number }) {
  const r = await repo.personTasks(userId, { view: q.view, q: q.q, clientId: q.client_id, page: q.page, pageSize: q.pageSize });
  const counts = Object.fromEntries(repo.TASK_VIEWS.map((v) => [v, num(r.counts?.[v])])) as Record<repo.TaskView, number>;
  return {
    items: r.items.map((t) => ({ ...t, overdue: Boolean(num(t.overdue)), hours: Math.round(num(t.minutes) / 6) / 10 })),
    total: r.total,
    page: q.page,
    pageSize: q.pageSize,
    counts,
  };
}
