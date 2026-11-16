import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { ClientContext } from "./client-portal.types.js";
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
        // Grants are per assignment (one person can hold two roles on a company), so the client UI must send this, not user_id.
        assignment_id: a.assignment_id,
        user_id: a.user_id,
        full_name: a.full_name,
        team_role: a.team_role,
        modules: p.modules.map((m) => ({
          module_key: m.module_key,
          label: m.label,
          client_granted: m.client_grant?.status === "active" && m.client_grant.allowed_actions.length > 0,
          // A revoked grant keeps its last allowed_actions for the audit trail; it grants nothing.
          client_actions: m.client_grant?.status === "active" ? m.client_grant.allowed_actions : [],
          effective: m.effective_actions.length > 0,
          reason: m.blocked_reason,
        })),
      };
    }),
  );
}

/** The company owner sets the client side of an accountant's JournL module grant (the ceiling on what they may use). */
export async function setModulePermission(actor: AuthUser, ctx: ClientContext, assignmentId: number, moduleKey: string, actions: string[]) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can change JournL access");
  const a = await permRepo.gates(assignmentId);
  // Same answer whether the assignment doesn't exist or belongs to another company, so ids can't be probed.
  if (!a || a.client_id !== ctx.clientId) throw AppError.notFound("Assignment");
  return permService.setModulePermission(actor, assignmentId, moduleKey, actions, "client");
}
