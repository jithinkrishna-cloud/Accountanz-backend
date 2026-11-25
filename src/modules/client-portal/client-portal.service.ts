import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { deleteFile, openFile, saveFile } from "../../utils/file-storage.js";
import { recordAudit } from "../audit/audit.service.js";
import * as meetingRepo from "../communication/communication.repository.js";
import { editOwnMessage, mentionableFor, messagesWithMentions, resolveMentions } from "../communication/communication.service.js";
import { notifyApprovalDecided, notifyClientMessage, notifyDocumentReceived, notifyMeetingRequested, notifyMentioned } from "../notifications/notification.service.js";
import { setClientSoftware } from "../integrations/integration.repository.js";
import { insertEngagement, updateEngagement as updateEngagementRow } from "../engagements/engagement.repository.js";
import { acceptByClient } from "../onboarding/onboarding.service.js";
import { clientProposal } from "../onboarding/onboarding.repository.js";
import { syncCaseWithEngagement } from "../onboarding/onboarding.sync.js";
import { pendingChangeForClient } from "../package-changes/package-change.repository.js";
import { findPackageById, listPackages } from "../packages/package.repository.js";
import * as repo from "./client-portal.repository.js";
import { NOTIFICATION_PREFS, type ClientContext, type NotificationPrefs } from "./client-portal.types.js";
import type { ApprovalDecisionInput, MeetingRequestInput, NewThreadInput, SettingsInput, UploadMeta } from "./client-portal.validation.js";

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
  const [company, branches, tax_details, stakeholders, financial_profile, service_requirements] = await Promise.all([
    repo.business(ctx.clientId),
    repo.branches(ctx.clientId),
    repo.taxDetails(ctx.clientId),
    repo.stakeholders(ctx.clientId),
    repo.financialProfile(ctx.clientId),
    repo.serviceRequirements(ctx.clientId),
  ]);
  return { ...company, branches, tax_details, stakeholders, financial_profile, service_requirements };
}

export const getTeam = (ctx: ClientContext) => repo.team(ctx.clientId);
export const getSoftware = (ctx: ClientContext) => repo.software(ctx.clientId);

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

// ── Meeting requests: the client asks, the team schedules or declines ──
const MAX_PENDING_REQUESTS = 3;

export const getMeetingRequests = (ctx: ClientContext) => meetingRepo.clientMeetingRequests(ctx.clientId);

export async function requestMeeting(actor: AuthUser, ctx: ClientContext, input: MeetingRequestInput) {
  if ((await meetingRepo.countPendingRequests(ctx.clientId)) >= MAX_PENDING_REQUESTS) {
    throw AppError.conflict(`You already have ${MAX_PENDING_REQUESTS} requests waiting. Your team will reply soon, or withdraw one first.`);
  }
  const preferredTimes = input.preferred_times.map((t) => new Date(t).toISOString()).sort();
  const id = await meetingRepo.insertMeetingRequest({ clientId: ctx.clientId, requestedBy: actor.id, topic: input.topic, notes: input.notes ?? null, preferredTimes, durationMinutes: input.duration_minutes });
  await recordAudit(actor, { action: "Meeting requested", entityType: "MeetingRequest", entityId: id, clientId: ctx.clientId, details: input.topic });
  void notifyMeetingRequested(id);
  return (await meetingRepo.findMeetingRequest(id))!;
}

/** The person who asked, or the owner, can withdraw a request the team hasn't answered yet. */
export async function withdrawMeetingRequest(actor: AuthUser, ctx: ClientContext, id: number) {
  const request = await meetingRepo.findMeetingRequest(id);
  if (!request || request.client_id !== ctx.clientId) throw AppError.notFound("Meeting request");
  if (request.requested_by !== actor.id && ctx.role !== "owner") throw AppError.forbidden("Only the person who asked, or the company owner, can withdraw this");
  if (!(await meetingRepo.closeMeetingRequest(id, { status: "withdrawn", decidedBy: actor.id }))) throw AppError.conflict("Your team has already answered this request");
  await recordAudit(actor, { action: "Meeting request withdrawn", entityType: "MeetingRequest", entityId: id, clientId: ctx.clientId, details: request.topic });
}

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
  return { ...thread, messages: messagesWithMentions(await repo.threadMessages(id)).map((m) => ({ ...m, from_client: Boolean(m.from_client) })) };
}

