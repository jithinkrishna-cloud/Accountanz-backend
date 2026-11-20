import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../database/connection.js", () => ({ query: m.query, queryOne: vi.fn(), execute: vi.fn(), pool: {} }));

const { publicAccountants } = await import("../accountant-requests/accountant-request.repository.js");

describe("publicAccountants", () => {
  beforeEach(() => m.query.mockReset());

  it("returns only name, role, expertise and start date, even if the row carries more", async () => {
    m.query.mockResolvedValue([
      { full_name: "Meera Joshi", role: "finance_manager", expertise: '["Month-end close","GST"]', member_since: "2026-01-04", hourly_rate: 850, email: "x@y.z", id: 7 },
    ]);
    expect(await publicAccountants()).toEqual([{ full_name: "Meera Joshi", role: "finance_manager", expertise: ["Month-end close", "GST"], member_since: "2026-01-04" }]);
  });

  it("selects only public columns and only verified, active accountants", async () => {
    m.query.mockResolvedValue([]);
    await publicAccountants();
    const sql = String(m.query.mock.calls[0][0]);
    expect(sql).toMatch(/verification_status = 'verified'/);
    expect(sql).toMatch(/u\.status = 'active'/);
    const selected = sql.slice(sql.indexOf("SELECT"), sql.indexOf("FROM"));
    expect(selected).not.toMatch(/email|phone|rate|bank|\bid\b/i);
  });

  it("reads expertise stored as an array or bad JSON safely", async () => {
    m.query.mockResolvedValue([
      { full_name: "A", role: "bookkeeper", expertise: ["TDS"], member_since: "2026-02-01" },
      { full_name: "B", role: "bookkeeper", expertise: "not json", member_since: "2026-02-01" },
    ]);
    const r = await publicAccountants();
    expect(r.map((a) => a.expertise)).toEqual([["TDS"], []]);
  });
});

const pk = vi.hoisted(() => ({ listPackages: vi.fn() }));
vi.mock("../packages/package.repository.js", () => ({ listPackages: pk.listPackages }));
vi.mock("express-rate-limit", () => ({ default: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

describe("publicPackages", () => {
  it("returns only active packages, cheapest first, without ids or service codes", async () => {
    const { publicPackages } = await import("./public.routes.js");
    pk.listPackages.mockResolvedValue([
      { id: 1, name: "Growth", description: "d", monthly_fee: "48000.00", billing_cycle: "monthly", scope_notes: "s", team_roles: '["bookkeeper","cfo"]', is_active: true, services: [{ id: 3, code: "GST-R", name: "GST Filing" }] },
      { id: 2, name: "Basic", description: null, monthly_fee: 25000, billing_cycle: "monthly", scope_notes: null, team_roles: ["bookkeeper"], is_active: true, services: [] },
      { id: 3, name: "Old", description: null, monthly_fee: 1000, billing_cycle: "monthly", scope_notes: null, team_roles: [], is_active: false, services: [] },
    ]);
    expect(await publicPackages()).toEqual([
      { name: "Basic", description: null, monthly_fee: 25000, billing_cycle: "monthly", scope_notes: null, team_roles: ["bookkeeper"], services: [] },
      { name: "Growth", description: "d", monthly_fee: 48000, billing_cycle: "monthly", scope_notes: "s", team_roles: ["bookkeeper", "cfo"], services: ["GST Filing"] },
    ]);
  });
});
