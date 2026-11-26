import { approvalDecidedEmail, approvalRequestedEmail, clientMessageEmail, companyRegisteredEmail, documentRequestedEmail, meetingCancelledEmail, meetingRequestDeclinedEmail, meetingRequestedEmail, meetingScheduledEmail, mentionedEmail, proposalAcceptedEmail, proposalSentEmail, reportPublishedEmail, teamMessageEmail, documentReceivedEmail, sharedWithYouEmail, invoiceIssuedEmail, taskAssignedEmail, taskReviewedEmail, taskSubmittedEmail, correctionDecidedEmail, correctionOutcomeEmail, correctionSubmittedEmail, workspaceSyncIssueEmail } from "../../emails/templates.js";
import { logger } from "../../utils/logger.js";
import { sendMail } from "../../utils/mailer.js";
import { humanize } from "../../utils/format.js";
import { findMeetingRequest } from "../communication/communication.repository.js";
import { findTask } from "../tasks/task.repository.js";
import { events as correctionEvents, findCorrection, listApproverContacts } from "../journl-corrections/correction.repository.js";
import { correctionRef } from "../journl-corrections/correction.types.js";
import * as repo from "./notification.repository.js";

async function safely(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    logger.error({ err, notification: name }, "Notification failed");
  }
}

const taskRef = (t: { title: string; client_name: string; period: string; due_date: string | null }) => ({
  title: t.title,
  clientName: t.client_name,
  period: t.period,
  dueDate: t.due_date,
});

/** One-off task created, or a task handed to a new assignee. Not sent for bulk generation (too noisy). */
export const notifyTaskAssigned = (taskId: number, actor: { id: number; fullName: string }) =>
  safely("task-assigned", async () => {
    const task = await findTask(taskId);
    if (!task?.assignee_id || task.assignee_id === actor.id) return; // no e-mail to yourself
    const assignee = await repo.findActiveContact(task.assignee_id);
    if (!assignee) return;
    const content = taskAssignedEmail({
      assigneeName: assignee.full_name,
      creatorName: actor.fullName,
      task: taskRef(task),
      description: task.description,
      checklistCount: task.checklist.length,
    });
    await sendMail({ to: assignee.email, ...content, idempotencyKey: `task-assigned/${taskId}/${task.assignee_id}` });
  });

/** Assignee submitted: tell the reviewer. */
export const notifyTaskSubmitted = (taskId: number) =>
  safely("task-submitted", async () => {
    const task = await findTask(taskId);
    if (!task || task.status !== "submitted") return;
    const [reviewer, submission] = await Promise.all([repo.findActiveContact(task.reviewer_id), repo.countReviews(taskId).then((n) => n + 1)]);
    if (!reviewer) return;
    const content = taskSubmittedEmail({ reviewerName: reviewer.full_name, assigneeName: task.assignee_name ?? "The assignee", task: taskRef(task) });
    await sendMail({ to: reviewer.email, ...content, idempotencyKey: `task-submitted/${taskId}/${submission}` });
  });

/** Reviewer decided: tell the assignee (with the comments when returned). */
export const notifyTaskReviewed = (taskId: number, review: { decision: "approved" | "returned"; comments: string | null; submissionNumber: number; reviewerName: string }) =>
  safely("task-reviewed", async () => {
    const task = await findTask(taskId);
    const assignee = await repo.findActiveContact(task?.assignee_id ?? null);
    if (!task || !assignee) return;
    const content = taskReviewedEmail({ assigneeName: assignee.full_name, reviewerName: review.reviewerName, decision: review.decision, comments: review.comments, task: taskRef(task) });
    await sendMail({ to: assignee.email, ...content, idempotencyKey: `task-reviewed/${taskId}/${review.submissionNumber}` });
  });

/** New service invoice: tell the client's owners / approvers (if the client has portal users). */
export const notifyInvoiceIssued = (invoiceId: number) =>
  safely("invoice-issued", async () => {
    const invoice = await repo.findInvoiceForEmail(invoiceId);
    if (!invoice) return;
    const contacts = await repo.listBillingContacts(invoice.client_id);
    for (const c of contacts) {
      const content = invoiceIssuedEmail({
        recipientName: c.full_name,
        clientName: invoice.client_name,
        invoiceNumber: invoice.invoice_number,
        period: invoice.period,
        amount: invoice.amount,
        gst: invoice.gst_amount,
        total: invoice.total,
        dueDate: invoice.due_date,
      });
      await sendMail({ to: c.email, ...content, idempotencyKey: `invoice-issued/${invoiceId}/${c.email}` });
    }
  });

