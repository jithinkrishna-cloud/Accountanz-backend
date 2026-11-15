export interface ClientModulePermission {
  module_key: string;
  label: string;
  client_granted: boolean;
  client_actions: string[];
  effective: boolean;
  reason: string | null;
}

export interface ClientAssignmentPermission {
  user_id: number;
  full_name: string;
  email: string;
  team_role: string;
  modules: ClientModulePermission[];
}
