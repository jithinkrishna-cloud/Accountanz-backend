import { isProd } from "../../config/env.js";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { lockAssignment } from "../assignments/assignment.repository.js";
import * as repo from "./permission.repository.js";
import type { AssignmentGates, AssignmentPermissions, Catalog, CatalogModule, ModuleAccess, ModuleGrant } from "./permission.types.js";

/** Unverified catalogue entries are usable outside production only, so nothing unconfirmed reaches real JournL access. */
const ALLOW_UNVERIFIED = !isProd;

const usable = (m: CatalogModule, actionKey: string) => {
  const action = m.actions.find((a) => a.action_key === actionKey);
  return !!action && (ALLOW_UNVERIFIED || (m.verified && action.verified));
};

export async function catalog(): Promise<Catalog> {
  return { allow_unverified: ALLOW_UNVERIFIED, modules: await repo.catalog() };
}

/**
 * The single owner of "what may this assignment do in JournL, as far as Accountanz decides". Effective access is
 * the client's grant (JournL) ∩ these effective actions; JournL enforces the client side.
 */
function moduleAccess(m: CatalogModule, grant: ModuleGrant | null, g: AssignmentGates): ModuleAccess {
  const granted = grant?.status === "active" ? grant.allowed_actions : [];
  const blocked_reason = !granted.length
    ? null
    : m.default_policy === "restricted"
      ? "This module is restricted"
      : !g.assignment_active
        ? "The assignment isn't active today"
        : !g.engagement_active
          ? "The client has no active engagement"
          : !g.journl_access
            ? "JournL access is off for this assignment"
            : granted.some((a) => !usable(m, a))
              ? "Not yet verified against JournL's API"
              : null;
  const gatesOpen = m.default_policy !== "restricted" && g.assignment_active && g.engagement_active && g.journl_access;
  return {
    module_key: m.module_key,
    label: m.label,
    default_policy: m.default_policy,
    verified: m.verified,
    grant,
    effective_actions: gatesOpen ? granted.filter((a) => usable(m, a)) : [],
    blocked_reason,
  };
}

export async function assignmentPermissions(assignmentId: number): Promise<AssignmentPermissions> {
  const g = await repo.gates(assignmentId);
  if (!g) throw AppError.notFound("Assignment");
  const [modules, grants] = await Promise.all([repo.catalog(), repo.grants(assignmentId)]);
  return {
    ...g,
    client_grant: "unknown",
    allow_unverified: ALLOW_UNVERIFIED,
    modules: modules.map((m) => moduleAccess(m, grants.find((x) => x.module_key === m.module_key) ?? null, g)),
  };
}

/** What a staff member's own active assignments on a client allow (usually one assignment). */
export async function myClientPermissions(actor: AuthUser, clientId: number) {
  const ids = await repo.activeAssignmentIds(actor.id, clientId);
  return Promise.all(ids.map(assignmentPermissions));
}

/**
 * Sets the actions an assignment may use in one module; an empty list revokes. Admin-only (admin routes).
 * Actions must exist in the catalogue, restricted modules can't be granted, and in production only verified
 * modules and actions can be granted.
 */
export async function setModulePermission(actor: AuthUser, assignmentId: number, moduleKey: string, actions: string[]) {
  await withTransaction(async (conn) => {
    const a = await lockAssignment(assignmentId, conn);
    if (!a) throw AppError.notFound("Assignment");
    if (a.status === "ended") throw AppError.conflict("An ended assignment's permissions can't be changed");
    const m = (await repo.catalog(conn, moduleKey))[0];
    if (!m) throw AppError.notFound("Module");
    const unique = [...new Set(actions)];
    const unknown = unique.filter((x) => !m.actions.some((y) => y.action_key === x));
    if (unknown.length) {
      throw new AppError("VALIDATION_ERROR", `${m.label} has no action ${unknown.join(", ")}`, { fieldErrors: { actions: ["Choose actions configured for this module"] } });
    }
    if (unique.length && m.default_policy === "restricted") throw AppError.conflict(`${m.label} is restricted and can't be granted`);
    if (unique.some((x) => !usable(m, x))) throw AppError.conflict(`${m.label} isn't verified against JournL yet, so it can't be granted in production`);

    const existing = await repo.lockGrant(assignmentId, moduleKey, conn);
    const before = existing?.status === "active" ? existing.allowed_actions : [];
    if (before.length === unique.length && before.every((x) => unique.includes(x))) return;
    if (unique.length) await repo.upsertGrant(assignmentId, moduleKey, unique, actor.id, conn);
    else await repo.revokeGrant(assignmentId, moduleKey, actor.id, conn);
    await recordAudit(
      actor,
      {
        action: !unique.length ? "JournL module revoked" : before.length ? "JournL module changed" : "JournL module granted",
        entityType: "Assignment",
        entityId: assignmentId,
        clientId: a.client_id,
        details: `${m.label}: ${before.join(", ") || "none"} → ${unique.join(", ") || "none"}${m.verified ? "" : " (mapped, not verified against JournL)"}`,
      },
      conn,
    );
  });
  return assignmentPermissions(assignmentId);
}
