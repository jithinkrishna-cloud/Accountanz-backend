import { Resend } from "resend";
import { env, isProd } from "../config/env.js";
import { logger } from "./logger.js";

export interface MailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  /**
   * Same key = same e-mail: Resend drops a repeat within 24h. Use one key per event
   * (e.g. `task-returned/42/review-7`) or per attempt for one-time links.
   */
  idempotencyKey?: string;
}

export interface MailResult {
  sent: boolean;
  id?: string;
}

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const RETRY_DELAYS_MS = [1000, 3000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Network errors, rate limits and server errors are worth retrying; other 4xx are not. */
const retryable = (status: number | null | undefined) => status == null || status === 429 || status >= 500;

/**
 * The only way e-mail leaves the app. Never throws: a failed e-mail must not undo the action that
 * triggered it (an invite still exists, a review still counts). Failures are logged with the reason.
 */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  const recipients = Array.isArray(message.to) ? message.to : [message.to];
  if (recipients.length === 0) return { sent: false };

  // Development: route everything to one inbox, keeping the intended recipient visible.
  const redirect = !isProd && env.MAIL_REDIRECT_TO ? env.MAIL_REDIRECT_TO : null;
  const to = redirect ? [redirect] : recipients;
  const subject = redirect ? `[to ${recipients.join(", ")}] ${message.subject}` : message.subject;

  if (!resend) {
    logger.info({ to: recipients, subject }, `[mail not configured] ${message.text}`);
    return { sent: false };
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const { data, error } = await resend.emails.send(
        { from: env.MAIL_FROM, to, subject, html: message.html, text: message.text },
        message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
      );
      if (!error) {
        logger.info({ emailId: data?.id, to: recipients, redirectedTo: redirect ?? undefined, subject: message.subject }, "Email sent");
        return { sent: true, id: data?.id };
      }
      const status = (error as { statusCode?: number | null }).statusCode;
      if (!retryable(status) || attempt >= RETRY_DELAYS_MS.length) {
        logger.error({ to: recipients, subject: message.subject, status, error: error.message, name: error.name }, "Email not sent");
        return { sent: false };
      }
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        logger.error({ err, to: recipients, subject: message.subject }, "Email not sent (network)");
        return { sent: false };
      }
    }
    await sleep(RETRY_DELAYS_MS[attempt]!);
  }
}
