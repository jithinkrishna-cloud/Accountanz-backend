import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { humanize } from "../../utils/format.js";
import { recordAudit } from "../audit/audit.service.js";
import * as clientRepo from "../clients/client.repository.js";
import * as engagementRepo from "../engagements/engagement.repository.js";
import { findPackageById } from "../packages/package.repository.js";
import { notifyProposalAccepted, notifyProposalSent } from "../notifications/notification.service.js";
import * as repo from "./onboarding.repository.js";
import { STAGE_TRANSITIONS } from "./onboarding.types.js";
import type { AssessmentInput, OnboardingListQuery, ProspectInput, StageInput } from "./onboarding.validation.js";

export async function listCases(q: OnboardingListQuery) {
  const [page, counts] = await Promise.all([repo.listCases(q), repo.stageCounts()]);
  return { ...page, counts };
}

export async function getCase(id: number) {
  const row = await repo.findCase(id);
  if (!row) throw AppError.notFound("Onboarding case");
  return row;
}

/**
 * The one place a prospect is opened: the client is created as a lead and its onboarding case starts at
 * "registered". Used when an admin adds a prospect and when a company registers itself on the platform.
 */
export async function openProspect(actor: AuthUser, input: ProspectInput, conn: PoolConnection, action = "Prospect added") {
  if (input.gstin && (await clientRepo.findClientByGstin(input.gstin))) {
    const message = "Another client already uses this GSTIN";
    throw new AppError("CONFLICT", message, { fieldErrors: { gstin: [message] } });
  }
  const clientId = await clientRepo.insertClient(
    { legal_name: input.legal_name, trade_name: input.trade_name, gstin: input.gstin, pan: input.pan, state: input.state, address: null, status: "lead", accounting_software: "none" },
    conn,
  );
  const caseId = await repo.insertCase(clientId, input.notes, conn);
  await recordAudit(actor, { action, entityType: "OnboardingCase", entityId: caseId, clientId, details: input.legal_name }, conn);
  return { clientId, caseId };
}

export async function createProspect(actor: AuthUser, input: ProspectInput) {
  const { caseId } = await withTransaction((conn) => openProspect(actor, input, conn));
  return getCase(caseId);
}

export async function saveAssessment(actor: AuthUser, id: number, input: AssessmentInput) {
  if (input.suggested_package_id) {
    const pkg = await findPackageById(input.suggested_package_id);
    if (!pkg || !pkg.is_active) throw new AppError("VALIDATION_ERROR", "Choose an active package", { fieldErrors: { suggested_package_id: ["Choose an active package"] } });
  }
  await withTransaction(async (conn) => {
    const oc = await repo.lockCase(id, conn);
    if (!oc) throw AppError.notFound("Onboarding case");
    if (oc.stage === "accepted") throw AppError.conflict("This prospect has already accepted; change the engagement instead");
    await repo.updateAssessment(id, input, actor.id, conn);
    // Recording an assessment on a fresh registration moves it into the assessment stage.
    if (oc.stage === "registered") await repo.setStage(id, "assessment", conn);
    const parts = [
      input.complexity && `complexity ${input.complexity}`,
      input.monthly_transaction_volume != null && `${input.monthly_transaction_volume} txns/month`,
      input.suggested_monthly_fee != null && `fee ${input.suggested_monthly_fee}`,
    ].filter(Boolean);
    await recordAudit(actor, { action: "Assessment saved", entityType: "OnboardingCase", entityId: id, clientId: oc.client_id, details: parts.join(", ") || null }, conn);
  });
  return getCase(id);
}

/**
 * Moves a case along its stages. Sending a proposal needs a complete assessment.
 * Accepting turns the lead into an onboarding client and opens a draft engagement on the suggested package.
 */
