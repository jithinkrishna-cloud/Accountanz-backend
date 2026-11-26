import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { PoolConnection } from "mysql2/promise";
import { canAccessClient, clientScope, requireLinkableClient } from "../access/client-access.js";
import { deleteFile } from "../../utils/file-storage.js";
import { logger } from "../../utils/logger.js";
import { humanize } from "../../utils/format.js";
import { recordAudit } from "../audit/audit.service.js";
import { onEngagementActivated } from "./client-space-hooks.js";
import { syncPrimaryMembers } from "./client-spaces.js";
import { effectiveEntitlement, isPortalAdminRole } from "./entitlement.js";
import { NO_PACKAGE_MESSAGE } from "./limits.service.js";
import { requireSpaceAdmin, spaceRoleFor } from "./project-access.js";
import * as repo from "./project.repository.js";
import type { SpaceContext, SpaceRole, StatusCategory } from "./project.types.js";
import type { AddMembersInput, CreateSpaceInput, StatusInput, UpdateSpaceInput } from "./project.validation.js";

// ── Spaces ──
export const listSpaces = (user: AuthUser, f: { q?: string; client_id?: number; archived?: boolean }) =>
  repo.listSpaces(user.id, user.role === "super_admin" ? "all" : user.role === "ops_admin" ? "members_or_client" : "members", f);

/** Client spaces are discoverable by key (to request access); internal spaces the caller can't see look nonexistent. */
export async function lookupSpace(user: AuthUser, key: string) {
  const row = await repo.findSpaceByKey(user.id, key);
  if (!row) throw AppError.notFound("Space");
  const accessible = spaceRoleFor(user, row.kind, row.my_role) !== null;
  if (row.kind === "internal" && !accessible) throw AppError.notFound("Space");
  return { space_key: row.space_key, name: row.name, kind: row.kind, accessible };
}

export const isKeyAvailable = async (key: string) => ({ key, available: !(await repo.keyTaken(key)) });

export const clientOptions = (user: AuthUser) => repo.clientOptions(clientScope(user, "id"));

const STAFF_CREATE_MESSAGE = "Ask an admin to create client spaces";
const PRIMARY_ARCHIVE_MESSAGE = "The primary client space is archived and restored automatically with the client's engagement";

/** Call under the client lock: throws when the client has no package or no room for another active client space. */
async function requireRoomForClientSpace(clientId: number, conn: PoolConnection) {
  const entitlement = await effectiveEntitlement(clientId, conn);
  if (!entitlement) throw AppError.conflict(NO_PACKAGE_MESSAGE);
  const limit = entitlement.workspaceLimit;
  if (limit !== null && (await repo.countActiveClientSpaces(clientId, conn)) >= limit) {
    throw AppError.conflict(`The ${entitlement.packageName} package allows ${limit} client workspaces. Archive one or ask a Super admin for more room.`);
  }
}

export async function createSpace(actor: AuthUser, input: CreateSpaceInput) {
  const isProject = input.kind === "client_project";
  if (isProject && !isPortalAdminRole(actor.role)) throw AppError.forbidden(STAFF_CREATE_MESSAGE);
  if (!isProject && input.client_id) throw new AppError("VALIDATION_ERROR", "Please check the highlighted fields", { fieldErrors: { client_id: ["Internal spaces can't be linked to a client"] } });
  if (await repo.keyTaken(input.space_key)) throw new AppError("VALIDATION_ERROR", "Please check the highlighted fields", { fieldErrors: { space_key: ["This key is already used by another space"] } });
  if (isProject) {
    if (!input.client_id || !(await repo.clientExists(input.client_id))) throw AppError.notFound("Client");
    await requireLinkableClient(actor, input.client_id);
  }
  const id = await withTransaction(async (conn) => {
    if (isProject) {
      await repo.lockClient(input.client_id!, conn);
      await requireRoomForClientSpace(input.client_id!, conn);
    }
    const spaceId = await repo.insertSpace(input, isProject ? "client_project" : "internal", actor.id, actor.id, conn);
    await recordAudit(actor, { action: "Workspace space created", entityType: "ProjectSpace", entityId: spaceId, clientId: input.client_id ?? null, details: `${input.space_key} · ${input.name}` }, conn);
    return spaceId;
  });
  return (await repo.findSpace(actor.id, id))!;
}

