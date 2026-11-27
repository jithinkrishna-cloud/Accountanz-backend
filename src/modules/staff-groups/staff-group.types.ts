import type { TeamRole } from "../assignments/assignment.types.js";

export interface StaffGroupMember {
  user_id: number;
  full_name: string;
  email: string;
  team_role: TeamRole;
  /** False when the person is no longer an active, verified accountant: they're skipped when the group is assigned. */
  assignable: boolean;
}

export interface StaffGroupRow {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  members: StaffGroupMember[];
  /** Clients that still have at least one active assignment made from this group. */
  clients: { id: number; name: string }[];
}

export interface AssignGroupResult {
  client_id: number;
  client_name: string;
  created: { assignment_id: number; full_name: string; team_role: TeamRole }[];
  /** Members not assigned, with the reason (already on the client, not verified…). */
  skipped: { full_name: string; team_role: TeamRole; reason: string }[];
}
