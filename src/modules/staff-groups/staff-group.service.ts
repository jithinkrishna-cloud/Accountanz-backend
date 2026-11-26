import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { humanize } from "../../utils/format.js";
import { recordAudit } from "../audit/audit.service.js";
import * as journlAccess from "../journl-access-tasks/journl-access-task.service.js";
import * as assignmentRepo from "../assignments/assignment.repository.js";
import { findClientById } from "../clients/client.repository.js";
import { onClientTeamChanged } from "../projects/client-space-hooks.js";
import * as repo from "./staff-group.repository.js";
import type { AssignGroupResult } from "./staff-group.types.js";
import type { AssignGroupInput, StaffGroupInput } from "./staff-group.validation.js";

/**
 * A staff group is a reusable list of people and roles. Assigning it to a client creates one ordinary
 * assignment per member, so access, ending and hand-over keep working per person and per client.
 * Editing or deleting a group never changes assignments already made from it.
 */
const fieldError = (field: string, message: string) => new AppError("VALIDATION_ERROR", message, { fieldErrors: { [field]: [message] } });

export const listGroups = () => repo.listGroups();

export async function getGroup(id: number) {
  const g = await repo.findGroup(id);
  if (!g) throw AppError.notFound("Group");
  return g;
}

async function checkInput(input: StaffGroupInput, exceptId: number) {
  if (await repo.findByName(input.name, exceptId)) throw fieldError("name", "Another group already has this name");
  const ids = [...new Set(input.members.map((m) => m.user_id))];
  const found = await repo.findAccountants(ids);
  if (found.length !== ids.length) throw fieldError("members", "Only active accountants can be in a group");
}

const memberCount = (input: StaffGroupInput) => (input.members.length === 1 ? "1 member" : `${input.members.length} members`);

export async function createGroup(actor: AuthUser, input: StaffGroupInput) {
  await checkInput(input, 0);
  const id = await withTransaction(async (conn) => {
    const groupId = await repo.insertGroup(input, actor.id, conn);
    await repo.replaceMembers(groupId, input.members, conn);
    await recordAudit(actor, { action: "Staff group created", entityType: "StaffGroup", entityId: groupId, details: `${input.name}, ${memberCount(input)}` }, conn);
    return groupId;
  });
  return getGroup(id);
}

export async function updateGroup(actor: AuthUser, id: number, input: StaffGroupInput) {
  await checkInput(input, id);
  await withTransaction(async (conn) => {
    const g = await repo.lockGroup(id, conn);
    if (!g) throw AppError.notFound("Group");
    await repo.updateGroup(id, input, conn);
    await repo.replaceMembers(id, input.members, conn);
    const name = g.name === input.name ? input.name : `${g.name} → ${input.name}`;
    await recordAudit(actor, { action: "Staff group updated", entityType: "StaffGroup", entityId: id, details: `${name}, ${memberCount(input)}` }, conn);
  });
  return getGroup(id);
}

export async function deleteGroup(actor: AuthUser, id: number) {
  await withTransaction(async (conn) => {
    const g = await repo.lockGroup(id, conn);
    if (!g) throw AppError.notFound("Group");
    await repo.deleteGroup(id, conn);
    await recordAudit(actor, { action: "Staff group deleted", entityType: "StaffGroup", entityId: id, details: `${g.name} (its assignments stay)` }, conn);
  });
}

/**
 * Takes someone who was disabled or rejected out of every group, inside the caller's transaction, so groups
 * only list people who can still be assigned. One audit entry per group left.
 */
export async function removeFromAllGroups(actor: AuthUser, userId: number, reason: string, conn: PoolConnection) {
  const left = await repo.removeUserFromAllGroups(userId, conn);
  for (const g of left) {
    await recordAudit(actor, { action: "Staff group member removed", entityType: "StaffGroup", entityId: g.id, details: `${g.name}: ${reason}` }, conn);
  }
  return left.length;
}

/**
 * Creates an assignment on the client for every member, in one transaction. Members who already hold that
 * role on the client, or who can't be assigned (inactive, not verified), are skipped and reported.
 */
export async function assignGroup(actor: AuthUser, id: number, input: AssignGroupInput): Promise<AssignGroupResult> {
  const client = await findClientById(input.client_id);
  if (!client) throw fieldError("client_id", "Choose a client");
  if (client.status === "exited") throw fieldError("client_id", "This client has exited");
  const clientName = client.trade_name ?? client.legal_name;

  return withTransaction(async (conn) => {
    if (!(await repo.lockGroup(id, conn))) throw AppError.notFound("Group");
    const group = await repo.findGroup(id, conn);
    if (!group?.members.length) throw AppError.conflict("This group has no members");

    const result: AssignGroupResult = { client_id: client.id, client_name: clientName, created: [], skipped: [] };
    for (const m of group.members) {
      const role = humanize(m.team_role).toLowerCase();
      if (!m.assignable) {
        result.skipped.push({ full_name: m.full_name, team_role: m.team_role, reason: "not an active, verified accountant" });
        continue;
      }
      if (await assignmentRepo.findActiveDuplicate({ client_id: client.id, user_id: m.user_id, team_role: m.team_role }, 0, conn)) {
        result.skipped.push({ full_name: m.full_name, team_role: m.team_role, reason: `already ${role} on this client` });
        continue;
      }
      const assignmentId = await assignmentRepo.insertAssignment(
        { client_id: client.id, user_id: m.user_id, team_role: m.team_role, valid_from: input.valid_from, valid_to: input.valid_to, journl_access: m.journl_access },
        conn,
        id,
      );
      await recordAudit(
        actor,
        {
          action: "Assignment created",
          entityType: "Assignment",
          entityId: assignmentId,
          clientId: client.id,
          details: `${m.full_name} as ${role}, ${input.valid_from} to ${input.valid_to ?? "open"}${m.journl_access ? ", JournL access" : ""}; from group ${group.name}`,
        },
        conn,
      );
      await journlAccess.onAssignmentCreated(actor, { id: assignmentId, client_id: client.id, user_id: m.user_id }, m.journl_access, conn);
      result.created.push({ assignment_id: assignmentId, full_name: m.full_name, team_role: m.team_role });
    }
    if (!result.created.length) {
      throw AppError.conflict(`Nobody was assigned. ${result.skipped.map((s) => `${s.full_name} is ${s.reason}`).join("; ")}.`);
    }
    await onClientTeamChanged(actor, client.id, conn);
    await recordAudit(
      actor,
      { action: "Staff group assigned", entityType: "StaffGroup", entityId: id, clientId: client.id, details: `${group.name} → ${clientName}: ${result.created.length} assigned, ${result.skipped.length} skipped` },
      conn,
    );
    return result;
  });
}
