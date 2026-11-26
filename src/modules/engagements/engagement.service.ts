import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { deleteFile, openFile, saveFile } from "../../utils/file-storage.js";
import { humanize } from "../../utils/format.js";
import { recordAudit } from "../audit/audit.service.js";
import * as clientRepo from "../clients/client.repository.js";
import { countLiveInvoices, issueInvoice } from "../invoices/invoice.repository.js";
import { notifyInvoiceIssued } from "../notifications/notification.service.js";
import { findPackageById } from "../packages/package.repository.js";
import { syncCaseWithEngagement } from "../onboarding/onboarding.sync.js";
import * as onboardingRepo from "../onboarding/onboarding.repository.js";
import { onEngagementActivated, onEngagementEnded } from "../projects/client-space-hooks.js";
import * as repo from "./engagement.repository.js";
import { ENGAGEMENT_TRANSITIONS } from "./engagement.types.js";
import type { EngagementInput, EngagementListQuery, EngagementUpdateInput, StatusInput } from "./engagement.validation.js";

const fieldError = (field: string, message: string) => new AppError("VALIDATION_ERROR", message, { fieldErrors: { [field]: [message] } });

export async function listEngagements(q: EngagementListQuery) {
  const [page, counts] = await Promise.all([repo.listEngagements(q), repo.statusCounts()]);
  return { ...page, counts };
}

export async function getEngagement(id: number) {
  const row = await repo.findEngagement(id);
  if (!row) throw AppError.notFound("Engagement");
  return row;
}

async function assertActivePackage(packageId: number) {
  const pkg = await findPackageById(packageId);
  if (!pkg || !pkg.is_active) throw fieldError("package_id", "Choose an active package");
  return pkg;
}

export async function createEngagement(actor: AuthUser, input: EngagementInput) {
  const client = await clientRepo.findClientById(input.client_id);
  if (!client) throw fieldError("client_id", "Choose a client");
  if (client.status === "exited") throw fieldError("client_id", "This client has exited; reactivate it first");
  const pkg = await assertActivePackage(input.package_id);

  const id = await withTransaction(async (conn) => {
    const open = await repo.findOpenEngagement(input.client_id, conn);
    if (open) throw AppError.conflict(`This client already has an open engagement (#${open.id}, ${open.status}). End it before starting another.`);
    // An open proposal is the offer on the table: an engagement on another package would contradict it.
    const oc = await onboardingRepo.lockLatestCaseForClient(input.client_id, conn);
    if (oc?.stage === "proposal_sent" && oc.suggested_package_id !== input.package_id) {
      throw AppError.conflict("A proposal for a different package is waiting for this client. Take it back to assessment from Onboarding first, or wait for them to accept it.");
    }
    const newId = await repo.insertEngagement(input, conn);
    await recordAudit(actor, { action: "Engagement created", entityType: "Engagement", entityId: newId, clientId: input.client_id, details: `${client.legal_name} on ${pkg.name}` }, conn);
    await syncCaseWithEngagement(actor, input.client_id, "team", conn);
    return newId;
  });
  return getEngagement(id);
}

/** Dates can change until the engagement ends; the package only while it is still a draft. */
export async function updateEngagement(actor: AuthUser, id: number, input: EngagementUpdateInput) {
  if (input.package_id) await assertActivePackage(input.package_id);
  await withTransaction(async (conn) => {
    const e = await repo.lockEngagement(id, conn);
    if (!e) throw AppError.notFound("Engagement");
    if (e.status === "ended") throw AppError.conflict("An ended engagement can't be changed");
    if (input.package_id && input.package_id !== e.package_id && e.status !== "draft") {
      throw fieldError("package_id", "Once sent, the package changes through “Change package”");
    }
    await repo.updateEngagement(id, input, conn);
    await recordAudit(actor, { action: "Engagement updated", entityType: "Engagement", entityId: id, clientId: e.client_id, details: Object.keys(input).map(humanize).join(", ").toLowerCase() }, conn);
    if (input.package_id && input.package_id !== e.package_id) await syncCaseWithEngagement(actor, e.client_id, "team", conn);
  });
  return getEngagement(id);
}

