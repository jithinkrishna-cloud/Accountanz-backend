import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { activeTeamRoles, REVIEWER_TEAM_ROLES } from "../access/client-access.js";
import { findClientById } from "../clients/client.repository.js";
import { JOURNL_FEATURE_LIST } from "../integrations/journl-features.js";
import { myClientPermissions } from "../journl-permissions/permission.service.js";
import type { CorrectionKind } from "./correction.types.js";

/** The JournL feature a correction touches (the permission module it needs "correct" on). */
export function featureFor(kind: CorrectionKind, ledgerKind: "general" | "customer" | "supplier"): string {
  if (kind === "journal_entry") return "f_journal";
  return ledgerKind === "customer" ? "f_customers" : ledgerKind === "supplier" ? "f_suppliers" : "f_general_ledgers";
}

const featureName = (key: string) => JOURNL_FEATURE_LIST.find((f) => f.key === key)?.name ?? key;

/**
 * Preparing a correction is a team-member action: the actor's own active assignment on this client must have
 * "correct" effectively granted (Accountanz grant ∩ client grant). Admins do not prepare in this release.
 */
export async function requirePrepare(actor: AuthUser, clientId: number, feature: string): Promise<void> {
  const denied = () =>
    new AppError("FORBIDDEN", `You don't have Correct access for ${featureName(feature)} on this client. It needs both Accountanz's grant and the client's.`);
  if (actor.role === "super_admin" || actor.role === "ops_admin") throw denied();
  const assignments = await myClientPermissions(actor, clientId);
  const ok = assignments.some((a) => a.modules.some((m) => m.module_key === feature && m.effective_actions.includes("correct")));
  if (!ok) throw denied();
}

/**
 * Approvers: super_admin, or a finance manager / reviewer / CFO on THIS client today. Never ops_admin, and never
 * the initiator (checked separately in requireApprove, regardless of roles held).
 */
export async function canApprove(actor: AuthUser, clientId: number, initiatedBy: number): Promise<boolean> {
  if (actor.id === initiatedBy) return false;
  if (!(await findClientById(clientId))) return false;
  if (actor.role === "super_admin") return true;
  if (actor.role === "ops_admin") return false;
  const roles = await activeTeamRoles(actor.id, clientId);
  return roles.some((r) => (REVIEWER_TEAM_ROLES as readonly string[]).includes(r));
}

export async function requireApprove(actor: AuthUser, clientId: number, initiatedBy: number): Promise<void> {
  if (actor.id === initiatedBy) throw new AppError("FORBIDDEN", "You can't approve your own correction");
  if (!(await canApprove(actor, clientId, initiatedBy))) {
    throw new AppError("FORBIDDEN", "Only a finance manager, reviewer or CFO on this client, or a super admin, can approve");
  }
}
