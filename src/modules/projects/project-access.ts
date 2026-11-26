import type { RequestHandler, Response } from "express";
import { queryOne } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { SpaceContext, SpaceKind, SpaceRole, Template } from "./project.types.js";

/** Role a user holds in a space: super admins and (outside internal spaces) ops admins act as Administrator; others need membership. */
export function spaceRoleFor(user: Pick<AuthUser, "role">, kind: SpaceKind, memberRole: SpaceRole | null): SpaceRole | null {
  if (user.role === "super_admin") return "admin";
  if (user.role === "ops_admin" && kind !== "internal") return "admin";
  return memberRole;
}

/**
 * Resolves the space for `:key` and the caller's role in it. Non-members get 404 (not 403) so space
 * keys are not revealed. Super admins act as Administrator in every space.
 */
export async function resolveSpace(user: AuthUser, key: string): Promise<SpaceContext> {
  const row = await queryOne<{ id: number; space_key: string; name: string; template: Template; client_id: number | null; kind: SpaceKind; archived_at: string | null; role: SpaceRole | null }>(
    `SELECT s.id, s.space_key, s.name, s.template, s.client_id, s.kind, s.archived_at, m.role
       FROM project_spaces s LEFT JOIN project_space_members m ON m.space_id = s.id AND m.user_id = ?
      WHERE s.space_key = ?`,
    [user.id, key.toUpperCase()],
  );
  const role: SpaceRole | null = row ? spaceRoleFor(user, row.kind, row.role) : null;
  if (!row || !role) throw AppError.notFound("Space");
  return { id: row.id, key: row.space_key, name: row.name, template: row.template, client_id: row.client_id, kind: row.kind, archived_at: row.archived_at, role };
}

export const withSpace: RequestHandler = async (req, res, next) => {
  res.locals.space = await resolveSpace(req.user!, String(req.params.key));
  next();
};

export const ARCHIVED_MESSAGE = "This space is archived. Unarchive it to make changes.";

/** Archived spaces are read-only: only reads and the unarchive action get through. Mounted right after `withSpace`. */
export const rejectWritesWhenArchived: RequestHandler = (req, res, next) => {
  if (!spaceOf(res).archived_at || req.method === "GET" || req.method === "HEAD") return next();
  if (req.method === "POST" && req.path.replace(/\/+$/, "") === "/unarchive") return next();
  throw AppError.conflict(ARCHIVED_MESSAGE);
};

export const spaceOf = (res: Response) => res.locals.space as SpaceContext;

export function requireSpaceAdmin(space: SpaceContext) {
  if (space.role !== "admin") throw AppError.forbidden("Only space Administrators can do this");
}

export function requireScrum(space: SpaceContext) {
  if (space.template !== "scrum") throw AppError.conflict("Sprints are only available in Scrum spaces");
}
