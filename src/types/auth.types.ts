export const PORTAL_ROLES = [
  "super_admin",
  "ops_admin",
  "bookkeeper",
  "finance_manager",
  "cfo",
  "client_owner",
  "client_member",
] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];

export const ADMIN_ROLES = ["super_admin", "ops_admin"] as const satisfies readonly PortalRole[];
export const ACCOUNTANT_ROLES = ["bookkeeper", "finance_manager", "cfo"] as const satisfies readonly PortalRole[];
export const CLIENT_ROLES = ["client_owner", "client_member"] as const satisfies readonly PortalRole[];

export type Portal = "admin" | "team" | "app";

export const portalOf = (role: PortalRole): Portal =>
  (ADMIN_ROLES as readonly string[]).includes(role)
    ? "admin"
    : (ACCOUNTANT_ROLES as readonly string[]).includes(role)
      ? "team"
      : "app";

/** The authenticated principal attached to each request. Re-read from the DB on every request. */
export interface AuthUser {
  id: number;
  email: string;
  fullName: string;
  role: PortalRole;
}