/** Client uploaded a file for a request: tell whoever asked for it. */
export const notifyDocumentReceived = (requestedBy: number | null, d: { clientName: string; fileName: string; request: string; documentId: number }) =>
  safely("document-received", async () => {
    const to = await repo.findActiveContact(requestedBy);
    if (!to) return;
    const content = documentReceivedEmail({ recipientName: to.full_name, clientName: d.clientName, fileName: d.fileName, request: d.request });
    await sendMail({ to: to.email, ...content, idempotencyKey: `document-received/${d.documentId}` });
  });

/** A client shared a Document Centre folder or file: tell each accountant newly given access. */
export const notifyShared = (userIds: number[], d: { kind: "folder" | "file"; clientName: string; name: string; sharedBy: string; key: string }) =>
  safely("shared-with-you", async () => {
    for (const userId of userIds) {
      const to = await repo.findActiveContact(userId);
      if (!to) continue;
      const content = sharedWithYouEmail({ recipientName: to.full_name, clientName: d.clientName, kind: d.kind, name: d.name, sharedBy: d.sharedBy });
      await sendMail({ to: to.email, ...content, idempotencyKey: `shared/${d.key}/${userId}/${Date.now()}` });
    }
  });

/** Client decided an approval: tell the person who requested it. */
export const notifyApprovalDecided = (requestedBy: number | null, d: { approvalId: number; subject: string; clientName: string; decision: "approved" | "rejected"; comment: string | null; decidedBy: string }) =>
  safely("approval-decided", async () => {
    const to = await repo.findActiveContact(requestedBy);
    if (!to) return;
    const content = approvalDecidedEmail({ recipientName: to.full_name, clientName: d.clientName, subject: d.subject, decision: d.decision, comment: d.comment, decidedBy: d.decidedBy });
    await sendMail({ to: to.email, ...content, idempotencyKey: `approval-decided/${d.approvalId}` });
  });

/** Client wrote a message: tell the client's accounting team. */
export const notifyClientMessage = (clientId: number, d: { clientName: string; subject: string; body: string; author: string; threadId: number; messageId?: number; skipEmails?: string[] }) =>
  safely("client-message", async () => {
    const team = await repo.listClientTeamContacts(clientId);
    for (const m of team) {
      if (d.skipEmails?.includes(m.email)) continue;
      const content = clientMessageEmail({ recipientName: m.full_name, clientName: d.clientName, author: d.author, subject: d.subject, body: d.body });
      await sendMail({ to: m.email, ...content, idempotencyKey: `client-message/${d.threadId}/${d.messageId ?? "first"}/${m.email}` });
    }
  });

/** Proposal sent: the client's owners receive it (and see it in their portal). */
export const notifyProposalSent = (caseId: number) =>
  safely("proposal-sent", async () => {
    const p = await repo.findProposalForEmail(caseId);
    if (!p) return;
    for (const o of await repo.listOwnerContacts(p.client_id)) {
      const content = proposalSentEmail({ recipientName: o.full_name, company: p.company, packageName: p.package_name, fee: Number(p.fee), billingCycle: p.billing_cycle, services: p.services?.split("||") ?? [], message: p.message, sentBy: p.sent_by });
      await sendMail({ to: o.email, ...content, idempotencyKey: `proposal-sent/${caseId}/${o.email}` });
    }
  });

/** Proposal accepted (in the portal or by staff): admins and the assessor hear, once each. */
export const notifyProposalAccepted = (caseId: number) =>
  safely("proposal-accepted", async () => {
    const p = await repo.findProposalForEmail(caseId);
    if (!p) return;
    const recipients = await repo.listAdminContacts();
    if (p.assessor_email && !recipients.some((r) => r.email === p.assessor_email)) recipients.push({ email: p.assessor_email, full_name: p.assessor_name ?? "there" });
    for (const r of recipients) {
      const content = proposalAcceptedEmail({ recipientName: r.full_name, company: p.company, packageName: p.package_name, fee: Number(p.fee), acceptedBy: p.accepted_by ?? "The client", inPortal: p.accepted_via === "client" });
      await sendMail({ to: r.email, ...content, idempotencyKey: `proposal-accepted/${caseId}/${r.email}` });
    }
  });