export async function getSpace(user: AuthUser, space: SpaceContext) {
  const row = (await repo.findSpace(user.id, space.id))!;
  return { ...row, my_role: space.role, statuses: await repo.listStatuses(space.id) };
}

export async function updateSpace(actor: AuthUser, space: SpaceContext, input: UpdateSpaceInput) {
  requireSpaceAdmin(space);
  await repo.updateSpace(space.id, input);
  return getSpace(actor, space);
}

/**
 * Permanently deletes a space: every work item, sprint, comment, history entry and attachment file. Space
 * Administrators only (super admins count as Administrator in every space). The caller must type the space key.
 */
export async function deleteSpace(actor: AuthUser, space: SpaceContext, confirmKey: string) {
  if (space.kind === "client_primary") throw AppError.conflict(PRIMARY_ARCHIVE_MESSAGE);
  requireSpaceAdmin(space);
  if (confirmKey.trim().toUpperCase() !== space.key) {
    throw new AppError("VALIDATION_ERROR", "Type the space key to confirm", { fieldErrors: { confirm_key: [`Type ${space.key} to confirm`] } });
  }
  const fileKeys = await withTransaction(async (conn) => {
    const info = await repo.spaceDeletionInfo(space.id, conn);
    await repo.deleteSpaceRows(space.id, conn);
    await recordAudit(
      actor,
      {
        action: "Workspace space deleted",
        entityType: "ProjectSpace",
        entityId: space.id,
        clientId: space.client_id,
        details: `${space.key} · ${space.name}: ${info.items} work items, ${info.sprints} sprints, ${info.comments} comments, ${info.fileKeys.length} attachments`,
      },
      conn,
    );
    return info.fileKeys;
  });
  // Files go after the rows are gone, so a storage hiccup can't leave rows pointing at missing files.
  for (const key of fileKeys) await deleteFile(key).catch((err) => logger.warn({ err, key }, "Could not delete a Workspace attachment file"));
}

async function setSpaceArchived(actor: AuthUser, space: SpaceContext, archived: boolean) {
  if (space.kind === "client_primary") throw AppError.conflict(PRIMARY_ARCHIVE_MESSAGE);
  requireSpaceAdmin(space);
  await withTransaction(async (conn) => {
    if (!archived && space.client_id !== null) {
      await repo.lockClient(space.client_id, conn);
      await requireRoomForClientSpace(space.client_id, conn);
    }
    await repo.setArchived(space.id, archived, conn);
    await recordAudit(actor, { action: archived ? "Workspace space archived" : "Workspace space unarchived", entityType: "ProjectSpace", entityId: space.id, clientId: space.client_id, details: `${space.key} · ${space.name}` }, conn);
  });
  return getSpace(actor, { ...space, archived_at: archived ? new Date().toISOString() : null });
}

export const archiveSpace = (actor: AuthUser, space: SpaceContext) => setSpaceArchived(actor, space, true);
export const unarchiveSpace = (actor: AuthUser, space: SpaceContext) => setSpaceArchived(actor, space, false);

// ── Client spaces ──
function requirePortalAdmin(actor: AuthUser) {
  if (!isPortalAdminRole(actor.role)) throw AppError.forbidden("Only admins can do this");
}

/** A client's primary space, package usage and what the caller may do next. */
export async function clientSpaceOverview(user: AuthUser, clientId: number) {
  if (!(await repo.clientExists(clientId)) || !(await canAccessClient(user, clientId))) throw AppError.notFound("Client");
  const [primaryRef, entitlement] = await Promise.all([repo.findPrimarySpace(clientId), effectiveEntitlement(clientId)]);
  const row = primaryRef ? await repo.findSpace(user.id, primaryRef.id) : null;
  const used = await repo.countActiveClientSpaces(clientId);
  const admin = isPortalAdminRole(user.role);
  return {
    primary: row ? { space_key: row.space_key, name: row.name, accessible: spaceRoleFor(user, row.kind, row.my_role) !== null, archived: row.archived_at !== null } : null,
    usage: entitlement ? { used, limit: entitlement.workspaceLimit, package_name: entitlement.packageName } : null,
    can_create_project: admin && !!entitlement && (entitlement.workspaceLimit === null || used < entitlement.workspaceLimit),
    can_provision_primary: admin && !!entitlement && !row,
  };
}

