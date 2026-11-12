/** Shared building blocks for transactional e-mails: escaping, layout, button, facts table. */

export const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const BRAND = "#0f9b8e";
const NAVY = "#1e2a4a";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** A primary call-to-action button (table-based so it renders in Outlook). */
export function button(label: string, url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td style="background:${BRAND};border-radius:8px">
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-weight:600;text-decoration:none;font-size:15px">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

/** Label / value rows, e.g. client, period, due date. */
export function facts(rows: [string, string | null | undefined][]) {
  const body = rows
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:14px;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;font-size:14px;color:${NAVY}">${escapeHtml(v!)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0">${body}</table>`;
}

export const paragraph = (text: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${NAVY}">${escapeHtml(text)}</p>`;

export const quote = (text: string) =>
  `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid ${BRAND};background:#f4fbfa;font-size:14px;line-height:1.6;color:${NAVY};white-space:pre-line">${escapeHtml(text)}</blockquote>`;

/** Wraps body HTML in the Accountanz shell (header, card, footer). `preheader` is the inbox preview text. */
export function layout({ title, preheader, body }: { title: string; preheader: string; body: string }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Arial,sans-serif">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
      <tr><td style="padding:0 4px 16px;font-size:18px;font-weight:700;color:${NAVY}">
        <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:7px;background:${BRAND};color:#fff;margin-right:8px">A</span>Accountanz
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
        <h1 style="margin:0 0 16px;font-size:20px;color:${NAVY}">${escapeHtml(title)}</h1>
        ${body}
      </td></tr>
      <tr><td style="padding:16px 4px;font-size:12px;line-height:1.5;color:#9ca3af">
        Accountanz · Managed accounting. You're receiving this because of activity on your Accountanz account.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

/** Plain-text alternative: lines joined, empty ones dropped. */
export const plainText = (...lines: (string | null | undefined | false)[]) => lines.filter(Boolean).join("\n\n");
