import type { PoolConnection } from "mysql2/promise";
import { query, queryOne } from "../../database/connection.js";
import { isAdmin } from "../access/client-access.js";
import type { PortalRole } from "../../types/auth.types.js";

/** null = Unlimited. */
export type Limit = number | null;

export interface Entitlement {
  packageName: string;
  workspaceLimit: Limit;
  staffPerWorkspace: Limit;
  teamRoles: string[];
  base: { workspaces: Limit; staff: Limit };
}

/** Unlimited stays Unlimited; otherwise the base plus every extra. */
export function combineLimit(base: Limit, extras: number[]): Limit {
  return base === null ? null : base + extras.reduce((a, b) => a + b, 0);
}

/** Portal admins (the same list as the client-access rule). */
export const isPortalAdminRole = (role: string): boolean => isAdmin({ role: role as PortalRole });

/** Add-ons are a Project 2 concern; until then they contribute nothing. */
const ADD_ON_EXTRAS: { workspaces: number[]; staff: number[] } = { workspaces: [], staff: [] };

const parseRoles = (v: unknown): string[] => {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
};

interface PackageRow {
  name: string;
  workspace_limit: number | null;
  staff_per_workspace: number | null;
  team_roles: unknown;
}

/** The client's package limits plus live overrides; null when the client has no active engagement. */
export async function effectiveEntitlement(clientId: number, conn?: PoolConnection): Promise<Entitlement | null> {
  const pkg = await queryOne<PackageRow>(
    `SELECT p.name, p.workspace_limit, p.staff_per_workspace, p.team_roles
       FROM engagements e JOIN packages p ON p.id = e.package_id
      WHERE e.client_id = ? AND e.status = 'active' LIMIT 1`,
    [clientId],
    conn,
  );
  if (!pkg) return null;

  const overrides = await query<{ limit_type: "workspaces" | "staff_per_workspace"; extra: number }>(
    `SELECT limit_type, extra FROM client_entitlement_overrides
      WHERE client_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= CURDATE())`,
    [clientId],
    conn,
  );
  const extras = (type: string) => overrides.filter((o) => o.limit_type === type).map((o) => Number(o.extra));

  return {
    packageName: pkg.name,
    workspaceLimit: combineLimit(pkg.workspace_limit, [...extras("workspaces"), ...ADD_ON_EXTRAS.workspaces]),
    staffPerWorkspace: combineLimit(pkg.staff_per_workspace, [...extras("staff_per_workspace"), ...ADD_ON_EXTRAS.staff]),
    teamRoles: parseRoles(pkg.team_roles),
    base: { workspaces: pkg.workspace_limit, staff: pkg.staff_per_workspace },
  };
}
