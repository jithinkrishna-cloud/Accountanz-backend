import type { PoolConnection } from "mysql2/promise";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { humanize } from "../../utils/format.js";
import { recordAudit } from "../audit/audit.service.js";
import * as clientRepo from "../clients/client.repository.js";
import * as engagementRepo from "../engagements/engagement.repository.js";
import * as repo from "./onboarding.repository.js";

/**
 * Onboarding and engagements describe one client and one package. The engagement is the live record (it is what
 * gets billed), so whenever it is created, its package changes or it moves forward, the client's onboarding case
 * follows it here:
 *   - draft / sent: the case takes the engagement's package and fee, and a fresh or rejected case moves to assessment;
 *   - accepted / active: the case is accepted on that package (nothing is left to assess or propose).
 * An accepted case is history (what was agreed at onboarding) and is not rewritten; later changes live on the
 * engagement and its package change requests.
 *
 * `source` says who picked the package: the client in their portal, or staff.
 */
export async function syncCaseWithEngagement(actor: AuthUser, clientId: number, source: "client" | "team", conn: PoolConnection) {
  const oc = await repo.lockLatestCaseForClient(clientId, conn);
  if (!oc || oc.stage === "accepted") return;
  const e = await engagementRepo.findOpenTerms(clientId, conn);
  if (!e) return;

  const committed = e.status === "accepted" || e.status === "active";
  const samePackage = oc.suggested_package_id === e.package_id && Number(oc.suggested_monthly_fee) === e.monthly_fee;

  if (committed) {
    await repo.syncPackage(oc.id, { packageId: e.package_id, fee: e.monthly_fee, source: oc.package_source && samePackage ? oc.package_source : source, stage: "accepted", acceptedBy: actor.id, acceptedVia: source }, conn);
    const client = await clientRepo.findClientById(clientId, conn);
    if (client?.status === "lead") await clientRepo.updateClient(clientId, { status: "onboarding" }, conn);
    await recordAudit(actor, {
      action: "Onboarding stage changed",
      entityType: "OnboardingCase",
      entityId: oc.id,
      clientId,
      details: `${humanize(oc.stage)} → Accepted: engagement #${e.id} on ${e.package_name} is ${e.status}`,
    }, conn);
    return;
  }

  // An open proposal is the team's offer; the client accepts it rather than picking from the catalogue (see choosePackage).
  if (oc.stage === "proposal_sent") return;
  const nextStage = oc.stage === "registered" || oc.stage === "rejected" ? "assessment" : undefined;
  if (samePackage && !nextStage) return;
  await repo.syncPackage(oc.id, { packageId: e.package_id, fee: e.monthly_fee, source, stage: nextStage }, conn);
  await recordAudit(actor, {
    action: "Onboarding package updated",
    entityType: "OnboardingCase",
    entityId: oc.id,
    clientId,
    details: `${e.package_name} ${source === "client" ? "chosen by the client in the portal" : "set on engagement #" + e.id}${nextStage ? `; ${humanize(oc.stage)} → Assessment` : ""}`,
  }, conn);
}

/**
 * A proposal (or an assessment that suggests a package) must not contradict a commitment the client already has.
 * A draft engagement is fine: accepting the proposal re-points it. Once the engagement has been sent, accepted or
 * activated, a different package goes through a package change on that engagement instead.
 */
export async function assertNoConflictingEngagement(clientId: number, packageId: number | null, conn?: PoolConnection) {
  const e = await engagementRepo.findOpenTerms(clientId, conn);
  if (!e || e.status === "draft") return e;
  if (e.status === "active" || e.status === "accepted") {
    throw AppError.conflict(
      `This client is already on ${e.package_name} (engagement #${e.id}, ${e.status}). There is nothing to propose: change the package from the engagement instead.`,
    );
  }
  if (packageId && packageId !== e.package_id) {
    throw AppError.conflict(
      `The ${e.package_name} agreement (engagement #${e.id}) is already with the client. Change the package from the engagement, or take it back to draft first.`,
    );
  }
  return e;
}