/** A company registered itself on the platform: every admin hears so someone picks up the assessment. */
export const notifyCompanyRegistered = (caseId: number) =>
  safely("company-registered", async () => {
    const r = await repo.findRegistrationForEmail(caseId);
    if (!r) return;
    for (const a of await repo.listAdminContacts()) {
      const content = companyRegisteredEmail({ adminName: a.full_name, company: r.company, gstin: r.gstin, state: r.state, ownerName: r.owner_name, ownerEmail: r.owner_email });
      await sendMail({ to: a.email, ...content, idempotencyKey: `company-registered/${caseId}/${a.email}` });
    }
  });

/** An accountant submitted a registration: every admin hears so someone can approve it. */
export const notifyAccountantRegistrationPending = (d: { userId: number; name: string; email: string; role: string }) =>
  safely("accountant-registration-pending", async () => {
    for (const a of await repo.listAdminContacts()) {
      const subject = `Accountant registration pending: ${d.name}`;
      const text = `Hi ${a.full_name},\n\n${d.name} (${d.email}) applied as ${humanize(d.role)}.\nReview and approve in Admin > Accountants.`;
      await sendMail({
        to: a.email,
        subject,
        html: `<p>Hi ${a.full_name},</p><p><strong>${d.name}</strong> (${d.email}) applied as <strong>${humanize(d.role)}</strong>.</p><p>Review and approve in <strong>Admin &gt; Accountants</strong>.</p>`,
        text,
        idempotencyKey: `accountant-registration/${d.userId}/${a.email}`,
      });
    }
  });

// — Staff → client delivery —
export const notifyDocumentRequested = (requestId: number, d: { clientId: number; requester: string; description: string; period: string | null; dueDate: string | null }) =>
  safely("document-requested", async () => {
    const clientName = await repo.findClientName(d.clientId);
    for (const c of await repo.listClientContacts(d.clientId, "document_requests")) {
      const content = documentRequestedEmail({ recipientName: c.full_name, clientName, requester: d.requester, description: d.description, period: d.period, dueDate: d.dueDate });
      await sendMail({ to: c.email, ...content, idempotencyKey: `document-requested/${requestId}/${c.email}` });
    }
  });

export const notifyReportPublished = (reportId: number, d: { clientId: number; reportLabel: string; period: string; summary: string | null }) =>
  safely("report-published", async () => {
    const clientName = await repo.findClientName(d.clientId);
    for (const c of await repo.listClientContacts(d.clientId, "reports")) {
      const content = reportPublishedEmail({ recipientName: c.full_name, clientName, reportLabel: d.reportLabel, period: d.period, summary: d.summary });
      await sendMail({ to: c.email, ...content, idempotencyKey: `report-published/${reportId}/${c.email}` });
    }
  });

export const notifyApprovalRequested = (approvalId: number, d: { clientId: number; requester: string; subject: string; description: string | null }) =>
  safely("approval-requested", async () => {
    const clientName = await repo.findClientName(d.clientId);
    for (const c of await repo.listClientContacts(d.clientId, "approvals", true)) {
      const content = approvalRequestedEmail({ recipientName: c.full_name, clientName, requester: d.requester, subject: d.subject, description: d.description });
      await sendMail({ to: c.email, ...content, idempotencyKey: `approval-requested/${approvalId}/${c.email}` });
    }
  });

/** Invitations go to the meeting's attendees; client and staff attendees get links to their own portal. */
export const notifyMeetingScheduled = (meetingId: number, d: { clientId: number; organiser: string; title: string; when: string; link: string | null; attendees: { email: string; name: string; isClient: boolean }[] }) =>
  safely("meeting-scheduled", async () => {
    const clientName = await repo.findClientName(d.clientId);
    for (const a of d.attendees) {
      const content = meetingScheduledEmail({ recipientName: a.name, clientName, organiser: d.organiser, title: d.title, when: d.when, link: d.link, forClient: a.isClient });
      await sendMail({ to: a.email, ...content, idempotencyKey: `meeting-scheduled/${meetingId}/${a.email}` });
    }
  });

