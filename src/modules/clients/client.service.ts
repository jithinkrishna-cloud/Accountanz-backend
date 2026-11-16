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
import type {
  BranchInput,
  ClientInput,
  ClientListQuery,
  ClientUpdateInput,
  CompanyTaxDetailsInput,
  FinancialProfileInput,
  InviteClientUserInput,
  StakeholderInput,
} from "./client.validation.js";

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
    await repo.mirrorRegistrationToTax(newId, input.pan, input.gstin, conn);
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
    await repo.mirrorRegistrationToTax(id, input.pan, input.gstin, conn);
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

// Branches
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

// Progressive onboarding entities (additive)
export async function saveTaxDetails(actor: AuthUser, clientId: number, input: CompanyTaxDetailsInput) {
  await getClient(clientId);
  if (input.gstin) {
    const existing = await repo.findClientByGstin(input.gstin);
    if (existing && existing.id !== clientId) {
      const message = "Another client already uses this GSTIN";
      throw new AppError("CONFLICT", message, { fieldErrors: { gstin: [message] } });
    }
  }
  return withTransaction(async (conn) => {
    const details = await repo.upsertTaxDetails(clientId, input, conn);
    await repo.mirrorTaxToClient(clientId, input.pan_number, input.gstin, conn);
    await recordAudit(actor, { action: "Client tax details saved", entityType: "Client", entityId: clientId, clientId }, conn);
    return details;
  });
}

const OWNERSHIP_ERROR = "Total ownership across stakeholders can't exceed 100%";

/** Rejects an add/edit that would push the client's total ownership above 100%. */
async function assertOwnershipFits(clientId: number, exceptId: number | null, input: StakeholderInput, conn: Parameters<typeof repo.sumOwnership>[2]) {
  if (input.ownership_percentage == null) return;
  const others = await repo.sumOwnership(clientId, exceptId, conn);
  if (others + input.ownership_percentage > 100.0001) {
    throw new AppError("VALIDATION_ERROR", OWNERSHIP_ERROR, {
      fieldErrors: { ownership_percentage: [`Only ${Math.max(0, 100 - others).toFixed(2)}% is left to allocate`] },
    });
  }
}

export async function listStakeholders(clientId: number) {
  await getClient(clientId);
  return repo.listStakeholders(clientId);
}

export async function saveStakeholders(actor: AuthUser, clientId: number, stakeholders: StakeholderInput[]) {
  await getClient(clientId);
  const rows = await withTransaction((conn) => repo.replaceStakeholders(clientId, stakeholders, conn));
  await recordAudit(actor, { action: "Client stakeholders saved", entityType: "Client", entityId: clientId, clientId, details: `${rows.length} stakeholder(s)` });
  return rows;
}

export async function addStakeholder(actor: AuthUser, clientId: number, input: StakeholderInput) {
  await getClient(clientId);
  return withTransaction(async (conn) => {
    await assertOwnershipFits(clientId, null, input, conn);
    const id = await repo.insertStakeholder(clientId, input, conn);
    if (input.is_primary) await repo.clearOtherPrimaries(clientId, id, conn);
    await recordAudit(actor, { action: "Client stakeholder added", entityType: "Client", entityId: clientId, clientId, details: input.full_name }, conn);
    return repo.findStakeholder(clientId, id, conn);
  });
}

export async function updateStakeholder(actor: AuthUser, clientId: number, stakeholderId: number, input: StakeholderInput) {
  await getClient(clientId);
  if (!(await repo.findStakeholder(clientId, stakeholderId))) throw AppError.notFound("Stakeholder");
  return withTransaction(async (conn) => {
    await assertOwnershipFits(clientId, stakeholderId, input, conn);
    await repo.updateStakeholder(stakeholderId, input, conn);
    if (input.is_primary) await repo.clearOtherPrimaries(clientId, stakeholderId, conn);
    await recordAudit(actor, { action: "Client stakeholder updated", entityType: "Client", entityId: clientId, clientId, details: input.full_name }, conn);
    return repo.findStakeholder(clientId, stakeholderId, conn);
  });
}

export async function removeStakeholder(actor: AuthUser, clientId: number, stakeholderId: number) {
  await getClient(clientId);
  const row = await repo.findStakeholder(clientId, stakeholderId);
  if (!row) throw AppError.notFound("Stakeholder");
  await repo.deleteStakeholder(stakeholderId);
  await recordAudit(actor, { action: "Client stakeholder removed", entityType: "Client", entityId: clientId, clientId, details: row.full_name });
}

export async function saveFinancialProfile(actor: AuthUser, clientId: number, input: FinancialProfileInput) {
  await getClient(clientId);
  const profile = await repo.upsertFinancialProfile(clientId, input);
  await recordAudit(actor, { action: "Client financial profile saved", entityType: "Client", entityId: clientId, clientId });
  return profile;
}