/** People the client can @mention: their accounting team and their own colleagues (not themselves). */
export async function getMentionable(actor: AuthUser, ctx: ClientContext) {
  return (await mentionableFor(ctx.clientId, "client")).filter((p) => p.user_id !== actor.id).map(({ email: _email, ...p }) => p);
}

export async function startThread(actor: AuthUser, ctx: ClientContext, input: NewThreadInput) {
  const mentioned = await resolveMentions(ctx.clientId, "client", input.mentions, actor.id);
  const { id, messageId } = await withTransaction(async (conn) => {
    const threadId = await repo.insertThread(ctx.clientId, actor.id, input.subject, conn);
    const mid = await repo.insertMessage(threadId, actor.id, input.body, conn);
    await meetingRepo.saveMentions(mid, mentioned.map((p) => p.user_id), conn);
    return { id: threadId, messageId: mid };
  });
  void notifyMentioned({ clientId: ctx.clientId, threadId: id, messageId, authorId: actor.id, author: actor.fullName, subject: input.subject, body: input.body, mentioned });
  void notifyClientMessage(ctx.clientId, { clientName: ctx.clientName, subject: input.subject, body: input.body, author: actor.fullName, threadId: id, skipEmails: mentioned.map((p) => p.email) });
  return getThread(ctx, id);
}

export async function reply(actor: AuthUser, ctx: ClientContext, threadId: number, body: string, mentionIds: number[] = []) {
  const thread = await repo.findThread(ctx.clientId, threadId);
  if (!thread) throw AppError.notFound("Conversation");
  const mentioned = await resolveMentions(ctx.clientId, "client", mentionIds, actor.id);
  const messageId = await withTransaction(async (conn) => {
    const mid = await repo.insertMessage(threadId, actor.id, body, conn);
    await meetingRepo.saveMentions(mid, mentioned.map((p) => p.user_id), conn);
    return mid;
  });
  const subject = thread.subject ?? "Message";
  void notifyMentioned({ clientId: ctx.clientId, threadId, messageId, authorId: actor.id, author: actor.fullName, subject, body, mentioned });
  void notifyClientMessage(ctx.clientId, { clientName: ctx.clientName, subject, body, author: actor.fullName, threadId, messageId, skipEmails: mentioned.map((p) => p.email) });
  return getThread(ctx, threadId);
}

/** The author corrects their own message within the edit window (see editOwnMessage). */
export async function editMessage(actor: AuthUser, ctx: ClientContext, threadId: number, messageId: number, body: string, mentionIds: number[] = []) {
  const thread = await repo.findThread(ctx.clientId, threadId);
  if (!thread) throw AppError.notFound("Conversation");
  await editOwnMessage(actor, { id: thread.id, client_id: ctx.clientId, visibility: "client", subject: thread.subject }, messageId, body, mentionIds);
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
  const [all, current, pending_change] = await Promise.all([listPackages(), repo.openEngagement(ctx.clientId), pendingChangeForClient(ctx.clientId)]);
  return { items: all.filter((p) => p.is_active), current, pending_change };
}

/**
 * The owner picks a package. With no open engagement this opens a draft engagement on it for the Accountanz
 * team to take forward (agreement, activation, first invoice). While the engagement is still a draft the
 * owner can switch package; once it has been sent, a change goes through the team.
 */
// ── Proposal from Accountanz ──
/**
 * The proposal the team sent (until it's accepted), or the accepted one while the company is still onboarding,
 * so the client can see what they agreed to and what happens next.
 */
