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

/** A client shared a Document Centre folder or a single file with an accountant. */
export function sharedWithYouEmail(d: { recipientName: string; clientName: string; kind: "folder" | "file"; name: string; sharedBy: string }): EmailContent {
  const what = d.kind === "folder" ? "a folder" : "a file";
  return {
    subject: `${d.clientName} shared ${what} with you: ${d.name}`,
    html: layout({
      title: `A client shared ${what} with you`,
      preheader: `${d.sharedBy} shared "${d.name}".`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.sharedBy} at ${d.clientName} shared ${what} with you. ${d.kind === "folder" ? "You can now open it and every file and subfolder in it." : "You can now open it."}`) +
        facts([["Client", d.clientName], [d.kind === "folder" ? "Folder" : "File", d.name], ["Shared by", d.sharedBy]]) +
        button("Open Document Centre", appUrl("/team/documents")),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.sharedBy} at ${d.clientName} shared the ${d.kind} "${d.name}" with you.`, `Open Document Centre: ${appUrl("/team/documents")}`),
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

export function companyRegisteredEmail(d: { adminName: string; company: string; gstin: string | null; state: string | null; ownerName: string; ownerEmail: string }): EmailContent {
  const url = appUrl("/admin/onboarding");
  return {
    subject: `New company registered: ${d.company}`,
    html: layout({
      title: "A new company joined Accountanz",
      preheader: `${d.ownerName} registered ${d.company}. It's waiting in Onboarding.`,
      body:
        paragraph(`Hi ${d.adminName},`) +
        paragraph(`${d.ownerName} registered ${d.company} on the platform. It is a new prospect at the Registered stage, ready for assessment.`) +
        facts([["Company", d.company], ["GSTIN", d.gstin], ["State", d.state], ["Owner", `${d.ownerName} (${d.ownerEmail})`]]) +
        button("Open Onboarding", url),
    }),
    text: plainText(`Hi ${d.adminName},`, `${d.ownerName} (${d.ownerEmail}) registered ${d.company} on the platform. It is waiting at the Registered stage.`, `Open Onboarding: ${url}`),
  };
}

// ── Staff → client delivery ──
export function documentRequestedEmail(d: { recipientName: string; clientName: string; requester: string; description: string; period: string | null; dueDate: string | null }): EmailContent {
  const url = appUrl("/app/requests");
  return {
    subject: `Document needed: ${d.description}`,
    html: layout({
      title: "Your accounting team needs a document",
      preheader: `${d.requester} asked for: ${d.description}`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.requester} needs the following from ${d.clientName}:`) +
        quote(d.description) +
        facts([["Period", d.period ? formatPeriod(d.period) : null], ["Needed by", d.dueDate]]) +
        button("Upload in the portal", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.requester} needs the following from ${d.clientName}: ${d.description}`, d.dueDate ? `Needed by ${d.dueDate}.` : "", `Upload: ${url}`),
  };
}

export function reportPublishedEmail(d: { recipientName: string; clientName: string; reportLabel: string; period: string; summary: string | null }): EmailContent {
  const url = appUrl("/app/reports");
  const title = `${d.reportLabel} for ${formatPeriod(d.period)}`;
  return {
    subject: `New report: ${title}`,
    html: layout({
      title: "A new report is ready",
      preheader: `${title} is published for ${d.clientName}.`,
      body: paragraph(`Hi ${d.recipientName},`) + paragraph(`Your ${title} is ready in the client portal.`) + (d.summary ? quote(d.summary) : "") + button("View report", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `Your ${title} is ready.`, d.summary ?? "", `View: ${url}`),
  };
}

export function approvalRequestedEmail(d: { recipientName: string; clientName: string; requester: string; subject: string; description: string | null }): EmailContent {
  const url = appUrl("/app/approvals");
  return {
    subject: `Approval needed: ${d.subject}`,
    html: layout({
      title: "Your approval is needed",
      preheader: `${d.requester} is asking ${d.clientName} to approve: ${d.subject}`,
      body: paragraph(`Hi ${d.recipientName},`) + paragraph(`${d.requester} is asking you to approve "${d.subject}".`) + (d.description ? quote(d.description) : "") + button("Review and decide", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.requester} is asking you to approve "${d.subject}".`, d.description ?? "", `Decide: ${url}`),
  };
}

export function meetingScheduledEmail(d: { recipientName: string; clientName: string; organiser: string; title: string; when: string; link: string | null; forClient: boolean }): EmailContent {
  const url = appUrl(d.forClient ? "/app/meetings" : "/team/meetings");
  return {
    subject: `Meeting scheduled: ${d.title} (${d.when})`,
    html: layout({
      title: "A meeting has been scheduled",
      preheader: `${d.title} on ${d.when}`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.organiser} scheduled a meeting${d.forClient ? "" : ` with ${d.clientName}`}.`) +
        facts([["Meeting", d.title], ["When", d.when], ["Join link", d.link]]) +
        button("View meetings", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.organiser} scheduled "${d.title}" on ${d.when}.`, d.link ? `Join: ${d.link}` : "", `Meetings: ${url}`),
  };
}

export function meetingCancelledEmail(d: { recipientName: string; clientName: string; cancelledBy: string; title: string; when: string; forClient: boolean }): EmailContent {
  const url = appUrl(d.forClient ? "/app/meetings" : "/team/meetings");
  return {
    subject: `Meeting cancelled: ${d.title} (${d.when})`,
    html: layout({
      title: "A meeting has been cancelled",
      preheader: `${d.title} on ${d.when} is cancelled`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.cancelledBy} cancelled this meeting${d.forClient ? "" : ` with ${d.clientName}`}.`) +
        facts([["Meeting", d.title], ["Was scheduled for", d.when]]) +
        button("View meetings", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.cancelledBy} cancelled "${d.title}" (${d.when}).`, `Meetings: ${url}`),
  };
}

/** A client asked for a meeting: to their accounting team (or admins when no team is assigned). */
export function meetingRequestedEmail(d: { recipientName: string; clientName: string; requester: string; topic: string; notes: string | null; times: string[]; durationMinutes: number; path: string }): EmailContent {
  const url = appUrl(d.path);
  return {
    subject: `Meeting request from ${d.clientName}: ${d.topic}`,
    html: layout({
      title: `${d.clientName} would like a meeting`,
      preheader: `${d.requester} asked to discuss ${d.topic}`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.requester} from ${d.clientName} asked for a ${d.durationMinutes}-minute meeting. Schedule it or reply with a reason from Meetings.`) +
        facts([["Topic", d.topic], ...d.times.map((t, i): [string, string] => [`Preferred time ${i + 1}`, t])]) +
        (d.notes ? quote(d.notes) : "") +
        button("Open meeting requests", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.requester} from ${d.clientName} asked for a ${d.durationMinutes}-minute meeting about "${d.topic}".`, `Preferred times: ${d.times.join("; ")}`, d.notes ?? "", `Meetings: ${url}`),
  };
}

/** The team declined a client's meeting request: to the person who asked. */
export function meetingRequestDeclinedEmail(d: { recipientName: string; topic: string; decidedBy: string; reason: string }): EmailContent {
  const url = appUrl("/app/meetings");
  return {
    subject: `About your meeting request: ${d.topic}`,
    html: layout({
      title: "About your meeting request",
      preheader: `${d.decidedBy} replied to your request`,
      body: paragraph(`Hi ${d.recipientName},`) + paragraph(`${d.decidedBy} couldn't schedule the meeting you asked for about "${d.topic}":`) + quote(d.reason) + button("View meetings", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.decidedBy} couldn't schedule the meeting you asked for about "${d.topic}":`, d.reason, `Meetings: ${url}`),
  };
}

/** The team sent a proposal: to the client's owner(s). */
export function proposalSentEmail(d: { recipientName: string; company: string; packageName: string; fee: number; billingCycle: string; services: string[]; message: string | null; sentBy: string | null }): EmailContent {
  const url = appUrl("/app/dashboard");
  const fee = `${inr(d.fee)} per ${d.billingCycle === "monthly" ? "month" : d.billingCycle === "quarterly" ? "quarter" : "year"} + GST`;
  return {
    subject: `Your Accountanz proposal: ${d.packageName}`,
    html: layout({
      title: "Your proposal is ready",
      preheader: `${d.packageName} for ${d.company}: ${fee}`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`Based on our review of ${d.company}, we recommend the ${d.packageName} package.`) +
        facts([["Package", d.packageName], ["Fee", fee], ["Includes", d.services.join(", ") || null]]) +
        (d.message ? paragraph(`A note from ${d.sentBy ?? "your Accountanz team"}:`) + quote(d.message) : "") +
        paragraph("Review it in your portal and accept it there, or reply with any questions.") +
        button("View your proposal", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `We recommend the ${d.packageName} package for ${d.company}: ${fee}.`, d.services.length ? `Includes: ${d.services.join(", ")}` : "", d.message ?? "", `View and accept it: ${url}`),
  };
}

/** A proposal was accepted: to admins and whoever assessed the prospect. */
export function proposalAcceptedEmail(d: { recipientName: string; company: string; packageName: string; fee: number; acceptedBy: string; inPortal: boolean }): EmailContent {
  const url = appUrl("/admin/engagements");
  return {
    subject: `Proposal accepted: ${d.company} (${d.packageName})`,
    html: layout({
      title: `${d.company} accepted their proposal`,
      preheader: `${d.acceptedBy} accepted ${d.packageName}`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.acceptedBy} accepted the ${d.packageName} proposal${d.inPortal ? " in the client portal" : ""}. The engagement is ready: upload the signed agreement, then activate.`) +
        facts([["Company", d.company], ["Package", d.packageName], ["Monthly fee", `${inr(d.fee)} + GST`]]) +
        button("Open engagements", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.acceptedBy} accepted the ${d.packageName} proposal for ${d.company}.`, `Engagements: ${url}`),
  };
}

/** Someone @mentioned the recipient in a conversation. */
export function mentionedEmail(d: { recipientName: string; clientName: string; author: string; subject: string; body: string; forClient: boolean }): EmailContent {
  const url = appUrl(d.forClient ? "/app/messages" : "/team/messages");
  return {
    subject: `${d.author} mentioned you: ${d.subject}`,
    html: layout({
      title: `${d.author} mentioned you`,
      preheader: `${d.author}: ${d.body.slice(0, 90)}`,
      body: paragraph(`Hi ${d.recipientName},`) + paragraph(`${d.author} mentioned you in "${d.subject}"${d.forClient ? "" : ` (${d.clientName})`}:`) + quote(d.body) + button("Open conversation", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.author} mentioned you in "${d.subject}":`, d.body, `Open: ${url}`),
  };
}

/** A staff member wrote in a thread: to the client (client threads) or to colleagues (internal threads). */
export function teamMessageEmail(d: { recipientName: string; clientName: string; author: string; subject: string; body: string; forClient: boolean }): EmailContent {
  const url = appUrl(d.forClient ? "/app/messages" : "/team/messages");
  return {
    subject: d.forClient ? `New message from your accounting team: ${d.subject}` : `[Internal] ${d.clientName}: ${d.subject}`,
    html: layout({
      title: d.forClient ? "New message from your accounting team" : `Internal note on ${d.clientName}`,
      preheader: `${d.author}: ${d.body.slice(0, 90)}`,
      body: paragraph(`Hi ${d.recipientName},`) + paragraph(`${d.author} wrote about "${d.subject}":`) + quote(d.body) + button("Open conversation", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.author} wrote about "${d.subject}":`, d.body, `Open: ${url}`),
  };
}

/** A client asked for a specific accountant from the portal's Explore section: to the admins. */
export function accountantRequestedEmail(d: { recipientName: string; clientName: string; requester: string; accountant: string; kind: string; message: string; preferredStart: string | null }): EmailContent {
  const url = appUrl("/admin/accountant-requests");
  return {
    subject: `${d.clientName} asked for ${d.accountant}`,
    html: layout({
      title: `${d.clientName} asked for an accountant`,
      preheader: `${d.requester} would like ${d.accountant}`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.requester} from ${d.clientName} asked for ${d.accountant}. Approve or decline it from Accountant Requests.`) +
        facts([["Accountant", d.accountant], ["Request", d.kind], ["Preferred start", formatDate(d.preferredStart) ?? "Not given"]]) +
        quote(d.message) +
        button("Open accountant requests", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.requester} from ${d.clientName} asked for ${d.accountant} (${d.kind}).`, d.message, `Accountant Requests: ${url}`),
  };
}

/** Accountanz approved or declined a client's accountant request: to the person who asked. */
export function accountantRequestDecidedEmail(d: { recipientName: string; accountant: string; decision: "approved" | "declined"; note: string | null; decidedBy: string; replaces?: string | null; handedOver?: boolean }): EmailContent {
  const url = appUrl("/app/explore");
  const approved = d.decision === "approved";
  const approvedText = d.replaces
    ? d.handedOver
      ? `${d.decidedBy} approved your request. ${d.accountant} has taken over from ${d.replaces} on your accounting team.`
      : `${d.decidedBy} approved your request. We'll hand ${d.replaces}'s work over to ${d.accountant} and let you know when they start.`
    : `${d.decidedBy} approved your request. We'll add ${d.accountant} to your accounting team and let you know when they start.`;
  return {
    subject: approved ? `Your request for ${d.accountant} was approved` : `About your request for ${d.accountant}`,
    html: layout({
      title: approved ? `${d.accountant} is coming on board` : `About your request for ${d.accountant}`,
      preheader: `${d.decidedBy} replied to your request`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(approved ? approvedText : `${d.decidedBy} couldn't arrange ${d.accountant} this time.`) +
        (d.note ? quote(d.note) : "") +
        button("Open Explore", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, approved ? approvedText : `Your request for ${d.accountant} was declined.`, d.note ?? "", `Explore: ${url}`),
  };
}

/**
 * An accountant's assignment on a client ended (e.g. handed over to someone else). Deliberately states only that it
 * ended: no reason, and nothing the client wrote.
 */
export function assignmentEndedEmail(d: { recipientName: string; clientName: string; role: string; endedOn: string }): EmailContent {
  const url = appUrl("/team/clients");
  return {
    subject: `Your assignment on ${d.clientName} has ended`,
    html: layout({
      title: `Your assignment on ${d.clientName} has ended`,
      preheader: `Your ${d.role} assignment ended on ${formatDate(d.endedOn)}`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`Your assignment on ${d.clientName} has ended. You no longer have access to their work, documents or JournL books. Accountanz will take care of handing over anything still open.`) +
        facts([["Client", d.clientName], ["Role", d.role], ["Ended on", formatDate(d.endedOn) ?? d.endedOn]]) +
        button("Open my clients", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `Your ${d.role} assignment on ${d.clientName} ended on ${formatDate(d.endedOn)}.`, `My clients: ${url}`),
  };
}

// ───────────────────────────── JournL corrections ─────────────────────────────

const correctionKindLabel = (kind: string, purpose: string) =>
  purpose === "unresolved_tb_difference" ? "Unresolved trial balance difference" : kind === "journal_entry" ? "Journal entry" : "Opening balance";

/** A correction was submitted: an eligible approver on the client can review it. Never includes JournL data. */
export function correctionSubmittedEmail(d: { recipientName: string; clientName: string; clientId: number; ref: string; kind: string; purpose: string; preparedBy: string; reason: string }): EmailContent {
  const url = appUrl(`/team/clients/${d.clientId}`);
  const label = correctionKindLabel(d.kind, d.purpose);
  return {
    subject: `JournL correction ${d.ref} needs approval (${d.clientName})`,
    html: layout({
      title: "A JournL correction is waiting for approval",
      preheader: `${d.preparedBy} submitted ${d.ref} for ${d.clientName}.`,
      body:
        paragraph(`Hi ${d.recipientName},`) +
        paragraph(`${d.preparedBy} submitted a JournL correction for ${d.clientName}. Nothing changes in JournL until it is approved and posted.`) +
        facts([["Reference", d.ref], ["Client", d.clientName], ["Type", label], ["Prepared by", d.preparedBy]]) +
        quote(d.reason) +
        button("Review the correction", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, `${d.preparedBy} submitted JournL correction ${d.ref} (${label}) for ${d.clientName}.`, `Reason: ${d.reason}`, `Review: ${url}`),
  };
}

/** A reviewer sent a correction back or rejected it: the preparer hears, with the comment. */
export function correctionDecidedEmail(d: { recipientName: string; clientName: string; clientId: number; ref: string; decision: "sent_back" | "rejected"; decidedBy: string; comment: string | null }): EmailContent {
  const url = appUrl(`/team/clients/${d.clientId}`);
  const sentBack = d.decision === "sent_back";
  const line = sentBack ? `${d.decidedBy} sent JournL correction ${d.ref} (${d.clientName}) back to you as a draft.` : `${d.decidedBy} rejected JournL correction ${d.ref} (${d.clientName}). Nothing was changed in JournL.`;
  return {
    subject: sentBack ? `Sent back: JournL correction ${d.ref}` : `Rejected: JournL correction ${d.ref}`,
    html: layout({
      title: sentBack ? "A JournL correction was sent back to you" : "A JournL correction was rejected",
      preheader: line,
      body: paragraph(`Hi ${d.recipientName},`) + paragraph(line) + (d.comment ? quote(d.comment) : "") + button("Open the correction", url),
    }),
    text: plainText(`Hi ${d.recipientName},`, line, d.comment && `Comment: ${d.comment}`, `Open: ${url}`),
  };
}

/** The posting outcome of an approved correction, for the preparer. Carries only Accountanz's wording and JournL's short refusal message. */
export function correctionOutcomeEmail(d: {
  recipientName: string;
  clientName: string;
  clientId: number;
  ref: string;
  outcome: "posted" | "rejected_by_journl" | "stale" | "unknown";
  voucherId: string | null;
  message: string | null;
}): EmailContent {
  const url = appUrl(`/team/clients/${d.clientId}`);
  const where = `JournL correction ${d.ref} (${d.clientName})`;
  const copy = {
    posted: { subject: `Posted: JournL correction ${d.ref}`, title: "A JournL correction was posted", line: `${where} was posted to JournL${d.voucherId ? ` as voucher ${d.voucherId}` : ""}.` },
    rejected_by_journl: { subject: `JournL refused correction ${d.ref}`, title: "JournL refused a correction", line: `JournL refused ${where}. Nothing was changed in JournL.` },
    stale: { subject: `Cancelled: JournL correction ${d.ref}`, title: "A JournL correction was cancelled", line: `${where} was not posted because things changed after it was prepared. Nothing was sent to JournL. You can prepare it again.` },
    unknown: { subject: `Check JournL: correction ${d.ref}`, title: "A JournL correction needs checking", line: `${where} was sent to JournL, but Accountanz couldn't confirm the result. An approver should use Check JournL before doing anything else.` },
  }[d.outcome];
  return {
    subject: copy.subject,
    html: layout({ title: copy.title, preheader: copy.line, body: paragraph(`Hi ${d.recipientName},`) + paragraph(copy.line) + (d.message ? quote(d.message) : "") + button("Open the correction", url) }),
    text: plainText(`Hi ${d.recipientName},`, copy.line, d.message && `Details: ${d.message}`, `Open: ${url}`),
  };
}
