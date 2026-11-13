import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { clientScope, requireClientAccess } from "../access/client-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { taskBelongsToClient } from "../documents/document.repository.js";
import { notifyApprovalRequested } from "../notifications/notification.service.js";
import * as repo from "./approval.repository.js";
import type { ApprovalListQuery, CreateApprovalInput } from "./approval.validation.js";

/** Staff side of client approvals; the client decides in the client portal (client-portal.service decideApproval). */
export const listApprovals = (actor: AuthUser, q: ApprovalListQuery) => repo.listApprovals(q, clientScope(actor, "a.client_id"));

export async function requestApproval(actor: AuthUser, input: CreateApprovalInput) {
  await requireClientAccess(actor, input.client_id);
  if (input.related_task_id && !(await taskBelongsToClient(input.related_task_id, input.client_id))) {
    throw new AppError("VALIDATION_ERROR", "That task belongs to another client", { fieldErrors: { related_task_id: ["Choose one of this client's tasks"] } });
  }
  const id = await withTransaction(async (conn) => {
    const approvalId = await repo.insertApproval(input, actor.id, conn);
    await recordAudit(actor, { action: "Approval requested", entityType: "ClientApproval", entityId: approvalId, clientId: input.client_id, details: input.subject }, conn);
    return approvalId;
  });
  void notifyApprovalRequested(id, { clientId: input.client_id, requester: actor.fullName, subject: input.subject, description: input.description });
  return (await repo.findApproval(id))!;
}
