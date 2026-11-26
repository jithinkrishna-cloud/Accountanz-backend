import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { AuthUser } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock("../../database/connection.js", () => ({ queryOne: m.queryOne }));

const { countedMembershipSql, resolveSpace, spaceRoleFor, rejectWritesWhenArchived } = await import("./project-access.js");

const ARCHIVED = "This space is archived. Unarchive it to make changes.";
const user = (role: string) => ({ role }) as Pick<AuthUser, "role">;

describe("spaceRoleFor", () => {
  it("applies the kind-aware truth table", () => {
    expect(spaceRoleFor(user("ops_admin"), "internal", null)).toBeNull();
    expect(spaceRoleFor(user("ops_admin"), "client_project", null)).toBe("admin");
    expect(spaceRoleFor(user("super_admin"), "internal", null)).toBe("admin");
    expect(spaceRoleFor(user("bookkeeper"), "client_primary", "member")).toBe("member");
    expect(spaceRoleFor(user("bookkeeper"), "client_primary", null)).toBeNull();
    expect(spaceRoleFor(user("ops_admin"), "internal", "member")).toBe("member");
  });
});

describe("rejectWritesWhenArchived", () => {
  const run = (method: string, path: string, archived: boolean) => {
    const next = vi.fn();
    const res = { locals: { space: { archived_at: archived ? "2026-01-01" : null } } } as unknown as Response;
    const call = () => rejectWritesWhenArchived({ method, path } as Request, res, next);
    return { next, call };
  };

  it("blocks writes on an archived space with a conflict", () => {
    for (const [m, p] of [["POST", "/items"], ["PATCH", "/items/3/comments/1"], ["DELETE", "/"]] as const) {
      const { next, call } = run(m, p, true);
      expect(call).toThrow(ARCHIVED);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("lets reads and unarchive through", () => {
    for (const [m, p] of [["GET", "/items"], ["HEAD", "/"], ["POST", "/unarchive"]] as const) {
      const { next, call } = run(m, p, true);
      call();
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("does nothing on a live space", () => {
    const { next, call } = run("POST", "/items", false);
    call();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("countedMembershipSql", () => {
  it("counts manual rows, and client_team rows only with an active assignment on the space's client", () => {
    const sql = countedMembershipSql("m", "s");
    expect(sql).toContain("m.source = 'manual'");
    expect(sql).toContain("ma.user_id = m.user_id AND ma.client_id = s.client_id");
    expect(sql).toContain("ma.status = 'active' AND ma.valid_from <= CURDATE() AND (ma.valid_to IS NULL OR ma.valid_to >= CURDATE())");
  });
});

describe("resolveSpace", () => {
  beforeEach(() => m.queryOne.mockReset());

  it("joins the caller's membership through the counted-membership rule", async () => {
    m.queryOne.mockResolvedValue({ id: 5, space_key: "GL", name: "Green Leaf", template: "kanban", client_id: 3, kind: "client_primary", archived_at: null, role: "member" });
    await resolveSpace({ id: 9, role: "bookkeeper" } as AuthUser, "gl");
    const [sql, params] = m.queryOne.mock.calls[0];
    expect(sql).toContain(`m.user_id = ? AND ${countedMembershipSql("m", "s")}`);
    expect(params).toEqual([9, "GL"]);
  });

  it("404s a staff member whose only membership is a lapsed client_team row (no counted role)", async () => {
    m.queryOne.mockResolvedValue({ id: 5, space_key: "GL", name: "Green Leaf", template: "kanban", client_id: 3, kind: "client_primary", archived_at: null, role: null });
    await expect(resolveSpace({ id: 9, role: "bookkeeper" } as AuthUser, "GL")).rejects.toThrow("Space");
  });
});
