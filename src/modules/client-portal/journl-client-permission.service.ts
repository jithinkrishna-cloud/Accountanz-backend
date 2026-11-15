import * as permRepo from "../journl-permissions/permission.repository.js";
import * as permService from "../journl-permissions/permission.service.js";

export async function catalog() {
  return permService.catalog();
}

export async function team(clientId: number) {
  const assignments = await permRepo.accessAssignments([clientId]);
  return Promise.all(
    assignments.map(async (a) => {
      const p = await permService.assignmentPermissions(a.assignment_id);
      return {
        user_id: a.user_id,
        full_name: a.full_name,
        team_role: a.team_role,
        modules: p.modules.map((m) => ({
          module_key: m.module_key,
          label: m.label,
          client_granted: m.client_grant?.status === "active" && m.client_grant.allowed_actions.length > 0,
          client_actions: m.client_grant?.allowed_actions ?? [],
          effective: m.effective_actions.length > 0,
          reason: m.blocked_reason,
        })),
      };
    }),
  );
}

export async function setModulePermission(clientId: number, assignmentId: number, moduleKey: string, actions: string[]) {
  const a = await permRepo.gates(assignmentId);
  if (!a || a.client_id !== clientId) throw new Error("Assignment not found on this client");
  const actor = { id: a.user_id, email: "", fullName: "", role: "client_owner" as const };
  return permService.setModulePermission(actor, assignmentId, moduleKey, actions, "client");
}