const istTime = (iso: string) => `${new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST`;

/** A client asked for a meeting: their team today hears; if nobody is assigned, the admins do. */
export const notifyMeetingRequested = (requestId: number) =>
  safely("meeting-requested", async () => {
    const r = await findMeetingRequest(requestId);
    if (!r) return;
    const team = await repo.listClientTeamContacts(r.client_id);
    const [recipients, path] = team.length ? [team, "/team/meetings"] : [await repo.listAdminContacts(), "/admin/meetings"];
    for (const m of recipients) {
      const content = meetingRequestedEmail({
        recipientName: m.full_name,
        clientName: r.client_name,
        requester: r.requester ?? "Someone",
        topic: r.topic,
        notes: r.notes,
        times: r.preferred_times.map(istTime),
        durationMinutes: r.duration_minutes,
        path,
      });
      await sendMail({ to: m.email, ...content, idempotencyKey: `meeting-requested/${requestId}/${m.email}` });
    }
  });

/** The team declined a meeting request: the person who asked hears why. */
export const notifyMeetingRequestDeclined = (requestId: number, d: { clientId: number; requestedBy: number | null; topic: string; decidedBy: string; reason: string }) =>
  safely("meeting-request-declined", async () => {
    const to = await repo.findActiveContact(d.requestedBy);
    if (!to) return;
    const content = meetingRequestDeclinedEmail({ recipientName: to.full_name, topic: d.topic, decidedBy: d.decidedBy, reason: d.reason });
    await sendMail({ to: to.email, ...content, idempotencyKey: `meeting-request-declined/${requestId}/${to.email}` });
  });

/** Everyone who was invited (except whoever cancelled) hears that the meeting is off. */
export const notifyMeetingCancelled = (meetingId: number, d: { clientId: number; cancelledBy: string; title: string; when: string; attendees: { email: string; name: string; isClient: boolean }[] }) =>
  safely("meeting-cancelled", async () => {
    const clientName = await repo.findClientName(d.clientId);
    for (const a of d.attendees) {
      const content = meetingCancelledEmail({ recipientName: a.name, clientName, cancelledBy: d.cancelledBy, title: d.title, when: d.when, forClient: a.isClient });
      await sendMail({ to: a.email, ...content, idempotencyKey: `meeting-cancelled/${meetingId}/${a.email}` });
    }
  });

/** Someone was @mentioned: each person mentioned (never the author) gets a "mentioned you" email. */
export const notifyMentioned = (d: { clientId: number; threadId: number; messageId: number; authorId: number; author: string; subject: string; body: string; mentioned: { user_id: number; full_name: string; email: string; kind: "team" | "client" }[] }) =>
  safely("mentioned", async () => {
    if (!d.mentioned.length) return;
    const clientName = await repo.findClientName(d.clientId);
    for (const p of d.mentioned) {
      if (p.user_id === d.authorId) continue;
      const content = mentionedEmail({ recipientName: p.full_name, clientName, author: d.author, subject: d.subject, body: d.body, forClient: p.kind === "client" });
      await sendMail({ to: p.email, ...content, idempotencyKey: `mentioned/${d.messageId}/${p.email}` });
    }
  });

/** Staff wrote in a thread: client threads reach the client's users, internal threads reach the staff involved. */
export const notifyTeamMessage = (d: { clientId: number; threadId: number; messageId: number; authorId: number; author: string; subject: string; body: string; visibility: "client" | "internal"; skipEmails?: string[] }) =>
  safely("team-message", async () => {
    const clientName = await repo.findClientName(d.clientId);
    const forClient = d.visibility === "client";
    const recipients = forClient ? await repo.listClientContacts(d.clientId) : await repo.listThreadStaff(d.clientId, d.threadId);
    for (const r of recipients) {
      if (r.id === d.authorId || d.skipEmails?.includes(r.email)) continue;
      const content = teamMessageEmail({ recipientName: r.full_name, clientName, author: d.author, subject: d.subject, body: d.body, forClient });
      await sendMail({ to: r.email, ...content, idempotencyKey: `team-message/${d.messageId}/${r.email}` });
    }
  });

