import type { PortalRole } from "../../types/auth.types.js";

export type UserStatus = "invited" | "active" | "disabled";

export interface UserRow {
  id: number;
  email: string;
  password_hash: string | null;
  full_name: string;
  phone: string | null;
  portal_role: PortalRole;
  status: UserStatus;
  last_login_at: string | null;
  created_at: string;
}

/** Shape returned to the frontend. Never includes the password hash. */
export interface PublicUser {
  id: number;
  email: string;
  fullName: string;
  role: PortalRole;
  portal: "admin" | "team" | "app";
}
