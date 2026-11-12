import type { TeamRole } from "../assignments/assignment.types.js";

export interface TeamMember {
  assignment_id: number;
  user_id: number;
  full_name: string;
  email: string;
  team_role: TeamRole;
  journl_access: boolean;
  valid_to: string | null;
}

export interface TeamRow {
  client_id: number;
  client_name: string;
  client_status: string;
  team_id: number;
  team_name: string;
  scheduled_count: number;
  members: TeamMember[];
}
