import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { humanize } from "../../utils/format.js";
import { recordAudit } from "../audit/audit.service.js";
import * as clientRepo from "../clients/client.repository.js";
import * as engagementRepo from "../engagements/engagement.repository.js";
import { findPackageById } from "../packages/package.repository.js";
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

    if (input.to === "accepted") {
      const client = await clientRepo.findClientById(oc.client_id, conn);
      if (client?.status === "lead") await clientRepo.updateClient(oc.client_id, { status: "onboarding" }, conn);
      const open = await engagementRepo.findOpenEngagement(oc.client_id, conn);
      if (!open) {
        const engagementId = await engagementRepo.insertEngagement({ client_id: oc.client_id, package_id: oc.suggested_package_id!, start_date: null, renewal_date: null }, conn);
        await recordAudit(actor, { action: "Engagement created", entityType: "Engagement", entityId: engagementId, clientId: oc.client_id, details: "Draft opened from accepted proposal" }, conn);
        details += `; draft engagement #${engagementId} opened`;
      }
    }
    if (input.to === "rejected" && input.reason) details += `: ${input.reason}`;

    await recordAudit(actor, { action: "Onboarding stage changed", entityType: "OnboardingCase", entityId: id, clientId: oc.client_id, details }, conn);
  });
  return getCase(id);
}
