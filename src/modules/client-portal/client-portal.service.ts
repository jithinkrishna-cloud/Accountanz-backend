import { env } from "../../config/env.js";
import { pool, withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { encryptSecret } from "../../utils/crypto.js";
import { deleteFile, openFile, saveFile } from "../../utils/file-storage.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyApprovalDecided, notifyClientMessage, notifyDocumentReceived } from "../notifications/notification.service.js";
import { setClientSoftware } from "../integrations/integration.repository.js";
import { journlGateway } from "../integrations/journl.gateway.js";
import { insertEngagement, updateEngagement as updateEngagementRow } from "../engagements/engagement.repository.js";
import { findPackageById, listPackages } from "../packages/package.repository.js";
import * as repo from "./client-portal.repository.js";
import { NOTIFICATION_PREFS, type ClientContext, type NotificationPrefs } from "./client-portal.types.js";
import type { ApprovalDecisionInput, ConnectJournlInput, NewThreadInput, SettingsInput, UploadMeta } from "./client-portal.validation.js";

const currentPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** The client company behind this login, or null when nobody has linked one yet. */
export async function findContext(user: AuthUser): Promise<ClientContext | null> {
  const m = await repo.findMembership(user.id);
  return m ? { userId: user.id, clientId: m.client_id, clientName: m.client_name, clientStatus: m.client_status, role: m.role, canApprove: m.role === "owner" || Boolean(m.can_approve) } : null;
}

export async function requireContext(user: AuthUser): Promise<ClientContext> {
  const ctx = await findContext(user);
  if (!ctx) throw new AppError("NOT_FOUND", "No company linked to your account yet");
  return ctx;
}

export async function getDashboard(ctx: ClientContext) {
  const period = currentPeriod();
  return { period, company: ctx.clientName, ...(await repo.dashboard(ctx.clientId, period)) };
}

export async function getBusiness(ctx: ClientContext) {
  const [company, branches] = await Promise.all([repo.business(ctx.clientId), repo.branches(ctx.clientId)]);
  return { ...company, branches };
}

export const getTeam = (ctx: ClientContext) => repo.team(ctx.clientId);
export const getSoftware = (ctx: ClientContext) => repo.software(ctx.clientId);

/**
 * "Sign in with JournL": the owner signs in with their JournL login, JournL confirms which company they own,
 * and the connection is verified and connected straight away. The password goes to JournL once and is not kept.
 * If the JournL account owns several companies, the owner picks one (company_id) and signs in again.
 */
export async function connectJournl(actor: AuthUser, ctx: ClientContext, input: ConnectJournlInput) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can connect accounting software");

  const result = await journlGateway.signIn(input.journl_email, input.journl_password);
  if (result.kind === "unavailable") throw new AppError("UNAVAILABLE", result.reason);
  if (result.kind === "rejected") {
    throw new AppError("VALIDATION_ERROR", result.reason, result.field ? { fieldErrors: { [result.field]: [result.reason] } } : undefined);
  }

  const org = result.companies.length === 1 ? result.companies[0] : result.companies.find((c) => c.id === input.company_id);
  if (!org) {
    const message = input.company_id ? "That company isn't one of your JournL companies" : "Your JournL account has several companies. Choose the one for this business.";
    throw new AppError("VALIDATION_ERROR", message, {
      fieldErrors: { company_id: [message] },
      companies: result.companies.map((c) => ({ id: c.id, name: c.name })),
    });
  }

  const note = `Confirmed by JournL sign-in as ${result.journlEmail}: company ${org.id} (${org.name})`;
  await withTransaction(async (conn) => {
    const existing = await repo.lockJournlConnection(ctx.clientId, conn);
    // Signing in again while connected refreshes the JournL session; switching to another company needs a disconnect first.
    if (existing?.status === "connected" && existing.external_org_id !== org.id) {
      throw AppError.conflict(`JournL is connected to company ${existing.external_org_id}. Disconnect it before connecting another company.`);
    }
    if (await repo.journlOrgTakenBy(org.id, ctx.clientId, conn)) {
      throw AppError.conflict("This JournL company is already connected to another Accountanz client");
    }
    // Keep JournL's session (encrypted) so Accountanz can read the company's data until it expires; only for this company.
    const session =
      result.session && env.JOURNL_TOKEN_KEY && result.companies.length === 1
        ? { tokenEnc: encryptSecret(result.session.token, env.JOURNL_TOKEN_KEY), expiresAt: result.session.expiresAt }
        : null;
    const id = await repo.saveJournlConnection(ctx.clientId, existing?.id ?? null, org, actor.id, note, session, conn);
    await setClientSoftware(ctx.clientId, "journl", conn);
    const action = existing?.status === "connected" ? "JournL session refreshed" : "JournL connected";
    await recordAudit(actor, { action, entityType: "IntegrationConnection", entityId: id, clientId: ctx.clientId, details: note }, conn);
  });
  return repo.software(ctx.clientId);
}

