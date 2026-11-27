import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  listSummaries: vi.fn(),
  findSummary: vi.fn(),
  clientBreakdown: vi.fn(),
  monthlyTrend: vi.fn(),
  openTasks: vi.fn(),
  recentReviews: vi.fn(),
  profile: vi.fn(),
  memberGroups: vi.fn(),
  assignmentHistory: vi.fn(),
  personTasks: vi.fn(),
  firmClients: vi.fn(),
  firmTeams: vi.fn(),
  reviewBacklog: vi.fn(),
  groupMembers: vi.fn(),
}));

vi.mock("./progress.repository.js", () => ({ ...m, TASK_VIEWS: ["open", "overdue", "review", "returned", "approved", "all"] }));
// Fixed "now" so the month lists are predictable: Nov 2026 back to Jun 2026.
vi.mock("../closing/closing.service.js", () => ({
  recentPeriods: (_now: Date, count = 4) =>
    Array.from({ length: count }, (_, i) => {
      const d = new Date(2026, 10 - i, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }),
}));

const { firmProgress, listProgress, monthRange, personProgress, personTaskList } = await import("./progress.service.js");

/** A summary row as mysql2 returns it: counts can arrive as strings. */
const row = (over: Record<string, unknown> = {}) => ({
  user_id: 7,
  full_name: "Arun Menon",
  email: "arun@accountanz.in",
  portal_role: "bookkeeper",
  status: "active",
  staff_type: "accountant",
  active_clients: 5,
  open_tasks: "68",
  overdue: "6",
  awaiting_review: 3,
  to_review: 0,
  approved: "3",
  returned: "1",
  minutes: "540",
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("monthRange", () => {
  it("is a half-open range for the month", () => {
    expect(monthRange("2026-11")).toEqual({ start: "2026-11-01", end: "2026-12-01" });
  });
  it("rolls December into January of the next year", () => {
    expect(monthRange("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
  });
});

describe("listProgress", () => {
  it("turns counts into numbers and derives approval rate and hours", async () => {
    m.listSummaries.mockResolvedValue([row(), row({ user_id: 8, approved: 0, returned: 0, minutes: 125 })]);
    const r = await listProgress("2026-11");
    expect(m.listSummaries).toHaveBeenCalledWith({ start: "2026-11-01", end: "2026-12-01" });
    expect(r.items[0]).toMatchObject({ open_tasks: 68, overdue: 6, approved: 3, returned: 1, approval_rate: 75, hours: 9 });
    // Nothing reviewed → no rate (not 0%); 125 min → 2.1 h.
    expect(r.items[1]).toMatchObject({ approval_rate: null, hours: 2.1 });
    expect(r.periods).toHaveLength(12);
  });
});

describe("personProgress", () => {
  const stub = () => {
    m.findSummary.mockResolvedValue(row());
    m.clientBreakdown.mockResolvedValue([{ client_id: 1, client_name: "ABC", roles: "bookkeeper,reviewer", period_total: "18", period_approved: "1", open_tasks: "16", overdue: "2", awaiting_review: "1" }]);
    m.monthlyTrend.mockResolvedValue({ reviews: [{ month: "2026-10", approved: "12", returned: "0" }], time: [{ month: "2026-11", minutes: "300" }] });
    m.openTasks.mockResolvedValue([{ id: 1, overdue: "1" }, { id: 2, overdue: 0 }]);
    m.recentReviews.mockResolvedValue([]);
    m.profile.mockResolvedValue({ phone: null, verification_status: "verified", expertise: null, hourly_rate: "450.00", created_at: "2026-11-14 10:00:00", last_login_at: null });
    m.memberGroups.mockResolvedValue([]);
    m.assignmentHistory.mockResolvedValue([]);
  };

  it("throws not found for an unknown person", async () => {
    stub();
    m.findSummary.mockResolvedValue(null);
    await expect(personProgress(999, "2026-11")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fills every one of the 6 trend months, oldest first, with zeros where nothing happened", async () => {
    stub();
    const r = await personProgress(7, "2026-11");
    expect(r.trend.map((t) => t.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(r.trend[4]).toEqual({ month: "2026-10", approved: 12, returned: 0, hours: 0 });
    expect(r.trend[5]).toEqual({ month: "2026-11", approved: 0, returned: 0, hours: 5 });
    // The trend query covers exactly those six months.
    expect(m.monthlyTrend).toHaveBeenCalledWith(7, "2026-06-01", "2026-12-01");
  });

  it("normalises client rows, open tasks and the profile", async () => {
    stub();
    const r = await personProgress(7, "2026-11");
    expect(r.clients[0]).toMatchObject({ roles: ["bookkeeper", "reviewer"], period_total: 18, open_tasks: 16, overdue: 2 });
    expect(r.open_tasks.map((t) => t.overdue)).toEqual([true, false]);
    expect(r.profile).toMatchObject({ expertise: [], hourly_rate: 450 });
  });
});

describe("personTaskList", () => {
  it("returns a count for every view even when the person has no tasks", async () => {
    m.personTasks.mockResolvedValue({ items: [], total: 0, counts: null });
    const r = await personTaskList(7, { view: "open", page: 1, pageSize: 20 });
    expect(r.counts).toEqual({ open: 0, overdue: 0, review: 0, returned: 0, approved: 0, all: 0 });
  });

  it("passes filters through and converts overdue and minutes", async () => {
    m.personTasks.mockResolvedValue({ items: [{ id: 1, overdue: "1", minutes: "75" }], total: 1, counts: { open: "3", overdue: "1", review: 0, returned: 0, approved: 0, all: "3" } });
    const r = await personTaskList(7, { view: "overdue", q: "bank", client_id: 4, page: 2, pageSize: 20 });
    expect(m.personTasks).toHaveBeenCalledWith(7, { view: "overdue", q: "bank", clientId: 4, page: 2, pageSize: 20 });
    expect(r.items[0]).toMatchObject({ overdue: true, hours: 1.3 });
    expect(r.counts).toMatchObject({ open: 3, overdue: 1, all: 3 });
    expect(r).toMatchObject({ total: 1, page: 2, pageSize: 20 });
  });
});

describe("firmProgress", () => {
  const client = (id: number, over: Record<string, unknown> = {}) => ({
    client_id: id, client_name: `C${id}`, status: "active", package_name: null,
    period_total: "10", period_approved: "2", open_tasks: "5", overdue: "1", awaiting_review: "1", closing_status: "open", ...over,
  });

  it("totals clients, attaches teams and counts month-end only for active clients", async () => {
    m.firmClients.mockResolvedValue([client(1, { closing_status: "ready" }), client(2), client(3, { status: "onboarding", closing_status: "closed" })]);
    m.firmTeams.mockResolvedValue([{ client_id: 1, user_id: 7, full_name: "Arun", team_role: "bookkeeper" }]);
    m.reviewBacklog.mockResolvedValue({ waiting: "4", over_two_days: "2" });
    m.listSummaries.mockResolvedValue([]);
    m.groupMembers.mockResolvedValue([]);
    const r = await firmProgress("2026-11");
    expect(r.totals).toEqual({
      active_clients: 2,
      open_tasks: 15,
      overdue: 3,
      awaiting_review: 4,
      awaiting_over_two_days: 2,
      period_total: 30,
      period_approved: 6,
      closing_done: 1, // client 3 is closed but not active
    });
    expect(r.clients[0]!.team).toEqual([{ user_id: 7, full_name: "Arun", team_role: "bookkeeper" }]);
    expect(r.clients[1]!.team).toEqual([]);
  });

  it("sums each group's members; people without a group or activity are handled", async () => {
    m.firmClients.mockResolvedValue([]);
    m.firmTeams.mockResolvedValue([]);
    m.reviewBacklog.mockResolvedValue(null);
    m.listSummaries.mockResolvedValue([
      row({ user_id: 1, full_name: "A", open_tasks: 10, overdue: 2, awaiting_review: 1, approved: 3 }),
      row({ user_id: 2, full_name: "B", open_tasks: 5, overdue: 0, awaiting_review: 0, approved: 1 }),
      row({ user_id: 3, full_name: "C", open_tasks: 4, overdue: 1, awaiting_review: 0, approved: 0 }),
      row({ user_id: 4, full_name: "Idle", open_tasks: 0, overdue: 0, awaiting_review: 0, approved: 0 }),
    ]);
    m.groupMembers.mockResolvedValue([
      { group_id: 1, group_name: "Team A", user_id: 1 },
      { group_id: 1, group_name: "Team A", user_id: 2 },
      { group_id: 1, group_name: "Team A", user_id: 99 }, // disabled account: not in the summaries
    ]);
    const r = await firmProgress("2026-11");
    expect(r.groups).toEqual([
      { group_id: 1, name: "Team A", members: [{ user_id: 1, full_name: "A" }, { user_id: 2, full_name: "B" }], open_tasks: 15, overdue: 2, awaiting_review: 1, approved: 4 },
      // C has work and no group; Idle has no work, so is left out.
      { group_id: null, name: "Not in a group", members: [{ user_id: 3, full_name: "C" }], open_tasks: 4, overdue: 1, awaiting_review: 0, approved: 0 },
    ]);
    expect(r.totals.awaiting_review).toBe(0);
  });
});
