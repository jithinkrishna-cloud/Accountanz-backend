import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { requireSpaceAdmin } from "./project-access.js";
import * as repo from "./project.repository.js";
import type { SpaceContext, SpaceRole, StatusCategory } from "./project.types.js";
import type { AddMembersInput, CreateSpaceInput, StatusInput, UpdateSpaceInput } from "./project.validation.js";

// ── Spaces ──
export const listSpaces = (user: AuthUser, f: { q?: string; client_id?: number }) => repo.listSpaces(user.id, user.role === "super_admin", f);

export const isKeyAvailable = async (key: string) => ({ key, available: !(await repo.keyTaken(key)) });

export const clientOptions = () => repo.clientOptions();

export async function createSpace(actor: AuthUser, input: CreateSpaceInput) {
  if (await repo.keyTaken(input.space_key)) throw new AppError("VALIDATION_ERROR", "Please check the highlighted fields", { fieldErrors: { space_key: ["This key is already used by another space"] } });
  if (input.client_id && !(await repo.clientExists(input.client_id))) throw AppError.notFound("Client");
  const id = await withTransaction(async (conn) => {
    const spaceId = await repo.insertSpace(input, actor.id, conn);
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
  if (input.client_id && !(await repo.clientExists(input.client_id))) throw AppError.notFound("Client");
  await repo.updateSpace(space.id, input);
  return getSpace(actor, space);
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

export async function addMembers(actor: AuthUser, space: SpaceContext, input: AddMembersInput) {
  requireSpaceAdmin(space);
  const ids = [...new Set(input.user_ids)];
  const staff = await repo.activeStaff(ids);
  if (staff.length !== ids.length) throw AppError.conflict("Only active Accountanz staff can be added to a space");
  await withTransaction(async (conn) => {
    for (const s of staff) await repo.addMember(space.id, s.id, input.role, actor.id, conn);
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