/** The company owner withdraws Accountanz's access to their JournL organisation. */
export async function disconnectJournl(actor: AuthUser, ctx: ClientContext) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can disconnect accounting software");
  await withTransaction(async (conn) => {
    const existing = await repo.lockJournlConnection(ctx.clientId, conn);
    if (!existing || existing.status === "disconnected") throw AppError.conflict("JournL is not connected for your company");
    await repo.disconnectJournlConnection(existing.id, conn);
    await setClientSoftware(ctx.clientId, "none", conn);
    await recordAudit(actor, { action: "JournL disconnected", entityType: "IntegrationConnection", entityId: existing.id, clientId: ctx.clientId, details: "Disconnected by the company owner" }, conn);
  });
  return repo.software(ctx.clientId);
}
export const getDocuments = (ctx: ClientContext) => repo.listDocuments(ctx.clientId);
export const getRequests = (ctx: ClientContext) => repo.listRequests(ctx.clientId);
export const getReports = (ctx: ClientContext) => repo.listReports(ctx.clientId);
export const getApprovals = (ctx: ClientContext) => repo.listApprovals(ctx.clientId);
export const getThreads = (ctx: ClientContext) => repo.listThreads(ctx.clientId);
export const getMeetings = (ctx: ClientContext) => repo.listMeetings(ctx.clientId);

export async function getTasks(ctx: ClientContext, period?: string) {
  const p = period ?? currentPeriod();
  const [tasks, periods] = await Promise.all([repo.visibleTasks(ctx.clientId, p), repo.taskPeriods(ctx.clientId)]);
  return { period: p, periods: [...new Set([currentPeriod(), ...periods.map((x) => x.period)])], tasks };
}

export async function getBilling(ctx: ClientContext) {
  const [pkg, invoices, payments] = await Promise.all([repo.activePackage(ctx.clientId), repo.invoices(ctx.clientId), repo.payments(ctx.clientId)]);
  const outstanding = invoices.filter((i) => i.status === "issued" || i.status === "overdue").reduce((s, i) => s + (i.total - i.paid), 0);
  return { package: pkg, invoices, payments, outstanding: Math.round(outstanding * 100) / 100 };
}

/**
 * Stores an uploaded file for the company. Uploading against an open request fulfils it and
 * tells the person who asked. The stored file is removed again if the database write fails.
 */
export async function uploadDocument(actor: AuthUser, ctx: ClientContext, meta: UploadMeta, file: Express.Multer.File) {
  const key = await saveFile("documents", file.originalname, file.buffer, file.mimetype);
  try {
    const result = await withTransaction(async (conn) => {
      const request = meta.request_id ? await repo.lockOpenRequest(ctx.clientId, meta.request_id, conn) : null;
      if (meta.request_id && !request) throw new AppError("CONFLICT", "That request is no longer open");
      const id = await repo.insertDocument(
        { clientId: ctx.clientId, requestId: request?.id ?? null, userId: actor.id, category: meta.category, period: meta.period ?? request?.period ?? null, path: key, name: file.originalname, mime: file.mimetype, size: file.size },
        conn,
      );
      if (request) await repo.fulfilRequest(request.id, conn);
      await recordAudit(actor, { action: "Document uploaded", entityType: "Document", entityId: id, clientId: ctx.clientId, details: `${file.originalname}${request ? ` for "${request.description}"` : ""}` }, conn);
      return { id, request };
    });
    if (result.request) void notifyDocumentReceived(result.request.requested_by, { clientName: ctx.clientName, fileName: file.originalname, request: result.request.description, documentId: result.id });
    return { id: result.id, fulfilled_request: result.request?.id ?? null };
  } catch (err) {
    await deleteFile(key);
    throw err;
  }
}

export async function openDocument(ctx: ClientContext, id: number) {
  const doc = await repo.findDocument(ctx.clientId, id);
  if (!doc?.file_path) throw AppError.notFound("Document");
  return { file: await openFile(doc.file_path), name: doc.file_name };
}

export async function openReport(ctx: ClientContext, id: number) {
  const report = await repo.findReport(ctx.clientId, id);
  if (!report?.file_path) throw AppError.notFound("Report file");
  return { file: await openFile(report.file_path), name: report.file_name ?? "report" };
}

