import { pool, withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { deleteFile, openFile, saveFile } from "../../utils/file-storage.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyApprovalDecided, notifyClientMessage, notifyDocumentReceived } from "../notifications/notification.service.js";
import * as repo from "./client-portal.repository.js";
import { NOTIFICATION_PREFS, type ClientContext, type NotificationPrefs } from "./client-portal.types.js";
import type { ApprovalDecisionInput, NewThreadInput, SettingsInput, UploadMeta } from "./client-portal.validation.js";

const currentPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** The client company behind this login, or null when nobody has linked one yet. */
export async function findContext(user: AuthUser): Promise<ClientContext | null> {
  const m = await repo.findMembership(user.id);
  return m ? { userId: user.id, clientId: m.client_id, clientName: m.client_name, role: m.role, canApprove: m.role === "owner" || Boolean(m.can_approve) } : null;
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
