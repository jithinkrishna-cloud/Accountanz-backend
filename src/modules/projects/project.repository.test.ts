import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";

const m = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() }));
vi.mock("../../database/connection.js", () => ({ query: m.query, queryOne: m.queryOne, execute: m.execute }));

const repo = await import("./project.repository.js");
const { countedMembershipSql } = await import("./project-access.js");

const conn = { tag: "tx" } as unknown as PoolConnection;
const lastSql = (fn: typeof m.query) => String(fn.mock.calls.at(-1)?.[0]);
const memberJoin = `LEFT JOIN project_space_members m ON m.space_id = s.id AND m.user_id = ? AND ${countedMembershipSql("m", "s")}`;

beforeEach(() => {
  vi.clearAllMocks();
  m.query.mockResolvedValue([]);
  m.queryOne.mockResolvedValue(null);
});

describe("space visibility counts only live memberships", () => {
  it("listSpaces joins the caller's membership through the counted-membership rule", async () => {
    await repo.listSpaces(9, "members", {});
    expect(lastSql(m.query)).toContain(memberJoin);
    expect(lastSql(m.query)).toContain("m.user_id IS NOT NULL");
  });

  it("findSpace and findSpaceByKey (used by lookup) use the same join", async () => {
    await repo.findSpace(9, 5);
    expect(lastSql(m.queryOne)).toContain(memberJoin);
    await repo.findSpaceByKey(9, "gl");
    expect(lastSql(m.queryOne)).toContain(memberJoin);
  });
});

describe("sync reads", () => {
  it("listClientTeam leaves out disabled users", async () => {
    await repo.listClientTeam(3, conn);
    expect(lastSql(m.query)).toContain("u.status <> 'disabled'");
  });

  it("listMembersWithSource is a locking read of the member rows", async () => {
    await repo.listMembersWithSource(5, conn);
    expect(lastSql(m.query)).toMatch(/FOR SHARE OF m$/);
  });
});