export async function changeStage(actor: AuthUser, id: number, input: StageInput) {
  await withTransaction(async (conn) => {
    const oc = await repo.lockCase(id, conn);
    if (!oc) throw AppError.notFound("Onboarding case");
    if (!STAGE_TRANSITIONS[oc.stage].includes(input.to)) {
      throw AppError.conflict(`A prospect can't move from ${humanize(oc.stage)} to ${humanize(input.to)}`);
    }
    if ((input.to === "proposal_sent" || input.to === "accepted") && (!oc.complexity || !oc.suggested_package_id || oc.suggested_monthly_fee == null)) {
      throw AppError.conflict("Save the assessment (complexity, package and fee) before sending a proposal");
    }

    await repo.setStage(id, input.to, conn);
    let details = `${humanize(oc.stage)} → ${humanize(input.to)}`;

    if (input.to === "proposal_sent") await repo.markProposalSent(id, conn);
    if (input.to === "accepted") details += await acceptOnCase(actor, oc, "team", conn);
    if (input.to === "rejected" && input.reason) details += `: ${input.reason}`;

    await recordAudit(actor, { action: "Onboarding stage changed", entityType: "OnboardingCase", entityId: id, clientId: oc.client_id, details }, conn);
  });
  if (input.to === "proposal_sent") void notifyProposalSent(id);
  return getCase(id);
}

/**
 * What accepting a proposal does, whoever accepts it (the client in their portal, or staff after a call):
 * records who and how, moves a lead to onboarding and opens a draft engagement on the proposed package.
 * Activation is a separate, later step (signed agreement, then activate). Returns audit detail text.
 */
export async function acceptOnCase(
  actor: AuthUser,
  oc: { id: number; client_id: number; suggested_package_id: number | null; suggested_monthly_fee: number | null },
  via: "client" | "team",
  conn: PoolConnection,
) {
  let details = "";
  await repo.markAccepted(oc.id, actor.id, via, conn);
  const client = await clientRepo.findClientById(oc.client_id, conn);
  if (client?.status === "lead") await clientRepo.updateClient(oc.client_id, { status: "onboarding" }, conn);
  const open = await engagementRepo.findOpenEngagement(oc.client_id, conn);
  const fee = oc.suggested_monthly_fee == null ? null : Number(oc.suggested_monthly_fee);
  if (open?.status === "draft") {
    // A draft the client opened from the catalogue: it now follows the accepted proposal.
    await engagementRepo.updateEngagement(open.id, { package_id: oc.suggested_package_id!, monthly_fee: fee }, conn);
    details += `; draft engagement #${open.id} set to the proposed package and fee`;
  } else if (!open) {
    const engagementId = await engagementRepo.insertEngagement({ client_id: oc.client_id, package_id: oc.suggested_package_id!, monthly_fee: fee, start_date: null, renewal_date: null }, conn);
    await recordAudit(actor, { action: "Engagement created", entityType: "Engagement", entityId: engagementId, clientId: oc.client_id, details: `Draft opened from proposal accepted by the ${via}` }, conn);
    details += `; draft engagement #${engagementId} opened`;
  }
  return details;
}

/** The client accepts their proposal in the portal (owner only; checked by the caller). */
export async function acceptByClient(actor: AuthUser, clientId: number) {
  const caseId = await withTransaction(async (conn) => {
    const current = await repo.clientProposal(clientId);
    const oc = current ? await repo.lockCase(current.id, conn) : null;
    if (!oc || oc.client_id !== clientId) throw AppError.notFound("Proposal");
    if (oc.stage !== "proposal_sent") throw AppError.conflict(oc.stage === "accepted" ? "You've already accepted this proposal" : "This proposal is no longer open. Message your team.");
    await repo.setStage(oc.id, "accepted", conn);
    const details = await acceptOnCase(actor, oc, "client", conn);
    await recordAudit(actor, { action: "Proposal accepted", entityType: "OnboardingCase", entityId: oc.id, clientId, details: `Accepted in the client portal${details}` }, conn);
    return oc.id;
  });
  void notifyProposalAccepted(caseId);
  return caseId;
}
