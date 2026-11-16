import { isProd } from "../../config/env.js";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { lockAssignment } from "../assignments/assignment.repository.js";
import * as repo from "./permission.repository.js";
import type { AssignmentGates, AssignmentPermissions, Catalog, CatalogModule, GrantSource, ModuleAccess, ModuleGrant } from "./permission.types.js";

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
 * the accountanz grant ∩ the client's grant (JournL enforces the client side).
 */
function moduleAccess(m: CatalogModule, accountanzGrant: ModuleGrant | null, clientGrant: ModuleGrant | null, g: AssignmentGates): ModuleAccess {
  const accountanzActions = accountanzGrant?.status === "active" ? accountanzGrant.allowed_actions : [];
  const clientActions = clientGrant?.status === "active" ? clientGrant.allowed_actions : [];
  // Effective = accountanz's allowance ∩ client's allowance
  const granted = accountanzActions.filter((a) => clientActions.includes(a));
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
    grant: accountanzGrant ?? clientGrant ?? null,
    client_grant: clientGrant,
    effective_actions: gatesOpen ? granted.filter((a) => usable(m, a)) : [],
    accountanz_actions: accountanzActions,
    blocked_reason,
  };
}

export async function assignmentPermissions(assignmentId: number): Promise<AssignmentPermissions> {
  const g = await repo.gates(assignmentId);
  if (!g) throw AppError.notFound("Assignment");
  const [modules, grants] = await Promise.all([repo.catalog(), repo.grants(assignmentId)]);
  const bySource = (src: GrantSource) => grants.filter((x) => x.grant_source === src);
  const accountanzByKey = new Map(bySource("accountanz").map((x) => [x.module_key, x]));
  const clientByKey = new Map(bySource("client").map((x) => [x.module_key, x]));
  return {
    ...g,
    client_grant: "unknown",
    allow_unverified: ALLOW_UNVERIFIED,
    modules: modules.map((m) =>
      moduleAccess(m, accountanzByKey.get(m.module_key) ?? null, clientByKey.get(m.module_key) ?? null, g),
    ),
  };
}

/** What a staff member's own active assignments on a client allow (usually one assignment). */
export async function myClientPermissions(actor: AuthUser, clientId: number) {
  const ids = await repo.activeAssignmentIds(actor.id, clientId);
  return Promise.all(ids.map(assignmentPermissions));
}

/**
 * Sets the actions an assignment may use in one module for a given grant source; an empty list revokes.
 * Actions must exist in the catalogue, restricted modules can't be granted, and in production only verified
 * modules and actions can be granted.
 */
export async function setModulePermission(actor: AuthUser, assignmentId: number, moduleKey: string, actions: string[], grantSource: GrantSource = "accountanz") {
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

    const existing = await repo.lockGrant(assignmentId, moduleKey, grantSource, conn);
    const before = existing?.status === "active" ? existing.allowed_actions : [];
    if (before.length === unique.length && before.every((x) => unique.includes(x))) return;
    if (unique.length) await repo.upsertGrant(assignmentId, moduleKey, grantSource, unique, actor.id, conn);
    else await repo.revokeGrant(assignmentId, moduleKey, grantSource, actor.id, conn);
    await recordAudit(
      actor,
      {
        action: !unique.length ? "JournL module revoked" : before.length ? "JournL module changed" : "JournL module granted",
        entityType: "Assignment",
        entityId: assignmentId,
        clientId: a.client_id,
        details: `${m.label} [${grantSource}]: ${before.join(", ") || "none"} → ${unique.join(", ") || "none"}${m.verified ? "" : " (mapped, not verified against JournL)"}`,
      },
      conn,
    );
  });
  return assignmentPermissions(assignmentId);
}

/**
 * Admin overview of JournL access: per client, the connection and session, and for each person assigned today
 * the gates and which modules they can actually read. One place to see who can open what in JournL.
 */
export async function accessOverview() {
  const [clients, catalogModules] = await Promise.all([repo.accessClients(), repo.catalog()]);
  const assignments = await repo.accessAssignments(clients.map((c) => c.client_id));
  const perms = await Promise.all(assignments.map((a) => assignmentPermissions(a.assignment_id)));
  // One column per area (Sales, Purchases, ...): with a permission per JournL feature, a column per feature is unreadable.
  const grantable = catalogModules.filter((m) => m.default_policy !== "restricted");
  const areas = [...new Map(grantable.map((m) => [m.group_key, m.group_label])).entries()].map(([key, label]) => ({
    key,
    label,
    features: grantable.filter((m) => m.group_key === key).map((m) => ({ id: Number(m.journl_module_id), name: m.label, known: true })),
  }));
  const byArea = (mods: ModuleAccess[]) =>
    Object.fromEntries(
      areas.map((area) => {
        const inArea = mods.filter((m) => m.default_policy !== "restricted" && catalogModules.find((c) => c.module_key === m.module_key)?.group_key === area.key);
        const granted = inArea.filter((m) => m.grant?.status === "active" && m.grant.allowed_actions.length > 0);
        return [
          area.key,
          {
            granted: granted.length > 0,
            effective: inArea.some((m) => m.effective_actions.length > 0),
            reason: granted.find((m) => m.blocked_reason)?.blocked_reason ?? null,
            granted_count: granted.length,
            total: inArea.length,
          },
        ];
      }),
    );
  return {
    modules: areas.map((a) => ({ ...a, journl_features: null })),
    clients: clients.map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      client_status: c.client_status,
      engagement_active: !!c.engagement_active,
      connection: c.connection_status ? { status: c.connection_status, org_id: c.org_id, org_name: c.org_name, session_until: c.session_until, verification_note: c.verification_note } : null,
      people: assignments
        .map((a, i) => ({ a, p: perms[i]! }))
        .filter(({ a }) => a.client_id === c.client_id)
        .map(({ a, p }) => ({
          assignment_id: a.assignment_id,
          user_id: a.user_id,
          full_name: a.full_name,
          team_role: a.team_role,
          journl_access: p.journl_access,
          modules: byArea(p.modules),
        })),
    })),
  };
}
