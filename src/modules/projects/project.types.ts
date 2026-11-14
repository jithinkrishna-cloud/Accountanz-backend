import { ACCOUNTANT_ROLES, ADMIN_ROLES } from "../../types/auth.types.js";

/** Staff who can enter the Workspace (clients never can). */
export const WORKSPACE_ROLES = [...ADMIN_ROLES, ...ACCOUNTANT_ROLES] as const;

export const TEMPLATES = ["scrum", "kanban"] as const;
export type Template = (typeof TEMPLATES)[number];
export const SPACE_ROLES = ["admin", "member"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];
export const STATUS_CATEGORIES = ["todo", "in_progress", "done"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const DEFAULT_STATUSES: { name: string; category: StatusCategory }[] = [
  { name: "To Do", category: "todo" },
  { name: "In Progress", category: "in_progress" },
  { name: "In Review", category: "in_progress" },
  { name: "Done", category: "done" },
];

/** The space a request works in, resolved once from the URL key and the user's membership. */
export interface SpaceContext {
  id: number;
  key: string;
  name: string;
  template: Template;
  client_id: number | null;
  /** Super admins act as Administrator in every space. */
  role: SpaceRole;
}

export interface SpaceRow {
  id: number;
  space_key: string;
  name: string;
  description: string | null;
  template: Template;
  client_id: number | null;
  client_name: string | null;
  created_at: string;
  item_count: number;
  member_count: number;
  admins: string | null;
  my_role: SpaceRole | null;
}

export interface StatusRow {
  id: number;
  name: string;
  category: StatusCategory;
  position: number;
  item_count: number;
}

export interface MemberRow {
  user_id: number;
  full_name: string;
  email: string;
  portal_role: string;
  role: SpaceRole;
  added_at: string;
}
