import { accountantRequestDecidedEmail, accountantRequestedEmail } from "../../emails/templates.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { logger } from "../../utils/logger.js";
import { sendMail } from "../../utils/mailer.js";
import { recordAudit } from "../audit/audit.service.js";
import { createAssignment } from "../assignments/assignment.service.js";
import type { ClientContext } from "../client-portal/client-portal.types.js";
import { listAdminContacts } from "../notifications/notification.repository.js";
import { queryOne } from "../../database/connection.js";
import * as repo from "./accountant-request.repository.js";
import type { AccountantRequestInput, DecisionInput } from "./accountant-request.validation.js";

const KIND_LABEL: Record<repo.RequestKind, string> = { join_team: "Join our accounting team", one_off: "A one-off piece of work" };

/** Client: every verified accountant, with whether they already work on this company and any open request. */
export const explore = (ctx: ClientContext) => repo.exploreAccountants(ctx.clientId);

export async function exploreOne(ctx: ClientContext, accountantId: number) {
  const [a] = await repo.exploreAccountants(ctx.clientId, accountantId);
  if (!a) throw AppError.notFound("Accountant");
  return a;
}

export const myRequests = (ctx: ClientContext) => repo.clientRequests(ctx.clientId);

/** Client owner asks Accountanz for a specific accountant. One open request per accountant at a time. */
export async function request(actor: AuthUser, ctx: ClientContext, accountantId: number, input: AccountantRequestInput) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can request an accountant");
  const a = await exploreOne(ctx, accountantId);
  if (input.kind === "join_team" && a.team_roles.length) throw AppError.conflict(`${a.full_name} is already on your accounting team`);
  if (a.pending_request_id) throw AppError.conflict(`You already have an open request for ${a.full_name}`);

  const id = await repo.insertRequest({ clientId: ctx.clientId, accountantId, requestedBy: actor.id, kind: input.kind, message: input.message, preferredStart: input.preferred_start });
  await recordAudit(actor, { action: "Accountant requested", entityType: "AccountantRequest", entityId: id, clientId: ctx.clientId, details: `${a.full_name}: ${KIND_LABEL[input.kind]}` });

  void (async () => {
    try {
      for (const admin of await listAdminContacts()) {
        const content = accountantRequestedEmail({
          recipientName: admin.full_name,
          clientName: ctx.clientName,
          requester: actor.fullName,
          accountant: a.full_name,
          kind: KIND_LABEL[input.kind],
          message: input.message,
          preferredStart: input.preferred_start,
        });
        await sendMail({ to: admin.email, ...content, idempotencyKey: `accountant-requested/${id}/${admin.email}` });
      }
    } catch (err) {
      logger.error({ err }, "Accountant request email failed");
    }
  })();
  return repo.findRequest(id);
}

export async function withdraw(actor: AuthUser, ctx: ClientContext, id: number) {
  const r = await repo.findRequest(id);
  if (!r || r.client_id !== ctx.clientId) throw AppError.notFound("Request");
  if (r.requested_by !== actor.id && ctx.role !== "owner") throw AppError.forbidden("Only the person who asked, or the company owner, can withdraw this");
  if (!(await repo.setStatus(id, "withdrawn", actor.id, null))) throw AppError.conflict("This request has already been answered");
  await recordAudit(actor, { action: "Accountant request withdrawn", entityType: "AccountantRequest", entityId: id, clientId: ctx.clientId, details: r.accountant_name });
  return repo.findRequest(id);
}

// ── Admin ──
export const adminList = (status?: repo.RequestStatus) => repo.adminRequests(status);

export async function decide(actor: AuthUser, id: number, input: DecisionInput) {
  const r = await repo.findRequest(id);
  if (!r) throw AppError.notFound("Request");
  if (r.status !== "pending") throw AppError.conflict("This request has already been answered or withdrawn");
  // Approve and assign: create the assignment first, so a failure (not verified, already on the team in that role)
  // leaves the request waiting rather than approved with nobody assigned.
  let assignmentId: number | null = null;
  if (input.decision === "approved" && input.assign) {
    const created = await createAssignment(actor, {
      client_id: r.client_id,
      user_id: r.accountant_id,
      team_role: input.assign.team_role,
      valid_from: input.assign.valid_from,
      valid_to: input.assign.valid_to,
      journl_access: false,
      replaces_id: null,
    });
    assignmentId = created.id;
  }
  if (!(await repo.setStatus(id, input.decision, actor.id, input.note))) throw AppError.conflict("This request has already been answered or withdrawn");
  await recordAudit(actor, {
    action: input.decision === "approved" ? "Accountant request approved" : "Accountant request declined",
    entityType: "AccountantRequest",
    entityId: id,
    clientId: r.client_id,
    details: `${r.accountant_name} for ${r.client_name}${input.note ? `: ${input.note}` : ""}`,
  });

  void (async () => {
    try {
      if (!r.requested_by) return;
      const requester = await queryOne<{ email: string; full_name: string }>(`SELECT email, full_name FROM users WHERE id = ? AND status = 'active'`, [r.requested_by]);
      if (!requester) return;
      const content = accountantRequestDecidedEmail({ recipientName: requester.full_name, accountant: r.accountant_name, decision: input.decision, note: input.note, decidedBy: actor.fullName });
      await sendMail({ to: requester.email, ...content, idempotencyKey: `accountant-request-decided/${id}` });
    } catch (err) {
      logger.error({ err }, "Accountant request decision email failed");
    }
  })();
  return { ...(await repo.findRequest(id))!, assignment_id: assignmentId };
}