/** Admin repair: creates (or returns) the client's primary space, same path as engagement activation. */
export async function provisionPrimary(actor: AuthUser, clientId: number) {
  requirePortalAdmin(actor);
  if (!(await repo.clientExists(clientId))) throw AppError.notFound("Client");
  if (!(await effectiveEntitlement(clientId))) throw AppError.conflict(NO_PACKAGE_MESSAGE);
  await withTransaction(async (conn) => {
    await repo.lockClient(clientId, conn);
    await onEngagementActivated(actor, clientId, conn);
  });
  const primary = await repo.findPrimarySpace(clientId);
  if (!primary) throw AppError.conflict("The client space could not be created. Check the audit log for details.");
  return (await repo.findSpace(actor.id, primary.id))!;
}

export async function syncSpace(actor: AuthUser, space: SpaceContext) {
  requirePortalAdmin(actor);
  if (space.kind !== "client_primary" || space.client_id === null) throw AppError.conflict("Only a client's primary space syncs with its team");
  const clientId = space.client_id;
  const r = await withTransaction((conn) => syncPrimaryMembers(actor, clientId, conn));
  return { added: r.added, removed: r.removed, issues: r.issues };
}

export async function listSyncIssues(actor: AuthUser, space: SpaceContext) {
  requirePortalAdmin(actor);
  return { items: await repo.listSyncIssues(space.id) };
}

// ── Statuses ──
export const listStatuses = (space: SpaceContext) => repo.listStatuses(space.id);

export async function createStatus(space: SpaceContext, input: StatusInput) {
  requireSpaceAdmin(space);
  if (await repo.statusNameTaken(space.id, input.name)) throw AppError.conflict(`A status called "${input.name}" already exists`);
  await repo.insertStatus(space.id, input.name, input.category);
  return repo.listStatuses(space.id);
}

export async function updateStatus(space: SpaceContext, id: number, patch: { name?: string; category?: StatusCategory }) {
  requireSpaceAdmin(space);
  await withTransaction(async (conn) => {
    const status = await repo.findStatus(space.id, id, conn);
    if (!status) throw AppError.notFound("Status");
    if (patch.name && (await repo.statusNameTaken(space.id, patch.name, id))) throw AppError.conflict(`A status called "${patch.name}" already exists`);
    if (patch.category && patch.category !== "done" && status.category === "done" && (await repo.countDoneStatuses(space.id, conn)) <= 1) {
      throw AppError.conflict("A space needs at least one Done-type status");
    }
    await repo.updateStatus(space.id, id, patch, conn);
    if (patch.category && patch.category !== status.category) await repo.syncResolvedForStatus(id, patch.category, conn);
  });
  return repo.listStatuses(space.id);
}

export async function deleteStatus(space: SpaceContext, id: number, moveTo: number) {
  requireSpaceAdmin(space);
  await withTransaction(async (conn) => {
    const status = await repo.findStatus(space.id, id, conn);
    const target = await repo.findStatus(space.id, moveTo, conn);
    if (!status) throw AppError.notFound("Status");
    if (!target || target.id === id) throw AppError.conflict("Pick another status to move its items to");
    if (status.category === "done" && (await repo.countDoneStatuses(space.id, conn)) <= 1) throw AppError.conflict("A space needs at least one Done-type status");
    await repo.moveItemsToStatus(id, target.id, conn);
    await repo.syncResolvedForStatus(target.id, target.category, conn);
    await repo.deleteStatus(id, conn);
  });
  return repo.listStatuses(space.id);
}

export async function reorderStatuses(space: SpaceContext, ids: number[]) {
  requireSpaceAdmin(space);
  const current = await repo.listStatuses(space.id);
  if (ids.length !== current.length || !current.every((s) => ids.includes(s.id))) throw AppError.conflict("Send every status of the space exactly once");
  await withTransaction((conn) => repo.reorderStatuses(space.id, ids, conn));
  return repo.listStatuses(space.id);
}

