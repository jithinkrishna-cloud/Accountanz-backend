import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { ClientContext } from "./client-portal.types.js";
import { query } from "../../database/connection.js";
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
          // Accountanz's key: access needs both sides (shown so the owner can see why something isn't in effect).
          accountanz_actions: m.accountanz_actions,
          effective: m.effective_actions.length > 0,
          reason: m.blocked_reason,
        })),
      };
    }),
  );
}

interface ActivityRow {
  id: number;
  actor_id: number | null;
  actor_name: string | null;
  action: string;
  details: string | null;
  at: number;
}

/**
 * Recent JournL access changes for one accountant on this company, from the audit log: who allowed or removed
 * which feature, on whose side. Readable by owners and members (members see the access screen read-only).
 */
export async function activity(actor: AuthUser, ctx: ClientContext, assignmentId: number) {
  const a = await permRepo.gates(assignmentId);
  if (!a || a.client_id !== ctx.clientId) throw AppError.notFound("Assignment");
  // UNIX_TIMESTAMP reads created_at in the server's own zone, so the epoch is right whatever zone it was written in.
  const rows = await query<ActivityRow>(
    `SELECT l.id, l.actor_id, u.full_name AS actor_name, l.action, l.details, UNIX_TIMESTAMP(l.created_at) * 1000 AS at
       FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.client_id = ? AND l.entity_type = 'Assignment' AND l.entity_id = ? AND l.action LIKE 'JournL module%'
      ORDER BY l.id DESC LIMIT 20`,
    [ctx.clientId, String(assignmentId)],
  );
  // details: "<feature> [<source>]: <before> → <after>" (see permission.service setModulePermission)
  return rows.map((r) => {
    const m = /^(.*) \[(accountanz|client)\]: (.*) → (.*?)(?: \(.*\))?$/.exec(r.details ?? "");
    const after = m?.[4] ?? "";
    return {
      id: r.id,
      at: Number(r.at),
      actor: r.actor_id === actor.id ? "You" : (r.actor_name ?? "Someone"),
      side: (m?.[2] ?? "accountanz") as "accountanz" | "client",
      feature: m?.[1] ?? r.details ?? "",
      change: after === "none" ? ("removed" as const) : ("allowed" as const),
    };
  });
}

/** The company owner sets the client side of an accountant's JournL module grant (the ceiling on what they may use). */
export async function setModulePermission(actor: AuthUser, ctx: ClientContext, assignmentId: number, moduleKey: string, actions: string[]) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can change JournL access");
  const a = await permRepo.gates(assignmentId);
  // Same answer whether the assignment doesn't exist or belongs to another company, so ids can't be probed.
  if (!a || a.client_id !== ctx.clientId) throw AppError.notFound("Assignment");
  return permService.setModulePermission(actor, assignmentId, moduleKey, actions, "client");
}