/** Only owners, or members allowed to approve, can decide; each request is decided once. */
export async function decideApproval(actor: AuthUser, ctx: ClientContext, id: number, input: ApprovalDecisionInput) {
  if (!ctx.canApprove) throw AppError.forbidden("Only the owner or someone allowed to approve can decide this");
  const approval = await withTransaction(async (conn) => {
    const a = await repo.lockApproval(ctx.clientId, id, conn);
    if (!a) throw AppError.notFound("Approval");
    if (a.status !== "pending") throw AppError.conflict("This has already been decided");
    await repo.decideApproval(id, input.decision, actor.id, input.comment, conn);
    await recordAudit(actor, { action: input.decision === "approved" ? "Approval granted" : "Approval rejected", entityType: "ClientApproval", entityId: id, clientId: ctx.clientId, details: a.subject }, conn);
    return a;
  });
  void notifyApprovalDecided(approval.requested_by, { approvalId: id, subject: approval.subject, clientName: ctx.clientName, decision: input.decision, comment: input.comment, decidedBy: actor.fullName });
}

export async function getThread(ctx: ClientContext, id: number) {
  const thread = await repo.findThread(ctx.clientId, id);
  if (!thread) throw AppError.notFound("Conversation");
  return { ...thread, messages: (await repo.threadMessages(id)).map((m) => ({ ...m, from_client: Boolean(m.from_client) })) };
}

export async function startThread(actor: AuthUser, ctx: ClientContext, input: NewThreadInput) {
  const id = await withTransaction(async (conn) => {
    const threadId = await repo.insertThread(ctx.clientId, actor.id, input.subject, conn);
    await repo.insertMessage(threadId, actor.id, input.body, conn);
    return threadId;
  });
  void notifyClientMessage(ctx.clientId, { clientName: ctx.clientName, subject: input.subject, body: input.body, author: actor.fullName, threadId: id });
  return getThread(ctx, id);
}

export async function reply(actor: AuthUser, ctx: ClientContext, threadId: number, body: string) {
  const thread = await repo.findThread(ctx.clientId, threadId);
  if (!thread) throw AppError.notFound("Conversation");
  const messageId = await repo.insertMessage(threadId, actor.id, body, pool);
  void notifyClientMessage(ctx.clientId, { clientName: ctx.clientName, subject: thread.subject ?? "Message", body, author: actor.fullName, threadId, messageId });
  return getThread(ctx, threadId);
}

const DEFAULT_PREFS: NotificationPrefs = { document_requests: true, approvals: true, reports: true, monthly_summary: true };

export async function getSettings(ctx: ClientContext) {
  const p = (await repo.profile(ctx.userId))!;
  const prefs = Object.fromEntries(NOTIFICATION_PREFS.map((k) => [k, p.notification_prefs?.[k] ?? DEFAULT_PREFS[k]])) as NotificationPrefs;
  return { full_name: p.full_name, email: p.email, phone: p.phone, notification_prefs: prefs, company: ctx.clientName, role: ctx.role, can_approve: ctx.canApprove };
}

export async function updateSettings(ctx: ClientContext, input: SettingsInput) {
  await repo.updateProfile(ctx.userId, input);
  return getSettings(ctx);
}

/** Packages the client can choose from, and the package on their current engagement (if any). */
export async function getPackages(ctx: ClientContext) {
  const [all, current] = await Promise.all([listPackages(), repo.openEngagement(ctx.clientId)]);
  return { items: all.filter((p) => p.is_active), current };
}

/**
 * The owner picks a package. With no open engagement this opens a draft engagement on it for the Accountanz
 * team to take forward (agreement, activation, first invoice). While the engagement is still a draft the
 * owner can switch package; once it has been sent, a change goes through the team.
 */
export async function choosePackage(actor: AuthUser, ctx: ClientContext, packageId: number) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can choose a package");
  if (ctx.clientStatus === "exited") throw AppError.conflict("Your company has left Accountanz. Contact us to come back.");
  const pkg = await findPackageById(packageId);
  if (!pkg || !pkg.is_active) throw AppError.notFound("Package");

  await withTransaction(async (conn) => {
    const open = await repo.openEngagement(ctx.clientId, conn);
    if (!open) {
      const id = await insertEngagement({ client_id: ctx.clientId, package_id: pkg.id, start_date: null, renewal_date: null }, conn);
      await recordAudit(actor, { action: "Package chosen", entityType: "Engagement", entityId: id, clientId: ctx.clientId, details: `${pkg.name} chosen in the client portal; draft engagement #${id} opened` }, conn);
      return;
    }
    if (open.package_id === pkg.id) return;
    if (open.status !== "draft") {
      throw AppError.conflict(`Your ${open.package_name} engagement is already ${open.status === "sent" ? "with you for acceptance" : open.status}. Message your team to change package.`);
    }
    await updateEngagementRow(open.id, { package_id: pkg.id }, conn);
    await recordAudit(actor, { action: "Package chosen", entityType: "Engagement", entityId: open.id, clientId: ctx.clientId, details: `Changed from ${open.package_name} to ${pkg.name} in the client portal` }, conn);
  });
  return getPackages(ctx);
}
