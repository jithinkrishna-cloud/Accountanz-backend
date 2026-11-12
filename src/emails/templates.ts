/**
 * Transactional e-mail templates. Each returns subject + HTML + plain text from typed data;
 * every value is escaped by the layout helpers.
 */
import { env } from "../config/env.js";
import { button, facts, layout, paragraph, plainText, quote, type EmailContent } from "./layout.js";

const appUrl = (path: string) => `${env.APP_URL}${path}`;

const formatPeriod = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return y && m ? new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }) : period;
};
const formatDate = (iso: string | null) => (iso ? iso.split("-").reverse().join("-") : null);
const inr = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

// ───────────────────────────── Accounts ─────────────────────────────

export function inviteEmail(d: { inviteeName: string; inviterName: string; roleLabel: string; url: string; validDays: number }): EmailContent {
  const title = "You're invited to Accountanz";
  return {
    subject: `${d.inviterName} invited you to Accountanz`,
    html: layout({
      title,
      preheader: `Set your password to join as ${d.roleLabel}.`,
      body:
        paragraph(`Hi ${d.inviteeName},`) +
        paragraph(`${d.inviterName} has invited you to Accountanz as ${d.roleLabel}. Choose a password to activate your account.`) +
        button("Set your password", d.url) +
        paragraph(`This link works once and expires in ${d.validDays} days. If it has expired, ask your administrator for a new one.`),
    }),
    text: plainText(`Hi ${d.inviteeName},`, `${d.inviterName} has invited you to Accountanz as ${d.roleLabel}.`, `Set your password: ${d.url}`, `The link works once and expires in ${d.validDays} days.`),
  };
}

export function passwordResetEmail(d: { name: string; url: string; validMinutes: number }): EmailContent {
  return {
    subject: "Reset your Accountanz password",
    html: layout({
      title: "Reset your password",
      preheader: "Use this link to choose a new password.",
      body:
        paragraph(`Hi ${d.name},`) +
        paragraph("We received a request to reset your Accountanz password.") +
        button("Choose a new password", d.url) +
        paragraph(`The link expires in ${d.validMinutes} minutes. If you didn't ask for this, you can ignore this email; your password stays the same.`),
    }),
    text: plainText(`Hi ${d.name},`, "We received a request to reset your Accountanz password.", `Choose a new password: ${d.url}`, `The link expires in ${d.validMinutes} minutes. If you didn't ask for this, ignore this email.`),
  };
}

export function passwordChangedEmail(d: { name: string; kind: "reset" | "activated" }): EmailContent {
  const activated = d.kind === "activated";
  const title = activated ? "Your account is ready" : "Your password was changed";
  const line = activated
    ? "Your Accountanz account is active. You can sign in with the password you just chose."
    : "Your Accountanz password was just changed and you've been signed out of other devices.";
  return {
    subject: activated ? "Welcome to Accountanz" : "Your Accountanz password was changed",
    html: layout({
      title,
      preheader: line,
      body:
        paragraph(`Hi ${d.name},`) +
        paragraph(line) +
        button("Sign in", appUrl("/login")) +
        (activated ? "" : paragraph("If this wasn't you, reset your password straight away and tell your administrator.")),
    }),
    text: plainText(`Hi ${d.name},`, line, `Sign in: ${appUrl("/login")}`, !activated && "If this wasn't you, reset your password and tell your administrator."),
  };
}

// ───────────────────────────── Tasks ─────────────────────────────

interface TaskRef {
  title: string;
  clientName: string;
  period: string;
  dueDate: string | null;
}

const taskFacts = (t: TaskRef, extra: [string, string | null][] = []) =>
  facts([["Client", t.clientName], ["Period", formatPeriod(t.period)], ["Due", formatDate(t.dueDate)], ...extra]);

export function taskAssignedEmail(d: { assigneeName: string; creatorName: string; task: TaskRef; description: string | null; checklistCount: number }): EmailContent {
  return {
    subject: `New task: ${d.task.title} (${d.task.clientName})`,
    html: layout({
      title: "A task was assigned to you",
      preheader: `${d.task.title} for ${d.task.clientName}, due ${formatDate(d.task.dueDate) ?? "soon"}.`,
      body:
        paragraph(`Hi ${d.assigneeName},`) +
        paragraph(`${d.creatorName} assigned you a task: ${d.task.title}.`) +
        taskFacts(d.task, [["Checklist", `${d.checklistCount} point(s)`]]) +
        (d.description ? quote(d.description) : "") +
        button("Open My Tasks", appUrl("/team/tasks")),
    }),
    text: plainText(`Hi ${d.assigneeName},`, `${d.creatorName} assigned you a task: ${d.task.title} (${d.task.clientName}, ${formatPeriod(d.task.period)}, due ${formatDate(d.task.dueDate) ?? "—"}).`, d.description, `Open My Tasks: ${appUrl("/team/tasks")}`),
  };
}

export function taskSubmittedEmail(d: { reviewerName: string; assigneeName: string; task: TaskRef }): EmailContent {
  return {
    subject: `Ready for review: ${d.task.title} (${d.task.clientName})`,
    html: layout({
      title: "A task is waiting for your review",
      preheader: `${d.assigneeName} submitted ${d.task.title}.`,
      body:
        paragraph(`Hi ${d.reviewerName},`) +
        paragraph(`${d.assigneeName} submitted ${d.task.title} for review.`) +
        taskFacts(d.task) +
        button("Open Review Queue", appUrl("/team/reviews")),
    }),
    text: plainText(`Hi ${d.reviewerName},`, `${d.assigneeName} submitted ${d.task.title} (${d.task.clientName}, ${formatPeriod(d.task.period)}) for review.`, `Open Review Queue: ${appUrl("/team/reviews")}`),
  };
}

