import type { RequestHandler, Response } from "express";
import { queryOne } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { SpaceContext, SpaceRole, Template } from "./project.types.js";

/**
 * Resolves the space for `:key` and the caller's role in it. Non-members get 404 (not 403) so space
 * keys are not revealed. Super admins act as Administrator in every space.
 */
export async function resolveSpace(user: AuthUser, key: string): Promise<SpaceContext> {
  const row = await queryOne<{ id: number; space_key: string; name: string; template: Template; client_id: number | null; role: SpaceRole | null }>(
    `SELECT s.id, s.space_key, s.name, s.template, s.client_id, m.role
       FROM project_spaces s LEFT JOIN project_space_members m ON m.space_id = s.id AND m.user_id = ?
      WHERE s.space_key = ?`,
    [user.id, key.toUpperCase()],
  );
  const role: SpaceRole | null = user.role === "super_admin" ? "admin" : (row?.role ?? null);
  if (!row || !role) throw AppError.notFound("Space");
  return { id: row.id, key: row.space_key, name: row.name, template: row.template, client_id: row.client_id, role };
}

export const withSpace: RequestHandler = async (req, res, next) => {
  res.locals.space = await resolveSpace(req.user!, String(req.params.key));
  next();
};

export const spaceOf = (res: Response) => res.locals.space as SpaceContext;

export function requireSpaceAdmin(space: SpaceContext) {
  if (space.role !== "admin") throw AppError.forbidden("Only space Administrators can do this");
}

export function requireScrum(space: SpaceContext) {
  if (space.template !== "scrum") throw AppError.conflict("Sprints are only available in Scrum spaces");
}
