import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { AuthUser } from "../../types/auth.types.js";

vi.mock("../../database/connection.js", () => ({ queryOne: vi.fn() }));

const { spaceRoleFor, rejectWritesWhenArchived } = await import("./project-access.js");

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