// ── Members ──
export const listMembers = (space: SpaceContext) => repo.listMembers(space.id);
export const searchStaff = (space: SpaceContext, q?: string) => repo.searchStaff(space.id, q);

const roleLabel = (role: string) => (role === "cfo" ? "CFO" : humanize(role));

/** Package rules for adding staff to a client space. Call inside the transaction; locks the client row first. */
async function enforceMemberLimits(spaceId: number, clientId: number, staff: { id: number; portal_role: string }[], conn: PoolConnection) {
  await repo.lockClient(clientId, conn);
  const nonAdmins = staff.filter((s) => !isPortalAdminRole(s.portal_role));
  if (!nonAdmins.length) return;
  const entitlement = await effectiveEntitlement(clientId, conn);
  if (!entitlement) throw AppError.conflict(NO_PACKAGE_MESSAGE);
  const ineligible = nonAdmins.find((s) => !entitlement.teamRoles.includes(s.portal_role));
  if (ineligible) throw AppError.conflict(`${roleLabel(ineligible.portal_role)} isn't included in the ${entitlement.packageName} package`);
  if (entitlement.staffPerWorkspace === null) return;
  let added = 0;
  for (const s of nonAdmins) if (!(await repo.findMember(spaceId, s.id, conn))) added++;
  if (added && (await repo.countStaffSeats(spaceId, conn)) + added > entitlement.staffPerWorkspace) {
    throw AppError.conflict(`The ${entitlement.packageName} package allows ${entitlement.staffPerWorkspace} staff per workspace`);
  }
}

export async function addMembers(actor: AuthUser, space: SpaceContext, input: AddMembersInput) {
  requireSpaceAdmin(space);
  const ids = [...new Set(input.user_ids)];
  const staff = await repo.activeStaff(ids);
  if (staff.length !== ids.length) throw AppError.conflict("Only active Accountanz staff can be added to a space");
  await withTransaction(async (conn) => {
    if (space.client_id !== null) await enforceMemberLimits(space.id, space.client_id, staff, conn);
    for (const s of staff) await repo.addMember(space.id, s.id, input.role, actor.id, conn, "manual");
    await recordAudit(actor, { action: "Workspace members added", entityType: "ProjectSpace", entityId: space.id, clientId: space.client_id, details: `${space.key}: ${staff.map((s) => s.full_name).join(", ")} as ${input.role}` }, conn);
  });
  return repo.listMembers(space.id);
}

export async function changeMemberRole(actor: AuthUser, space: SpaceContext, userId: number, role: SpaceRole) {
  requireSpaceAdmin(space);
  await withTransaction(async (conn) => {
    const member = await repo.findMember(space.id, userId, conn);
    if (!member) throw AppError.notFound("Member");
    if (member.role === role) return;
    if (member.role === "admin" && (await repo.countAdmins(space.id, conn)) <= 1) throw AppError.conflict("A space needs at least one Administrator");
    await repo.setMemberRole(space.id, userId, role, conn);
    await recordAudit(actor, { action: "Workspace member role changed", entityType: "ProjectSpace", entityId: space.id, clientId: space.client_id, details: `${space.key}: ${member.full_name} → ${role}` }, conn);
  });
  return repo.listMembers(space.id);
}

export async function removeMember(actor: AuthUser, space: SpaceContext, userId: number) {
  requireSpaceAdmin(space);
  await withTransaction(async (conn) => {
    const member = await repo.findMember(space.id, userId, conn);
    if (!member) throw AppError.notFound("Member");
    if (member.role === "admin" && (await repo.countAdmins(space.id, conn)) <= 1) throw AppError.conflict("A space needs at least one Administrator");
    await repo.removeMember(space.id, userId, conn);
    await recordAudit(actor, { action: "Workspace member removed", entityType: "ProjectSpace", entityId: space.id, clientId: space.client_id, details: `${space.key}: ${member.full_name}` }, conn);
  });
  return repo.listMembers(space.id);
}

export const getSummary = (space: SpaceContext, assigneeId?: number) => repo.summary(space.id, assigneeId);
