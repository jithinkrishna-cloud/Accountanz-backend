import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";

const m = vi.hoisted(() => ({ queryOne: vi.fn(), query: vi.fn(), pool: {} }));
vi.mock("../../database/connection.js", () => ({ queryOne: m.queryOne, query: m.query, pool: m.pool }));

const { combineLimit, effectiveEntitlement, isPortalAdminRole } = await import("./entitlement.js");

beforeEach(() => vi.clearAllMocks());

describe("combineLimit", () => {
  it("adds extras to a numeric base", () => expect(combineLimit(3, [2])).toBe(5));
  it("keeps Unlimited unlimited", () => expect(combineLimit(null, [2])).toBeNull());
  it("keeps a zero base with no extras", () => expect(combineLimit(0, [])).toBe(0));
});

describe("isPortalAdminRole", () => {
  it("accepts admin roles only", () => {
    expect(isPortalAdminRole("super_admin")).toBe(true);
    expect(isPortalAdminRole("ops_admin")).toBe(true);
    expect(isPortalAdminRole("cfo")).toBe(false);
  });
});

describe("effectiveEntitlement", () => {
  it("returns null without an active engagement", async () => {
    m.queryOne.mockResolvedValue(null);
    expect(await effectiveEntitlement(1)).toBeNull();
    expect(m.query).not.toHaveBeenCalled();
  });

  it("combines package limits with live overrides", async () => {
    m.queryOne.mockResolvedValue({ name: "Growth", workspace_limit: 3, staff_per_workspace: 5, team_roles: '["bookkeeper"]' });
    m.query.mockResolvedValue([{ limit_type: "staff_per_workspace", extra: 2 }]);
    const conn = { tag: "tx" } as unknown as PoolConnection;
    const e = await effectiveEntitlement(1, conn);
    expect(e).toEqual({
      packageName: "Growth",
      workspaceLimit: 3,
      staffPerWorkspace: 7,
      teamRoles: ["bookkeeper"],
      base: { workspaces: 3, staff: 5 },
    });
    expect(m.queryOne.mock.calls[0][2]).toBe(conn);
    expect(m.query.mock.calls[0][2]).toBe(conn);
    expect(m.query.mock.calls[0][0]).toContain("revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= CURDATE())");
  });
});
