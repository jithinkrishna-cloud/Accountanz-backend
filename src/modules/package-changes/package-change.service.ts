import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import type { ClientContext } from "../client-portal/client-portal.types.js";
import * as engagementRepo from "../engagements/engagement.repository.js";
import { clientProposal } from "../onboarding/onboarding.repository.js";
import { syncCaseWithEngagement } from "../onboarding/onboarding.sync.js";
import { findPackageById } from "../packages/package.repository.js";
import { onClientTeamChanged } from "../projects/client-space-hooks.js";
import * as repo from "./package-change.repository.js";
import type { PackageChangeDecisionInput, PackageChangeRequestInput, StaffPackageChangeInput } from "./package-change.validation.js";

const fieldError = (field: string, message: string) => new AppError("VALIDATION_ERROR", message, { fieldErrors: { [field]: [message] } });

async function activePackage(id: number) {
  const pkg = await findPackageById(id);
  if (!pkg || !pkg.is_active) throw fieldError("package_id", "Choose an active package");
  return pkg;
}

/**
 * Moves an engagement onto another package. What else changes depends on how far the engagement has got:
 *   - draft:           just the package (the agreement hasn't gone out yet);
 *   - sent / accepted: back to draft, because the agreement the client has is for the old package;
 *   - active:          package and fee change in place; the next invoice bills the new package.
 * The onboarding case follows (see syncCaseWithEngagement). Returns audit detail text.
 */
async function applyChange(actor: AuthUser, engagementId: number, toPackageId: number, monthlyFee: number | null, source: "client" | "team", conn: PoolConnection) {
  const e = await engagementRepo.lockEngagement(engagementId, conn);
  if (!e) throw AppError.notFound("Engagement");
  if (e.status === "ended") throw AppError.conflict("An ended engagement can't change package");
  if (e.package_id === toPackageId && monthlyFee == null) throw fieldError("package_id", "The engagement is already on this package");

  await engagementRepo.updateEngagement(e.id, { package_id: toPackageId, monthly_fee: monthlyFee }, conn);
  await onClientTeamChanged(actor, e.client_id, conn);
  let effect = "";
  if (e.status === "sent" || e.status === "accepted") {
    await engagementRepo.setStatus(e.id, "draft", conn);
    effect = `; back to draft for a new agreement (was ${e.status})`;
  } else if (e.status === "active") {
    effect = "; billed from the next invoice";
  }
  await syncCaseWithEngagement(actor, e.client_id, source, conn);
  return { engagement: e, effect };
}

// ── Client ──

/** The company owner asks to move their engagement to another package. Staff approve or decline. */
export async function requestChange(actor: AuthUser, ctx: ClientContext, input: PackageChangeRequestInput) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can ask to change package");
  const pkg = await activePackage(input.package_id);
  const proposal = await clientProposal(ctx.clientId);
  if (proposal?.stage === "proposal_sent") throw AppError.conflict(`Your team has proposed ${proposal.package_name}. Accept it, or message your team about a different package.`);

  const id = await withTransaction(async (conn) => {
    const e = await engagementRepo.findOpenTerms(ctx.clientId, conn);
    if (!e) throw AppError.conflict("You don't have a package yet. Choose one instead.");
    if (e.status === "draft") throw AppError.conflict("Your agreement hasn't been sent yet, so you can still switch package directly.");
    if (e.package_id === pkg.id) throw fieldError("package_id", `You're already on ${pkg.name}`);
    const pending = await repo.pendingForEngagement(e.id, conn);
    if (pending) throw AppError.conflict(`You already asked to move to ${pending.to_package_name}. Withdraw that request first.`);
    const newId = await repo.insertChange({ clientId: ctx.clientId, engagementId: e.id, fromPackageId: e.package_id, toPackageId: pkg.id, source: "client", message: input.message, requestedBy: actor.id }, conn);
    await recordAudit(actor, { action: "Package change requested", entityType: "PackageChangeRequest", entityId: newId, clientId: ctx.clientId, details: `${e.package_name} → ${pkg.name} (engagement #${e.id}, ${e.status})` }, conn);
    return newId;
  });
  return repo.findChange(id);
}

