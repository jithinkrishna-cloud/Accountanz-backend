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
import { assertNoConflictingEngagement } from "./onboarding.sync.js";
import { STAGE_TRANSITIONS, type OnboardingReadiness } from "./onboarding.types.js";

/**
 * A package and fee are always needed. Complexity is the team's own judgement: needed when staff pick the package,
 * not when the client already chose it in their portal (staff then only confirm the choice and the fee).
 */
const assessmentComplete = (oc: { complexity: string | null; suggested_package_id: number | null; suggested_monthly_fee: number | null; package_source: "team" | "client" | null }) =>
  !!(oc.suggested_package_id && oc.suggested_monthly_fee != null && (oc.complexity || oc.package_source === "client"));
import type { AssessmentInput, OnboardingListQuery, ProspectInput, ServiceRequirementsInput, StageInput } from "./onboarding.validation.js";

async function computeReadiness(caseId: number, clientId: number, assessmentComplete: boolean): Promise<OnboardingReadiness> {
  const [client, tax, stakeholders, financial, requirements] = await Promise.all([
    clientRepo.findClientById(clientId),
    clientRepo.getTaxDetails(clientId),
    clientRepo.listStakeholders(clientId),
    clientRepo.getFinancialProfile(clientId),
    repo.getServiceRequirements(caseId),
  ]);
  const company_profile = !!(client?.legal_name && client?.business_type && client?.state);
  const primary_contact = !!(client?.primary_contact_name && (client?.primary_contact_email || client?.primary_contact_phone));
  const tax_details = !!(tax && (tax.pan_number || tax.gstin || tax.cin || tax.llpin || tax.tan_number));
  const stakeholdersOk = stakeholders.length > 0;
  const financial_profile = !!(financial && financial.financial_year_start_month);
  const service_requirements = !!(requirements && (requirements.bookkeeping || requirements.gst_filing || requirements.income_tax_filing || requirements.payroll || requirements.audit_support || requirements.other_services));
  const sections = { company_profile, primary_contact, tax_details, stakeholders: stakeholdersOk, financial_profile, service_requirements, assessment: assessmentComplete };
  const labels: Record<keyof typeof sections, string> = {
    company_profile: "Company profile (legal name, business type, state)",
    primary_contact: "Primary contact (name and email/phone)",
    tax_details: "Tax/registration details",
    stakeholders: "At least one stakeholder",
    financial_profile: "Financial profile (FY start month)",
    service_requirements: "Service requirements",
    assessment: "Assessment (complexity, package, fee)",
  };
  const missing = (Object.keys(sections) as (keyof typeof sections)[]).filter((k) => !sections[k]).map((k) => labels[k]);
  return { complete: missing.length === 0, missing, sections };
}

export async function listCases(q: OnboardingListQuery) {
  const [page, counts] = await Promise.all([repo.listCases(q), repo.stageCounts()]);
  return { ...page, counts };
}

export async function getCase(id: number) {
  const row = await repo.findCase(id);
  if (!row) throw AppError.notFound("Onboarding case");
  const [service_requirements, readiness] = await Promise.all([
    repo.getServiceRequirements(id),
    computeReadiness(id, row.client_id, assessmentComplete(row)),
  ]);
  return { ...row, service_requirements, readiness };
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
    {
      legal_name: input.legal_name,
      trade_name: input.trade_name ?? null,
      business_type: input.business_type ?? null,
      date_of_establishment: input.date_of_establishment ?? null,
      gstin: input.gstin ?? null,
      pan: input.pan ?? null,
      state: input.state ?? null,
      address: input.address ?? null,
      primary_contact_name: input.primary_contact_name ?? null,
      primary_contact_email: input.primary_contact_email ?? null,
      primary_contact_phone: input.primary_contact_phone ?? null,
      status: "lead",
      accounting_software: input.accounting_software ?? "none",
    },
    conn,
  );
  await clientRepo.mirrorRegistrationToTax(clientId, input.pan, input.gstin, conn);
  const caseId = await repo.insertCase(clientId, input.notes ?? null, conn);
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
    // Suggesting a package the client isn't already committed to would create a second, conflicting offer.
    if (input.suggested_package_id) await assertNoConflictingEngagement(oc.client_id, input.suggested_package_id, conn);
    // Keeping the client's own choice keeps it marked as theirs; picking another package makes it the team's suggestion.
    const packageSource = !input.suggested_package_id ? null : input.suggested_package_id === oc.suggested_package_id && oc.package_source ? oc.package_source : "team";
    await repo.updateAssessment(id, input, packageSource, actor.id, conn);
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

export async function saveServiceRequirements(actor: AuthUser, caseId: number, input: ServiceRequirementsInput) {
  const oc = await repo.findCase(caseId);
  if (!oc) throw AppError.notFound("Onboarding case");
  const requirements = await repo.upsertServiceRequirements(caseId, input);
  await recordAudit(actor, { action: "Service requirements saved", entityType: "OnboardingCase", entityId: caseId, clientId: oc.client_id });
  return requirements;
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
    if ((input.to === "proposal_sent" || input.to === "accepted") && !assessmentComplete(oc)) {
      throw AppError.conflict("Save the assessment (complexity, package and fee) before sending a proposal");
    }
    // Straight from assessment to accepted only confirms a package the client chose themselves in the portal.
    if (oc.stage === "assessment" && input.to === "accepted" && oc.package_source !== "client") {
      throw AppError.conflict("Send the proposal to the client first. Only a package the client chose in their portal can be confirmed directly.");
    }
    if (input.to === "proposal_sent" || input.to === "accepted") await assertNoConflictingEngagement(oc.client_id, oc.suggested_package_id, conn);
    // Soft gate: a proposal goes out on complete onboarding data, unless an admin gives a reason to send it anyway.
    let overrideNote = "";
    if (input.to === "proposal_sent") {
      const readiness = await computeReadiness(id, oc.client_id, true);
      if (!readiness.complete) {
        if (!input.override_reason) {
          throw new AppError("CONFLICT", `Complete the onboarding data before sending a proposal: ${readiness.missing.join("; ")}`, { readiness: { missing: readiness.missing } });
        }
        overrideNote = ` (sent with incomplete data: ${readiness.missing.join("; ")}. Reason: ${input.override_reason})`;
      }
    }

    await repo.setStage(id, input.to, conn);
    let details = `${humanize(oc.stage)} → ${humanize(input.to)}${overrideNote}`;

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
