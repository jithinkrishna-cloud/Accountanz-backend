import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { effectiveEntitlement, type Limit } from "./entitlement.js";
import * as repo from "./project.repository.js";
import type { SpaceContext } from "./project.types.js";
import type { GrantOverrideInput } from "./project.validation.js";

export const NO_PACKAGE_MESSAGE = "This client has no active package";

const show = (l: Limit) => (l === null ? "Unlimited" : String(l));

/** Package limits, live overrides, effective values and usage for a client space; null for internal spaces. */
export async function getLimits(space: SpaceContext) {
  if (space.client_id === null) return null;
  const [entitlement, overrides, workspaces, staff] = await Promise.all([
    effectiveEntitlement(space.client_id),
    repo.listActiveOverrides(space.client_id),
    repo.countActiveClientSpaces(space.client_id),
    repo.countStaffSeats(space.id),
  ]);
  return {
    package_name: entitlement?.packageName ?? null,
    base: entitlement?.base ?? null,
    overrides,
    effective: entitlement ? { workspaces: entitlement.workspaceLimit, staff: entitlement.staffPerWorkspace } : null,
    usage: { workspaces, staff },
  };
}

function requireSuperAdmin(actor: AuthUser) {
  if (actor.role !== "super_admin") throw AppError.forbidden("Only a Super admin can change entitlement overrides");
}

function clientOf(space: SpaceContext): number {
  if (space.client_id === null) throw AppError.conflict("Internal spaces have no package limits");
  return space.client_id;
}

const effectiveFor = (limitType: "workspaces" | "staff_per_workspace", e: NonNullable<Awaited<ReturnType<typeof effectiveEntitlement>>>) =>
  limitType === "workspaces" ? e.workspaceLimit : e.staffPerWorkspace;

export async function grantOverride(actor: AuthUser, space: SpaceContext, input: GrantOverrideInput) {
  requireSuperAdmin(actor);
  const clientId = clientOf(space);
  const expiresAt = input.expires_at ?? null;
  await withTransaction(async (conn) => {
    const before = await effectiveEntitlement(clientId, conn);
    if (!before) throw AppError.conflict(NO_PACKAGE_MESSAGE);
    const id = await repo.insertOverride({ clientId, limitType: input.limit_type, extra: input.extra, reason: input.reason, expiresAt, createdBy: actor.id }, conn);
    const after = (await effectiveEntitlement(clientId, conn))!;
    await recordAudit(
      actor,
      {
        action: "Workspace entitlement override granted",
        entityType: "ClientEntitlementOverride",
        entityId: id,
        clientId,
        details: `${input.limit_type} +${input.extra}: effective before ${show(effectiveFor(input.limit_type, before))} → after ${show(effectiveFor(input.limit_type, after))}; reason: ${input.reason}; expires: ${expiresAt ?? "never"}`,
      },
      conn,
    );
  });
  return getLimits(space);
}

export async function revokeOverride(actor: AuthUser, space: SpaceContext, id: number) {
  requireSuperAdmin(actor);
  const clientId = clientOf(space);
  await withTransaction(async (conn) => {
    const row = await repo.findActiveOverride(clientId, id, conn);
    if (!row) throw AppError.notFound("Override");
    const before = await effectiveEntitlement(clientId, conn);
    await repo.revokeOverrideRow(id, actor.id, conn);
    const after = await effectiveEntitlement(clientId, conn);
    await recordAudit(
      actor,
      {
        action: "Workspace entitlement override revoked",
        entityType: "ClientEntitlementOverride",
        entityId: id,
        clientId,
        details: `${row.limit_type} +${row.extra}: effective before ${before ? show(effectiveFor(row.limit_type, before)) : "none"} → after ${after ? show(effectiveFor(row.limit_type, after)) : "none"}; reason: ${row.reason}; expires: ${row.expires_at ?? "never"}`,
      },
      conn,
    );
  });
  return getLimits(space);
}
