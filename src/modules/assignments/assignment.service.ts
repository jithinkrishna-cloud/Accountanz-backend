import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { humanize } from "../../utils/format.js";
import { recordAudit } from "../audit/audit.service.js";
import * as clientRepo from "../clients/client.repository.js";
import { onClientTeamChanged } from "../projects/client-space-hooks.js";
import * as repo from "./assignment.repository.js";
import type { AssignmentInput, AssignmentListQuery, AssignmentUpdateInput } from "./assignment.validation.js";

const fieldError = (field: string, message: string) => new AppError("VALIDATION_ERROR", message, { fieldErrors: { [field]: [message] } });

export const listAssignments = (q: AssignmentListQuery) => repo.listAssignments(q);
export const assignmentOptions = () => repo.options();

export async function getAssignment(id: number) {
  const row = await repo.findAssignment(id);
  if (!row) throw AppError.notFound("Assignment");
  return row;
}

/**
 * Gives an accountant access to a client. With `replaces_id`, the replaced assignment is ended in the
 * same transaction and linked to the new one (a handover).
 */
export async function createAssignment(actor: AuthUser, input: AssignmentInput) {
  const client = await clientRepo.findClientById(input.client_id);
  if (!client) throw fieldError("client_id", "Choose a client");
  if (client.status === "exited") throw fieldError("client_id", "This client has exited");
  const staff = await repo.findAssignableStaff(input.user_id);
  if (!staff) throw fieldError("user_id", "Only active accountants can be assigned");
  // Nobody touches client work before an admin has verified them.
  if (staff.verification_status !== "verified") {
    throw fieldError("user_id", `${staff.full_name} isn't verified yet. Verify them in Accountants first.`);
  }

  const id = await withTransaction(async (conn) => {
    let replaced: repo.LockedAssignment | null = null;
    if (input.replaces_id) {
      replaced = await repo.lockAssignment(input.replaces_id, conn);
      if (!replaced || replaced.status !== "active") throw AppError.conflict("The assignment being replaced is no longer active");
      if (replaced.client_id !== input.client_id) throw AppError.conflict("The replaced assignment must be for the same client");
    }
    if (await repo.findActiveDuplicate(input, input.replaces_id ?? 0, conn)) {
      throw AppError.conflict(`${staff.full_name} already has an active ${humanize(input.team_role).toLowerCase()} assignment on this client`);
    }

    const newId = await repo.insertAssignment(input, conn);
    const period = `${input.valid_from} to ${input.valid_to ?? "open"}`;
    await recordAudit(
      actor,
      {
        action: replaced ? "Assignment handed over" : "Assignment created",
        entityType: "Assignment",
        entityId: newId,
        clientId: input.client_id,
        details: `${staff.full_name} as ${humanize(input.team_role).toLowerCase()}, ${period}${replaced ? `; replaces #${replaced.id}` : ""}`,
      },
      conn,
    );
    if (replaced) {
      await repo.endAssignment(replaced.id, newId, conn);
      await recordAudit(actor, { action: "Assignment ended", entityType: "Assignment", entityId: replaced.id, clientId: replaced.client_id, details: `Replaced by #${newId}` }, conn);
    }
    await onClientTeamChanged(actor, input.client_id, conn);
    return newId;
  });
  return getAssignment(id);
}

export async function updateAssignment(actor: AuthUser, id: number, input: AssignmentUpdateInput) {
  await withTransaction(async (conn) => {
    const a = await repo.lockAssignment(id, conn);
    if (!a) throw AppError.notFound("Assignment");
    if (a.status === "ended") throw AppError.conflict("An ended assignment can't be changed");
    if (input.valid_to && input.valid_to < a.valid_from) throw fieldError("valid_to", "End date can't be before the start date");
    await repo.updateAssignment(id, input, conn);
    await onClientTeamChanged(actor, a.client_id, conn);
    const parts = [
      input.valid_to !== undefined && `end date ${input.valid_to ?? "open"}`,
    ].filter(Boolean);
    await recordAudit(actor, { action: "Assignment updated", entityType: "Assignment", entityId: id, clientId: a.client_id, details: parts.join(", ") }, conn);
  });
  return getAssignment(id);
}

/** Ends an assignment now; the accountant loses access to the client immediately. */
/**
 * Ends every active assignment a person holds (used when their verification is rejected), inside the
 * caller's transaction. Same end rule as ending one by hand; one audit entry per assignment.
 */
export async function endAllForUser(actor: AuthUser, userId: number, reason: string, conn: PoolConnection) {
  const active = await repo.lockActiveForUser(userId, conn);
  for (const a of active) {
    await repo.endAssignment(a.id, null, conn);
    await recordAudit(actor, { action: "Assignment ended", entityType: "Assignment", entityId: a.id, clientId: a.client_id, details: `${humanize(a.team_role)} · ${reason}` }, conn);
    await onClientTeamChanged(actor, a.client_id, conn);
  }
  return active.length;
}

export async function endAssignment(actor: AuthUser, id: number) {
  await withTransaction(async (conn) => {
    const a = await repo.lockAssignment(id, conn);
    if (!a) throw AppError.notFound("Assignment");
    if (a.status === "ended") throw AppError.conflict("This assignment has already ended");
    await repo.endAssignment(id, null, conn);
    await recordAudit(actor, { action: "Assignment ended", entityType: "Assignment", entityId: id, clientId: a.client_id, details: humanize(a.team_role) }, conn);
    await onClientTeamChanged(actor, a.client_id, conn);
  });
  return getAssignment(id);
}