export function taskReviewedEmail(d: { assigneeName: string; reviewerName: string; decision: "approved" | "returned"; comments: string | null; task: TaskRef }): EmailContent {
  const returned = d.decision === "returned";
  return {
    subject: returned ? `Returned for correction: ${d.task.title}` : `Approved: ${d.task.title}`,
    html: layout({
      title: returned ? "A task was returned to you" : "Your task was approved",
      preheader: returned ? `${d.reviewerName} asked for changes on ${d.task.title}.` : `${d.reviewerName} approved ${d.task.title}.`,
      body:
        paragraph(`Hi ${d.assigneeName},`) +
        paragraph(returned ? `${d.reviewerName} returned ${d.task.title} for correction.` : `${d.reviewerName} approved ${d.task.title}. Nice work.`) +
        taskFacts(d.task) +
        (d.comments ? quote(d.comments) : "") +
        (returned ? button("Fix and resubmit", appUrl("/team/tasks")) : ""),
    }),
    text: plainText(
      `Hi ${d.assigneeName},`,
      returned ? `${d.reviewerName} returned ${d.task.title} (${d.task.clientName}) for correction.` : `${d.reviewerName} approved ${d.task.title} (${d.task.clientName}).`,
      d.comments && `Comments: ${d.comments}`,
      returned && `Open My Tasks: ${appUrl("/team/tasks")}`,
    ),
  };
}

// ───────────────────────────── Billing ─────────────────────────────

export function invoiceIssuedEmail(d: { recipientName: string; clientName: string; invoiceNumber: string; period: string; amount: number; gst: number; total: number; dueDate: string }): EmailContent {
  return {
    subject: `Invoice ${d.invoiceNumber} from Accountanz · ${inr(d.total)}`,
    html: layout({
      title: `Invoice ${d.invoiceNumber}`,
      preheader: `${inr(d.total)} for ${formatPeriod(d.period)}, due ${formatDate(d.dueDate)}.`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`Here is your Accountanz service invoice for ${d.clientName}.`) +
        facts([
          ["Invoice", d.invoiceNumber],
          ["Period", formatPeriod(d.period)],
          ["Package fee", inr(d.amount)],
          ["GST", inr(d.gst)],
          ["Total due", inr(d.total)],
          ["Due date", formatDate(d.dueDate)],
        ]) +
        button("View billing", appUrl("/app/billing")),
    }),
    text: plainText(
      `Hi ${d.recipientName},`,
      `Invoice ${d.invoiceNumber} for ${d.clientName}, ${formatPeriod(d.period)}: package fee ${inr(d.amount)} + GST ${inr(d.gst)} = ${inr(d.total)}, due ${formatDate(d.dueDate)}.`,
      `View billing: ${appUrl("/app/billing")}`,
    ),
  };
}

// ───────────────────────────── Client portal ─────────────────────────────

export function documentReceivedEmail(d: { recipientName: string; clientName: string; fileName: string; request: string }): EmailContent {
  return {
    subject: `Document received from ${d.clientName}: ${d.fileName}`,
    html: layout({
      title: "A client sent the document you asked for",
      preheader: `${d.clientName} uploaded ${d.fileName}.`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.clientName} uploaded a file for your request, and the request is now marked fulfilled.`) +
        facts([["Client", d.clientName], ["Request", d.request], ["File", d.fileName]]) +
        button("Open Document Centre", appUrl("/admin/documents")),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.clientName} uploaded ${d.fileName} for "${d.request}".`, `Open Document Centre: ${appUrl("/admin/documents")}`),
  };
}

export function approvalDecidedEmail(d: { recipientName: string; clientName: string; subject: string; decision: "approved" | "rejected"; comment: string | null; decidedBy: string }): EmailContent {
  const approved = d.decision === "approved";
  return {
    subject: `${approved ? "Approved" : "Rejected"} by ${d.clientName}: ${d.subject}`,
    html: layout({
      title: approved ? "The client approved your request" : "The client rejected your request",
      preheader: `${d.decidedBy} ${d.decision} "${d.subject}".`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.decidedBy} at ${d.clientName} ${d.decision} "${d.subject}".`) +
        (d.comment ? quote(d.comment) : ""),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.decidedBy} at ${d.clientName} ${d.decision} "${d.subject}".`, d.comment && `Comment: ${d.comment}`),
  };
}

export function clientMessageEmail(d: { recipientName: string; clientName: string; author: string; subject: string; body: string }): EmailContent {
  return {
    subject: `New message from ${d.clientName}: ${d.subject}`,
    html: layout({
      title: `Message from ${d.clientName}`,
      preheader: `${d.author}: ${d.body.slice(0, 90)}`,
      body: paragraph(`Hi ${d.recipientName},`) + paragraph(`${d.author} from ${d.clientName} wrote about "${d.subject}":`) + quote(d.body),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.author} from ${d.clientName} wrote about "${d.subject}":`, d.body),
  };
}