/**
 * Moves an engagement through draft → sent → accepted → active → ended.
 * Activation needs the signed agreement, makes the client active and issues the first invoice
 * (package fee + GST) in the same transaction.
 */
export async function changeStatus(actor: AuthUser, id: number, input: StatusInput) {
  const issued = await withTransaction(async (conn) => {
    const e = await repo.lockEngagement(id, conn);
    if (!e) throw AppError.notFound("Engagement");
    if (!ENGAGEMENT_TRANSITIONS[e.status].includes(input.to)) {
      throw AppError.conflict(`An engagement can't move from ${humanize(e.status)} to ${humanize(input.to)}`);
    }

    let invoice: Awaited<ReturnType<typeof issueInvoice>> | null = null;
    if (input.to === "active") {
      if (!e.agreement_file_path) throw AppError.conflict("Upload the signed agreement before activating");
      const otherOpen = await repo.findOpenEngagement(e.client_id, conn, e.id);
      if (otherOpen?.status === "active") throw AppError.conflict(`This client already has an active engagement (#${otherOpen.id})`);
      const client = await clientRepo.findClientById(e.client_id, conn);
      if (client && (client.status === "lead" || client.status === "onboarding")) {
        await clientRepo.updateClient(e.client_id, { status: "active" }, conn);
      }
      if ((await countLiveInvoices(e.id, conn)) === 0) invoice = await issueInvoice(e.id, conn);
    }

    await repo.setStatus(id, input.to, conn);
    if (input.to === "active") await onEngagementActivated(actor, e.client_id, conn);
    // Only an engagement that was live owns the primary space; ending a draft/sent/accepted one leaves it alone.
    else if (input.to === "ended" && e.status === "active") await onEngagementEnded(actor, e.client_id, conn);
    await recordAudit(actor, { action: "Engagement status changed", entityType: "Engagement", entityId: id, clientId: e.client_id, details: `${humanize(e.status)} → ${humanize(input.to)}` }, conn);
    // Accepted or active on the engagement means accepted in onboarding too.
    if (input.to === "accepted" || input.to === "active") await syncCaseWithEngagement(actor, e.client_id, "team", conn);
    if (invoice) {
      await recordAudit(
        actor,
        { action: "Invoice issued", entityType: "ServiceInvoice", entityId: invoice.id, clientId: e.client_id, details: `${invoice.invoice_number} for ${invoice.period}: ${invoice.total} incl. GST (first invoice on activation)` },
        conn,
      );
    }
    return invoice;
  });
  if (issued) void notifyInvoiceIssued(issued.id);
  return { engagement: await getEngagement(id), invoice: issued };
}

export async function uploadAgreement(actor: AuthUser, id: number, file: Express.Multer.File) {
  const stored = await saveFile("agreements", file.originalname, file.buffer, file.mimetype);
  const fileName = file.originalname.slice(0, 255);
  let replaced: string | null = null;
  try {
    await withTransaction(async (conn) => {
      const e = await repo.lockEngagement(id, conn);
      if (!e) throw AppError.notFound("Engagement");
      if (e.status === "ended") throw AppError.conflict("An ended engagement can't take a new agreement");
      replaced = e.agreement_file_path;
      await repo.setAgreement(id, stored, fileName, actor.id, conn);
      await recordAudit(actor, { action: "Agreement uploaded", entityType: "Engagement", entityId: id, clientId: e.client_id, details: fileName }, conn);
    });
  } catch (err) {
    await deleteFile(stored);
    throw err;
  }
  await deleteFile(replaced);
  return getEngagement(id);
}

export async function agreementDownload(id: number) {
  const row = await repo.findAgreement(id);
  if (!row) throw AppError.notFound("Engagement");
  if (!row.agreement_file_path) throw AppError.notFound("Agreement");
  return { file: await openFile(row.agreement_file_path), name: row.agreement_file_name ?? "agreement" };
}