export async function getProposal(ctx: ClientContext) {
  const p = await clientProposal(ctx.clientId);
  if (!p || (p.stage === "accepted" && ctx.clientStatus !== "onboarding" && ctx.clientStatus !== "lead")) return null;
  const { services, ...rest } = p;
  return { ...rest, monthly_fee: Number(p.monthly_fee), services: services?.split("||") ?? [], can_accept: ctx.role === "owner" && p.stage === "proposal_sent" };
}

export async function acceptProposal(actor: AuthUser, ctx: ClientContext) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can accept the proposal");
  await acceptByClient(actor, ctx.clientId);
  return getProposal({ ...ctx, clientStatus: ctx.clientStatus === "lead" ? "onboarding" : ctx.clientStatus });
}

export async function choosePackage(actor: AuthUser, ctx: ClientContext, packageId: number) {
  if (ctx.role !== "owner") throw AppError.forbidden("Only the company owner can choose a package");
  const proposal = await clientProposal(ctx.clientId);
  if (proposal?.stage === "proposal_sent" && proposal.package_id !== packageId) {
    throw AppError.conflict(`Your team has proposed ${proposal.package_name} for you. Accept it, or message your team if you'd like a different package.`);
  }
  if (proposal?.stage === "proposal_sent") return acceptProposal(actor, ctx).then(() => getPackages(ctx));
  if (ctx.clientStatus === "exited") throw AppError.conflict("Your company has left Accountanz. Contact us to come back.");
  const pkg = await findPackageById(packageId);
  if (!pkg || !pkg.is_active) throw AppError.notFound("Package");

  await withTransaction(async (conn) => {
    const open = await repo.openEngagement(ctx.clientId, conn);
    if (!open) {
      const id = await insertEngagement({ client_id: ctx.clientId, package_id: pkg.id, start_date: null, renewal_date: null }, conn);
      await recordAudit(actor, { action: "Package chosen", entityType: "Engagement", entityId: id, clientId: ctx.clientId, details: `${pkg.name} chosen in the client portal; draft engagement #${id} opened` }, conn);
    } else {
      if (open.package_id === pkg.id) return;
      if (open.status !== "draft") {
        throw AppError.conflict(`Your ${open.package_name} engagement is already ${open.status === "sent" ? "with you for acceptance" : open.status}. Request a package change instead.`);
      }
      await updateEngagementRow(open.id, { package_id: pkg.id }, conn);
      await recordAudit(actor, { action: "Package chosen", entityType: "Engagement", entityId: open.id, clientId: ctx.clientId, details: `Changed from ${open.package_name} to ${pkg.name} in the client portal` }, conn);
    }
    // The onboarding case takes the client's choice, so staff confirm it rather than assessing from scratch.
    await syncCaseWithEngagement(actor, ctx.clientId, "client", conn);
  });
  return getPackages(ctx);
}

/**
 * Everything one accountant does for this company, on one page: who they are, the jobs they do or check (with
 * progress), the documents and approvals they've asked for, conversations they're in and meetings with them.
 * Only people on the company's team today; anyone else is "not found" (no probing other staff).
 */
export async function getMemberOverview(ctx: ClientContext, userId: number) {
  const roles = await repo.memberOnTeam(ctx.clientId, userId);
  if (!roles.length) throw AppError.notFound("Team member");
  const [tasks, requests, approvals, threads, meetings] = await Promise.all([
    repo.memberTasks(ctx.clientId, userId, roles.some((r) => r.team_role === "cfo")),
    repo.memberRequests(ctx.clientId, userId),
    repo.memberApprovals(ctx.clientId, userId),
    repo.memberThreads(ctx.clientId, userId),
    repo.memberMeetings(ctx.clientId, userId),
  ]);
  const { user_id, full_name, email, phone } = roles[0]!;
  const since = roles.map((r) => r.valid_from).sort()[0]!;
  return { member: { user_id, full_name, email, phone, team_roles: roles.map((r) => r.team_role), since }, tasks, requests, approvals, threads, meetings };
}
