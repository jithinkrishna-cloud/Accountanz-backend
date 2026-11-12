/**
 * Event e-mails. Each function loads what it needs, picks recipients and sends one templated e-mail.
 * They never throw: callers fire them after their transaction commits (`void notifyX(...)`), so a mail
 * problem can't undo or slow down the action. Idempotency keys stop duplicates on retries.
 */
import { approvalDecidedEmail, clientMessageEmail, companyRegisteredEmail, documentReceivedEmail, invoiceIssuedEmail, taskAssignedEmail, taskReviewedEmail, taskSubmittedEmail } from "../../emails/templates.js";
import { logger } from "../../utils/logger.js";
import { sendMail } from "../../utils/mailer.js";
import { findTask } from "../tasks/task.repository.js";
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

/** Client decided an approval: tell the person who requested it. */
export const notifyApprovalDecided = (requestedBy: number | null, d: { approvalId: number; subject: string; clientName: string; decision: "approved" | "rejected"; comment: string | null; decidedBy: string }) =>
  safely("approval-decided", async () => {
    const to = await repo.findActiveContact(requestedBy);
    if (!to) return;
    const content = approvalDecidedEmail({ recipientName: to.full_name, clientName: d.clientName, subject: d.subject, decision: d.decision, comment: d.comment, decidedBy: d.decidedBy });
    await sendMail({ to: to.email, ...content, idempotencyKey: `approval-decided/${d.approvalId}` });
  });

/** Client wrote a message: tell the client's accounting team. */
export const notifyClientMessage = (clientId: number, d: { clientName: string; subject: string; body: string; author: string; threadId: number; messageId?: number }) =>
  safely("client-message", async () => {
    const team = await repo.listClientTeamContacts(clientId);
    for (const m of team) {
      const content = clientMessageEmail({ recipientName: m.full_name, clientName: d.clientName, author: d.author, subject: d.subject, body: d.body });
      await sendMail({ to: m.email, ...content, idempotencyKey: `client-message/${d.threadId}/${d.messageId ?? "first"}/${m.email}` });
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
