import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, PortalRole } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../database/connection.js", () => ({ query: m.query, queryOne: vi.fn(), execute: vi.fn(), pool: {} }));

const { listAwaitingApproval } = await import("./correction.repository.js");
const user = (id: number, role: PortalRole): AuthUser => ({ id, role }) as AuthUser;

beforeEach(() => vi.resetAllMocks());

describe("listAwaitingApproval", () => {
  it("super_admin: all pending, excluding their own", async () => {
    m.query.mockResolvedValueOnce([{ id: 1, payload: '{"a":1}' }]);
    const rows = await listAwaitingApproval(user(4, "super_admin"));
    const [sql, params] = m.query.mock.calls[0]!;
    expect(sql).toContain("status = 'pending_approval'");
    expect(sql).toContain("initiated_by <> ?");
    expect(sql).not.toContain("assignments");
    expect(params).toEqual([4]);
    expect(rows[0]!.payload).toEqual({ a: 1 });
  });

  it("ops_admin: empty, and no query is run", async () => {
    expect(await listAwaitingApproval(user(5, "ops_admin"))).toEqual([]);
    expect(m.query).not.toHaveBeenCalled();
  });

  it("staff: only clients where they hold a reviewer role today, excluding their own", async () => {
    m.query.mockResolvedValueOnce([]);
    await listAwaitingApproval(user(6, "bookkeeper"));
    const [sql, params] = m.query.mock.calls[0]!;
    expect(sql).toContain("initiated_by <> ?");
    expect(sql).toContain("a.user_id = ? AND a.client_id = c.client_id AND a.team_role IN (?, ?, ?)");
    expect(sql).toContain("a.status = 'active' AND a.valid_from <= CURDATE()");
    expect(params).toEqual([6, 6, "finance_manager", "reviewer", "cfo"]);
  });
});
