import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  billedByMonth: vi.fn(),
  collectedByMonth: vi.fn(),
  receivables: vi.fn(),
  topClientsByBilling: vi.fn(),
  activePackages: vi.fn(),
  deliveryByMonth: vi.fn(),
  avgReviewHours: vi.fn(),
  minutesByMonth: vi.fn(),
  deliveryByPerson: vi.fn(),
  minutesByPerson: vi.fn(),
  clientsByStatus: vi.fn(),
  newClientsByMonth: vi.fn(),
  closedByMonth: vi.fn(),
}));
vi.mock("./analytics.repository.js", () => m);
// Fixed "now" (Nov 2026) for the month list.
vi.mock("../closing/closing.service.js", () => ({
  recentPeriods: (_now: Date, count = 4) =>
    Array.from({ length: count }, (_, i) => {
      const d = new Date(2026, 10 - i, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }),
}));

const { getOverview, windowOf } = await import("./analytics.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(m)) fn.mockResolvedValue([]);
  m.receivables.mockResolvedValue(null);
  m.avgReviewHours.mockResolvedValue({ hours: null });
});

describe("windowOf", () => {
  it("covers the last N months, oldest first, as a half-open date range", () => {
    expect(windowOf(3)).toEqual({ months: ["2026-09", "2026-10", "2026-11"], start: "2026-09-01", end: "2026-12-01" });
    expect(windowOf(12).months).toHaveLength(12);
    expect(windowOf(12).start).toBe("2025-12-01");
  });
});

describe("getOverview", () => {
  it("shows no rate (not 0%) when there was nothing to measure, and zero-fills empty months", async () => {
    const o = await getOverview(3);
    expect(o.summary).toMatchObject({ billed: 0, tasks_approved: 0, first_time_approval: null, on_time: null, avg_review_days: null, outstanding: 0 });
    expect(o.monthly.map((x) => x.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(o.monthly[0]).toMatchObject({ billed: 0, approved: 0, first_time_approval: null });
  });

  it("totals the window from monthly rows and derives rates from the summed counts", async () => {
    m.billedByMonth.mockResolvedValue([{ month: "2026-10", total: "1000.50" }, { month: "2026-11", total: "500" }]);
    m.collectedByMonth.mockResolvedValue([{ month: "2026-11", total: "750" }]);
    m.deliveryByMonth.mockResolvedValue([
      { month: "2026-10", approved: "8", first_reviews: "10", first_approved: "8", turnaround_hours: "48", with_due: "8", on_time: "6" },
      { month: "2026-11", approved: "2", first_reviews: "2", first_approved: "1", turnaround_hours: null, with_due: "0", on_time: "0" },
    ]);
    m.avgReviewHours.mockResolvedValue({ hours: "36" });
    m.minutesByMonth.mockResolvedValue([{ month: "2026-10", minutes: "125" }]);
    const o = await getOverview(3);
    expect(o.summary).toMatchObject({ billed: 1500.5, collected: 750, tasks_approved: 10, first_time_approval: 75, on_time: 75, avg_review_days: 1.5, hours: 2.1 });
    expect(o.monthly[1]).toMatchObject({ month: "2026-10", approved: 8, first_time_approval: 80, on_time: 75, avg_review_days: 2 });
    expect(o.monthly[2]).toMatchObject({ month: "2026-11", on_time: null, avg_review_days: null });
  });

  it("lines each person's approvals up with the months and sorts by total", async () => {
    m.deliveryByPerson.mockResolvedValue([
      { user_id: 1, full_name: "Bea", month: "2026-11", approved: "2", first_reviews: "2", first_approved: "2", with_due: "2", on_time: "1" },
      { user_id: 2, full_name: "Al", month: "2026-09", approved: "5", first_reviews: "4", first_approved: "3", with_due: "0", on_time: "0" },
    ]);
    m.minutesByPerson.mockResolvedValue([{ user_id: 1, minutes: "90" }]);
    const o = await getOverview(3);
    expect(o.people).toEqual([
      { user_id: 2, full_name: "Al", approved: [5, 0, 0], total: 5, first_time_approval: 75, on_time: null, hours: 0 },
      { user_id: 1, full_name: "Bea", approved: [0, 0, 2], total: 2, first_time_approval: 100, on_time: 50, hours: 1.5 },
    ]);
  });
});
