import { withTransaction } from "../../database/connection.js";
import { env } from "../../config/env.js";
import { inviteEmail } from "../../emails/templates.js";
import { sha256 } from "../../utils/crypto.js";
import { sendMail } from "../../utils/mailer.js";
import { issueUserToken } from "../auth/auth.service.js";
import { findUserByEmail, insertUser } from "../users/user.repository.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./client.repository.js";
import type { BranchInput, ClientInput, ClientListQuery, ClientUpdateInput, InviteClientUserInput } from "./client.validation.js";

export const listClients = (q: ClientListQuery) => repo.listClients(q);

export async function getClient(id: number) {
  const client = await repo.getClientDetail(id);
  if (!client) throw AppError.notFound("Client");
  return client;
}

async function assertGstinFree(gstin: string | null | undefined, exceptId?: number) {
  if (!gstin) return;
  const existing = await repo.findClientByGstin(gstin);
  if (existing && existing.id !== exceptId) throw AppError.conflict("Another client already uses this GSTIN");
}

export async function createClient(actor: AuthUser, input: ClientInput) {
  await assertGstinFree(input.gstin);
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertClient(input, conn);
    await recordAudit(actor, { action: "Client created", entityType: "Client", entityId: newId, clientId: newId, details: input.legal_name }, conn);
    return newId;
  });
  return getClient(id);
}

export async function updateClient(actor: AuthUser, id: number, input: ClientUpdateInput) {
  const before = await repo.findClientById(id);
  if (!before) throw AppError.notFound("Client");
  await assertGstinFree(input.gstin, id);
  await withTransaction(async (conn) => {
    await repo.updateClient(id, input, conn);
    const statusChange = input.status && input.status !== before.status ? ` (status ${before.status} → ${input.status})` : "";
    await recordAudit(
      actor,
      { action: "Client updated", entityType: "Client", entityId: id, clientId: id, details: `${input.legal_name ?? before.legal_name}${statusChange}` },
      conn,
    );
  });
  return getClient(id);
}

const CLIENT_INVITE_DAYS = 7;

/**
 * Gives a client's own person a portal login: creates an invited account (owner → client_owner,
 * member → client_member), links it to the company, and emails a one-time link to set a password.
 * Owners can always approve; members only when allowed.
 */
export async function inviteClientUser(actor: AuthUser, clientId: number, input: InviteClientUserInput) {
  const client = await repo.findClientById(clientId);
  if (!client) throw AppError.notFound("Client");
  if (client.status === "exited") throw new AppError("VALIDATION_ERROR", "This client has exited");
  if (await findUserByEmail(input.email)) throw AppError.conflict("Someone with this email already has an account");

  const { userId, token } = await withTransaction(async (conn) => {
    const id = await insertUser(
      { email: input.email, fullName: input.full_name, phone: input.phone, role: input.role === "owner" ? "client_owner" : "client_member", passwordHash: null, status: "invited" },
      conn,
    );
    await repo.linkClientUser(clientId, id, input.role, input.can_approve, conn);
    const t = await issueUserToken(id, "invite", conn);
    await recordAudit(actor, { action: "Client user invited", entityType: "User", entityId: id, clientId, details: `${input.email} as ${input.role}${input.role === "member" && input.can_approve ? " (can approve)" : ""}` }, conn);
    return { userId: id, token: t };
  });

  const company = client.trade_name ?? client.legal_name;
  const url = `${env.APP_URL}/accept-invite?token=${token}`;
  const content = inviteEmail({ inviteeName: input.full_name, inviterName: `${actor.fullName} (Accountanz)`, roleLabel: `${input.role === "owner" ? "owner" : "team member"} for ${company}`, url, validDays: CLIENT_INVITE_DAYS });
  const mail = await sendMail({ to: input.email, ...content, idempotencyKey: `invite/${userId}/${sha256(token).slice(0, 16)}` });
  return { client: await getClient(clientId), invite_url: url, email_sent: mail.sent };
}

// ── Branches ──
async function assertBranchGstinFree(clientId: number, gstin: string | null) {
  if (!gstin) return;
  if (await repo.findOtherClientWithGstin(gstin, clientId)) {
    const message = "Another client already uses this GSTIN";
    throw new AppError("CONFLICT", message, { fieldErrors: { gstin: [message] } });
  }
}

async function requireOpenClient(clientId: number) {
  const client = await repo.findClientById(clientId);
  if (!client) throw AppError.notFound("Client");
  if (client.status === "exited") throw AppError.conflict("This client has exited; its branches can't be changed");
  return client;
}

export async function addBranch(actor: AuthUser, clientId: number, input: BranchInput) {
  await requireOpenClient(clientId);
  await assertBranchGstinFree(clientId, input.gstin);
  await withTransaction(async (conn) => {
    const id = await repo.insertBranch(clientId, input, conn);
    await recordAudit(actor, { action: "Branch added", entityType: "ClientBranch", entityId: id, clientId, details: input.name }, conn);
  });
  return getClient(clientId);
}

export async function updateBranch(actor: AuthUser, clientId: number, branchId: number, input: BranchInput) {
  await requireOpenClient(clientId);
  if (!(await repo.findBranch(clientId, branchId))) throw AppError.notFound("Branch");
  await assertBranchGstinFree(clientId, input.gstin);
  await withTransaction(async (conn) => {
    await repo.updateBranch(branchId, input, conn);
    await recordAudit(actor, { action: "Branch updated", entityType: "ClientBranch", entityId: branchId, clientId, details: input.name }, conn);
  });
  return getClient(clientId);
}

/** Nothing else references a branch yet, so removal is a plain delete (audited). */
export async function removeBranch(actor: AuthUser, clientId: number, branchId: number) {
  await requireOpenClient(clientId);
  const branch = await repo.findBranch(clientId, branchId);
  if (!branch) throw AppError.notFound("Branch");
  await withTransaction(async (conn) => {
    await repo.deleteBranch(branchId, conn);
    await recordAudit(actor, { action: "Branch removed", entityType: "ClientBranch", entityId: branchId, clientId, details: branch.name }, conn);
  });
  return getClient(clientId);
}
