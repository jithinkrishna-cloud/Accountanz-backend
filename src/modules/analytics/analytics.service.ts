import { recentPeriods } from "../closing/closing.service.js";
import * as repo from "./analytics.repository.js";
import type { AnalyticsOverview, AnalyticsRange, Rate } from "./analytics.types.js";

const num = (v: unknown) => Number(v ?? 0);
const rate = (part: number, whole: number): Rate => (whole > 0 ? Math.round((part / whole) * 100) : null);
const hours = (minutes: number) => Math.round(minutes / 6) / 10;
const days = (h: number | null) => (h == null ? null : Math.round((h / 24) * 10) / 10);

/** The last `range` months, oldest first, as periods and a [start, end) date range. */
export function windowOf(range: AnalyticsRange, now = new Date()): repo.Window {
  const months = recentPeriods(now, range).reverse();
  const [y, m] = months.at(-1)!.split("-").map(Number) as [number, number];
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { months, start: `${months[0]}-01`, end };
}

/** Revenue, delivery, team and client numbers for the last 3, 6 or 12 months. */
export async function getOverview(range: AnalyticsRange = 6): Promise<AnalyticsOverview> {
  const w = windowOf(range);
  const [billed, collected, owed, top, packages, delivery, minutes, byPerson, personMinutes, statuses, newClients, closed, review] = await Promise.all([
    repo.billedByMonth(w),
    repo.collectedByMonth(w),
    repo.receivables(),
    repo.topClientsByBilling(w),
    repo.activePackages(),
    repo.deliveryByMonth(w),
    repo.minutesByMonth(w),
    repo.deliveryByPerson(w),
    repo.minutesByPerson(w),
    repo.clientsByStatus(),
    repo.newClientsByMonth(w),
    repo.closedByMonth(w),
    repo.avgReviewHours(w),
  ]);

  const at = <T extends { month: string }>(list: T[]) => new Map(list.map((x) => [x.month, x]));
  const [billedM, collectedM, deliveryM, minutesM, newM, closedM] = [at(billed), at(collected), at(delivery), at(minutes), at(newClients), at(closed)];

  const monthly = w.months.map((month) => {
    const d = deliveryM.get(month);
    return {
      month,
      billed: num(billedM.get(month)?.total),
      collected: num(collectedM.get(month)?.total),
      approved: num(d?.approved),
      first_time_approval: rate(num(d?.first_approved), num(d?.first_reviews)),
      on_time: rate(num(d?.on_time), num(d?.with_due)),
      avg_review_days: days(d?.turnaround_hours == null ? null : num(d.turnaround_hours)),
      hours: hours(num(minutesM.get(month)?.minutes)),
      new_clients: num(newM.get(month)?.n),
      closed_clients: num(closedM.get(month)?.closed),
    };
  });

  const sum = (k: "approved" | "first_reviews" | "first_approved" | "with_due" | "on_time") => delivery.reduce((s, d) => s + num(d[k]), 0);

  const minutesOf = new Map(personMinutes.map((p) => [p.user_id, num(p.minutes)]));
  const people = new Map<number, { user_id: number; full_name: string; approved: number[]; first_reviews: number; first_approved: number; with_due: number; on_time: number }>();
  for (const r of byPerson) {
    const p = people.get(r.user_id) ?? { user_id: r.user_id, full_name: r.full_name, approved: w.months.map(() => 0), first_reviews: 0, first_approved: 0, with_due: 0, on_time: 0 };
    p.approved[w.months.indexOf(r.month)] = num(r.approved);
    p.first_reviews += num(r.first_reviews);
    p.first_approved += num(r.first_approved);
    p.with_due += num(r.with_due);
    p.on_time += num(r.on_time);
    people.set(r.user_id, p);
  }

  return {
    months: w.months,
    range,
    summary: {
      billed: monthly.reduce((s, m) => s + m.billed, 0),
      collected: monthly.reduce((s, m) => s + m.collected, 0),
      outstanding: num(owed?.outstanding),
      overdue: num(owed?.overdue),
      overdue_invoices: num(owed?.overdue_invoices),
      monthly_fees: packages.reduce((s, p) => s + num(p.monthly_fees), 0),
      tasks_approved: sum("approved"),
      first_time_approval: rate(sum("first_approved"), sum("first_reviews")),
      on_time: rate(sum("on_time"), sum("with_due")),
      avg_review_days: days(review?.hours == null ? null : num(review.hours)),
      hours: monthly.reduce((s, m) => Math.round((s + m.hours) * 10) / 10, 0),
    },
    monthly,
    people: [...people.values()]
      .map((p) => ({
        user_id: p.user_id,
        full_name: p.full_name,
        approved: p.approved,
        total: p.approved.reduce((s, n) => s + n, 0),
        first_time_approval: rate(p.first_approved, p.first_reviews),
        on_time: rate(p.on_time, p.with_due),
        hours: hours(minutesOf.get(p.user_id) ?? 0),
      }))
      .sort((a, b) => b.total - a.total || a.full_name.localeCompare(b.full_name)),
    top_clients: top.map((c) => ({ client_id: c.client_id, client_name: c.client_name, total: num(c.total) })),
    packages: packages.map((p) => ({ package_id: p.package_id, name: p.name, clients: num(p.clients), monthly_fees: num(p.monthly_fees) })),
    clients_by_status: statuses.map((c) => ({ status: c.status, count: num(c.count) })),
  };
}