/** A JournL correction was submitted: its client's reviewers today (finance manager / reviewer / CFO), never the preparer, never ops_admin. */
export const notifyCorrectionSubmitted = (correctionId: number) =>
  safely("correction-submitted", async () => {
    const c = await findCorrection(correctionId);
    if (!c || c.status !== "pending_approval") return;
    const [clientName, preparer, approvers] = await Promise.all([repo.findClientName(c.client_id), repo.findActiveContact(c.initiated_by), listApproverContacts(c.client_id, c.initiated_by)]);
    const submission = (await correctionEvents(correctionId)).filter((e) => e.to_status === "pending_approval").length;
    for (const a of approvers) {
      const content = correctionSubmittedEmail({ recipientName: a.full_name, clientName, clientId: c.client_id, ref: correctionRef(c.id), kind: c.kind, purpose: c.purpose, preparedBy: preparer?.full_name ?? "A team member", reason: c.reason });
      await sendMail({ to: a.email, ...content, idempotencyKey: `correction-submitted/${correctionId}/${submission}/${a.email}` });
    }
  });

/** A reviewer sent a correction back or rejected it: tell the preparer, with the comment. */
export const notifyCorrectionDecided = (correctionId: number) =>
  safely("correction-decided", async () => {
    const c = await findCorrection(correctionId);
    if (!c || (c.status !== "draft" && c.status !== "rejected")) return;
    const last = (await correctionEvents(correctionId)).at(-1);
    if (!last || last.from_status !== "pending_approval") return;
    const [to, decider, clientName] = await Promise.all([repo.findActiveContact(c.initiated_by), repo.findActiveContact(last.actor_id), repo.findClientName(c.client_id)]);
    if (!to) return;
    const content = correctionDecidedEmail({ recipientName: to.full_name, clientName, clientId: c.client_id, ref: correctionRef(c.id), decision: c.status === "rejected" ? "rejected" : "sent_back", decidedBy: decider?.full_name ?? "A reviewer", comment: c.review_comment });
    await sendMail({ to: to.email, ...content, idempotencyKey: `correction-decided/${correctionId}/${last.id}` });
  });

/** An approved correction reached an outcome (posted, refused by JournL, cancelled as stale, or unknown): tell the preparer. Never throws. */
export const notifyCorrectionOutcome = (correctionId: number) =>
  safely("correction-outcome", async () => {
    const c = await findCorrection(correctionId);
    if (!c) return;
    const outcome =
      c.status === "posted" ? "posted"
      : c.status === "unknown" ? "unknown"
      : c.status === "rejected" && c.rejected_by_source === "journl" ? "rejected_by_journl"
      : c.status === "rejected" && c.rejected_by_source === "stale" ? "stale"
      : null;
    if (!outcome) return;
    const last = (await correctionEvents(correctionId)).at(-1);
    if (!last || last.to_status !== c.status) return;
    const [to, clientName] = await Promise.all([repo.findActiveContact(c.initiated_by), repo.findClientName(c.client_id)]);
    if (!to) return;
    const content = correctionOutcomeEmail({ recipientName: to.full_name, clientName, clientId: c.client_id, ref: correctionRef(c.id), outcome, voucherId: c.journl_voucher_id, message: c.journl_message });
    await sendMail({ to: to.email, ...content, idempotencyKey: `correction-outcome/${correctionId}/${last.id}` });
  });

const SYNC_REASON_LABEL = {
  staff_limit: "Staff limit reached",
  role_not_included: "Role not included in the package",
  no_active_package: "No active package",
} as const;

/** Primary-space sync could not add some team members: tell the admins. Never throws. */
export const notifyWorkspaceSyncIssues = (spaceId: number, clientName: string, issues: { userName: string; reason: keyof typeof SYNC_REASON_LABEL }[]) =>
  safely("workspace-sync-issues", async () => {
    if (!issues.length) return;
    const admins = await repo.listAdminContacts();
    const list = issues.map((i) => ({ userName: i.userName, reasonLabel: SYNC_REASON_LABEL[i.reason] }));
    for (const a of admins) {
      const content = workspaceSyncIssueEmail({ recipientName: a.full_name, clientName, issues: list });
      await sendMail({ to: a.email, ...content, idempotencyKey: `workspace-sync-issue/${spaceId}/${issues.map((i) => i.userName).join(",")}/${a.email}` });
    }
  });
