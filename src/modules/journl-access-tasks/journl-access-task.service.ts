import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./journl-access-task.repository.js";
import { ACCESS_TASK_TRANSITIONS, type AccessTaskAction } from "./journl-access-task.types.js";
import type { AccessTaskListQuery, AccessTaskUpdateInput } from "./journl-access-task.validation.js";

/**
 * JournL has no API for accountant logins, so access is changed by hand in JournL. Assignment changes queue a
 * to-do here (inside the assignment's own transaction); access only counts as granted or removed once the to-do
 * is completed with a note. Nothing here talks to JournL.
 */

const ACTION_LABEL: Record<AccessTaskAction, string> = {
  grant: "Add to JournL",
  revoke: "Remove from JournL",
  verify_revoke: "Verify and remove JournL access",
  update: "Update JournL accountant access",
};

async function queue(
  actor: AuthUser,
  input: { clientId: number; assignmentId: number | null; userId: number; previousUserId?: number | null; action: AccessTaskAction; reason: string },
  conn: PoolConnection,
) {
  const id = await repo.insertTask({ ...input, createdBy: actor.id }, conn);
  await recordAudit(actor, { action: "JournL access to-do created", entityType: "JournlAccessTask", entityId: id, clientId: input.clientId, details: `${ACTION_LABEL[input.action]} · ${input.reason}` }, conn);
  return id;
}

async function cancel(actor: AuthUser, task: { id: number }, clientId: number, why: string, conn: PoolConnection) {
  await repo.updateTask(task.id, { status: "cancelled", notes: why }, conn);
  await recordAudit(actor, { action: "JournL access to-do cancelled", entityType: "JournlAccessTask", entityId: task.id, clientId, details: why }, conn);
}

interface AssignmentRef {
  id: number;
  client_id: number;
  user_id: number;
}

/** A new assignment with JournL access on: add the person in JournL. */
export async function onAssignmentCreated(actor: AuthUser, a: AssignmentRef, journlAccess: boolean, conn: PoolConnection) {
  if (journlAccess) await queue(actor, { clientId: a.client_id, assignmentId: a.id, userId: a.user_id, action: "grant", reason: "new assignment" }, conn);
}

/**
 * JournL access switched on or off. Undoing a change that hasn't been carried out yet cancels the waiting to-do
 * instead of queuing the opposite one (nothing changed in JournL).
 */
export async function onAccessToggled(actor: AuthUser, a: AssignmentRef, from: boolean, to: boolean, conn: PoolConnection) {
  if (from === to) return;
  if (to) {
    const waitingRemoval = await repo.lockOpenForAssignment(a.id, ["revoke", "verify_revoke"], conn);
    if (waitingRemoval) return cancel(actor, waitingRemoval, a.client_id, "JournL access turned back on before it was removed", conn);
    await queue(actor, { clientId: a.client_id, assignmentId: a.id, userId: a.user_id, action: "grant", reason: "JournL access turned on" }, conn);
  } else {
    const waitingGrant = await repo.lockOpenForAssignment(a.id, ["grant", "update"], conn);
    if (waitingGrant) return cancel(actor, waitingGrant, a.client_id, "JournL access turned off before it was given", conn);
    await queue(actor, { clientId: a.client_id, assignmentId: a.id, userId: a.user_id, action: "revoke", reason: "JournL access turned off" }, conn);
  }
}

/** An assignment that had JournL access ended: check the login is gone (or cancel an add that never happened). */
export async function onAssignmentEnded(actor: AuthUser, a: AssignmentRef, journlAccess: boolean, reason: string, conn: PoolConnection) {
  if (!journlAccess) return;
  const waitingGrant = await repo.lockOpenForAssignment(a.id, ["grant", "update"], conn);
  if (waitingGrant) return cancel(actor, waitingGrant, a.client_id, `Assignment ended before JournL access was given (${reason})`, conn);
  await queue(actor, { clientId: a.client_id, assignmentId: a.id, userId: a.user_id, action: "verify_revoke", reason }, conn);
}

/**
 * A hand-over: the replaced person leaves, the new one joins. One "update" to-do when both sides need a JournL
 * change; otherwise the one side that does.
 */
export async function onHandover(actor: AuthUser, replaced: AssignmentRef & { journl_access: boolean }, next: AssignmentRef & { journl_access: boolean }, conn: PoolConnection) {
  let oldMayHaveAccess = replaced.journl_access;
  if (oldMayHaveAccess) {
    const waitingGrant = await repo.lockOpenForAssignment(replaced.id, ["grant", "update"], conn);
    if (waitingGrant) {
      await cancel(actor, waitingGrant, replaced.client_id, "Handed over before JournL access was given", conn);
      oldMayHaveAccess = false;
    }
  }
  if (oldMayHaveAccess && next.journl_access) {
    await queue(actor, { clientId: next.client_id, assignmentId: next.id, userId: next.user_id, previousUserId: replaced.user_id, action: "update", reason: "hand-over" }, conn);
  } else if (oldMayHaveAccess) {
    await queue(actor, { clientId: replaced.client_id, assignmentId: replaced.id, userId: replaced.user_id, action: "verify_revoke", reason: "handed over" }, conn);
  } else if (next.journl_access) {
    await queue(actor, { clientId: next.client_id, assignmentId: next.id, userId: next.user_id, action: "grant", reason: "hand-over" }, conn);
  }
}

export const listTasks = (q: AccessTaskListQuery) => repo.listTasks(q);
export const responsibleOptions = () => repo.responsibleOptions();

export async function updateTask(actor: AuthUser, id: number, input: AccessTaskUpdateInput) {
  if (input.responsible_id && !(await repo.findResponsible(input.responsible_id))) {
    throw new AppError("VALIDATION_ERROR", "Choose an active admin", { fieldErrors: { responsible_id: ["Choose an active admin"] } });
  }
  await withTransaction(async (conn) => {
    const t = await repo.lockTask(id, conn);
    if (!t) throw AppError.notFound("To-do");
    if (input.status && input.status !== t.status && !ACCESS_TASK_TRANSITIONS[t.status].includes(input.status)) {
      throw AppError.conflict(`This to-do is already ${t.status.replace("_", " ")}`);
    }
    if (input.status === "cancelled" && !input.notes) {
      throw new AppError("VALIDATION_ERROR", "Say why it's cancelled", { fieldErrors: { notes: ["Say why it's cancelled"] } });
    }
    await repo.updateTask(id, { status: input.status, responsibleId: input.responsible_id, notes: input.notes, completedBy: actor.id }, conn);
    const parts = [
      input.status && input.status !== t.status && `status ${input.status.replace("_", " ")}`,
      input.responsible_id !== undefined && "owner changed",
      input.notes && `note: ${input.notes}`,
    ].filter(Boolean);
    await recordAudit(actor, { action: "JournL access to-do updated", entityType: "JournlAccessTask", entityId: id, clientId: t.client_id, details: `${ACTION_LABEL[t.action]} · ${parts.join(", ")}` }, conn);
  });
  return repo.findTask(id);
}