export async function withdrawChange(actor: AuthUser, ctx: ClientContext, id: number) {
  const r = await repo.findChange(id);
  if (!r || r.client_id !== ctx.clientId) throw AppError.notFound("Request");
  if (r.requested_by !== actor.id && ctx.role !== "owner") throw AppError.forbidden("Only the person who asked, or the company owner, can withdraw this");
  if (!(await repo.decideChange(id, "withdrawn", actor.id, null, null))) throw AppError.conflict("This request has already been answered");
  await recordAudit(actor, { action: "Package change withdrawn", entityType: "PackageChangeRequest", entityId: id, clientId: ctx.clientId, details: `${r.from_package_name} → ${r.to_package_name}` });
  return repo.findChange(id);
}

// ── Staff ──

/** Staff change an engagement's package directly (after a call, say). Recorded as an approved change. */
export async function staffChange(actor: AuthUser, engagementId: number, input: StaffPackageChangeInput) {
  const pkg = await activePackage(input.package_id);
  await withTransaction(async (conn) => {
    const pending = await repo.pendingForEngagement(engagementId, conn);
    if (pending) throw AppError.conflict(`The client has asked to move to ${pending.to_package_name}. Approve or decline that request first.`);
    const locked = await engagementRepo.lockEngagement(engagementId, conn);
    if (!locked) throw AppError.notFound("Engagement");
    const before = await engagementRepo.findOpenTerms(locked.client_id, conn);
    if (before?.id !== engagementId) throw AppError.conflict("Only the client's current engagement can change package");
    const { engagement, effect } = await applyChange(actor, engagementId, pkg.id, input.monthly_fee, "team", conn);
    const id = await repo.insertChange(
      { clientId: engagement.client_id, engagementId, fromPackageId: engagement.package_id, toPackageId: pkg.id, source: "team", message: null, requestedBy: actor.id, status: "approved", monthlyFee: input.monthly_fee, decidedBy: actor.id, decisionNote: input.note },
      conn,
    );
    await recordAudit(actor, { action: "Package changed", entityType: "Engagement", entityId: engagementId, clientId: engagement.client_id, details: `${before.package_name} → ${pkg.name}${effect}${input.note ? `: ${input.note}` : ""} (change #${id})` }, conn);
  });
  return engagementRepo.findEngagement(engagementId);
}

export async function decideChange(actor: AuthUser, id: number, input: PackageChangeDecisionInput) {
  const r = await repo.findChange(id);
  if (!r) throw AppError.notFound("Request");
  if (r.status !== "pending") throw AppError.conflict("This request has already been answered or withdrawn");
  if (input.decision === "approved") await activePackage(r.to_package_id);

  await withTransaction(async (conn) => {
    const locked = await repo.lockChange(id, conn);
    if (locked?.status !== "pending") throw AppError.conflict("This request has already been answered or withdrawn");
    let effect = "";
    if (input.decision === "approved") effect = (await applyChange(actor, r.engagement_id, r.to_package_id, input.monthly_fee, r.source, conn)).effect;
    await repo.decideChange(id, input.decision, actor.id, input.note, input.decision === "approved" ? input.monthly_fee : null, conn);
    await recordAudit(actor, {
      action: input.decision === "approved" ? "Package change approved" : "Package change declined",
      entityType: "PackageChangeRequest",
      entityId: id,
      clientId: r.client_id,
      details: `${r.from_package_name} → ${r.to_package_name}${effect}${input.note ? `: ${input.note}` : ""}`,
    }, conn);
  });
  return { change: await repo.findChange(id), engagement: await engagementRepo.findEngagement(r.engagement_id) };
}
