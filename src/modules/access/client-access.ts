import type { PoolConnection } from "mysql2/promise";
import { pool, query } from "../../database/connection.js";
import { ADMIN_ROLES, type AuthUser, type PortalRole } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";

/**
 * The single owner of the client access rule:
 *  - super_admin / ops_admin: every client
 *  - staff: only clients where they hold an assignment that is active and covers today
 *  (the portal role alone grants nothing)
 */
export const activeAssignmentSql = (alias: string) =>
  `${alias}.status = 'active' AND ${alias}.valid_from <= CURDATE() AND (${alias}.valid_to IS NULL OR ${alias}.valid_to >= CURDATE())`;

export const isAdmin = (user: Pick<AuthUser, "role">) => (ADMIN_ROLES as readonly PortalRole[]).includes(user.role);

/** Roles that may create and edit one-off tasks (within their clients, for accountants). */
export const TASK_MANAGER_ROLES: readonly PortalRole[] = ["super_admin", "ops_admin", "finance_manager", "cfo"];
/** Team roles that may review work on a client. */
export const REVIEWER_TEAM_ROLES = ["finance_manager", "reviewer", "cfo"] as const;

/** The user's active team roles on a client today (empty = no access). */
export async function activeTeamRoles(userId: number, clientId: number, db: PoolConnection | typeof pool = pool): Promise<string[]> {
  const rows = await query<{ team_role: string }>(
    `SELECT DISTINCT a.team_role FROM assignments a WHERE a.user_id = ? AND a.client_id = ? AND ${activeAssignmentSql("a")}`,
    [userId, clientId],
    db,
  );
  return rows.map((r) => r.team_role);
}

export async function canAccessClient(user: AuthUser, clientId: number) {
  return isAdmin(user) || (await activeTeamRoles(user.id, clientId)).length > 0;
}

/** SQL predicate restricting `${column}` to clients the user may see. Admins: no restriction. */
export function clientScope(user: AuthUser, column: string): { sql: string; params: number[] } {
  if (isAdmin(user)) return { sql: "1 = 1", params: [] };
  return {
    sql: `${column} IN (SELECT a.client_id FROM assignments a WHERE a.user_id = ? AND ${activeAssignmentSql("a")})`,
    params: [user.id],
  };
}

/** Throws "not found" (rather than forbidden) so staff can't probe which clients exist. */
export async function requireClientAccess(user: AuthUser, clientId: number, what = "Client") {
  if (!(await canAccessClient(user, clientId))) throw AppError.notFound(what);
}

/** Admins, or staff holding a reviewer team role on the client today (publishing, closing readiness). */
export async function isClientReviewer(user: AuthUser, clientId: number) {
  if (isAdmin(user)) return true;
  const roles = await activeTeamRoles(user.id, clientId);
  return roles.some((r) => (REVIEWER_TEAM_ROLES as readonly string[]).includes(r));
}
