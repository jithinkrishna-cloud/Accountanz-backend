/**
 * Demo client deliverables: last month's published reports (real, small PDFs in file storage) and client approvals.
 * Used by the seed, and safe to run against existing data (it skips clients that already have reports/approvals).
 * Development only.
 */
import type { PoolConnection } from "mysql2/promise";
import { deleteFile, saveFile } from "../../utils/file-storage.js";
import { execute, query, type Param } from "../connection.js";

const ins = async (conn: PoolConnection, table: string, row: Record<string, Param>) => {
  const keys = Object.keys(row);
  return (await execute(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(row), conn)).insertId;
};

/** A one-page PDF with a title and lines of text (Helvetica, so ASCII only: amounts use "Rs."). */
export function simplePdf(title: string, lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, "").replace(/[\\()]/g, (m) => `\\${m}`);
  const text = [`BT /F1 18 Tf 56 780 Td (${esc(title)}) Tj`, "/F1 11 Tf 0 -30 Td 16 TL", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** PDFs use "Rs." (no rupee glyph in Helvetica); on-screen text uses ₹. */
const lakh = (n: number) => `Rs. ${(n / 100000).toFixed(2)} lakh`;
const inr = (n: number) => `₹${(n / 100000).toFixed(2)} lakh`;
const monthName = (period: string) => new Date(`${period}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

export interface DeliverableContext {
  clientId: number;
  name: string;
  /** The closed month the reports cover. */
  period: string;
  /** Publication date (YYYY-MM-DD), early in the following month. */
  publishedOn: string;
  preparer: number | null;
  approver: number | null;
  /** A client portal user who decided past approvals (null when the company has no portal users). */
  clientDecider: number | null;
  /** Varies the demo figures between clients. */
  seed: number;
}

/** Last month's P&L, balance sheet and GST summary, published to the client with a short summary each. */
export async function addReports(conn: PoolConnection, c: DeliverableContext) {
  const revenue = 1_250_000 + c.seed * 310_000;
  const cogs = Math.round(revenue * 0.58);
  const opex = Math.round(revenue * 0.24);
  const profit = revenue - cogs - opex;
  const cash = 420_000 + c.seed * 95_000;
  const receivables = Math.round(revenue * 0.35);
  const payables = Math.round(cogs * 0.3);
  const outputGst = Math.round(revenue * 0.18);
  const inputGst = Math.round(cogs * 0.18);
  const month = monthName(c.period);

  const reports: { type: string; title: string; summary: string; lines: string[] }[] = [
    {
      type: "profit_and_loss",
      title: `Profit & Loss - ${month}`,
      summary: `Revenue ${inr(revenue)}, net profit ${inr(profit)} (${Math.round((profit / revenue) * 100)}% margin).`,
      lines: [c.name, "", `Revenue                 ${lakh(revenue)}`, `Cost of sales           ${lakh(cogs)}`, `Gross profit            ${lakh(revenue - cogs)}`, `Operating expenses      ${lakh(opex)}`, `Net profit              ${lakh(profit)}`],
    },
    {
      type: "balance_sheet",
      title: `Balance Sheet - ${month}`,
      summary: `Cash at bank ${inr(cash)}. Customers owe you ${inr(receivables)}; you owe suppliers ${inr(payables)}.`,
      lines: [c.name, `As at the end of ${month}`, "", `Cash and bank           ${lakh(cash)}`, `Trade receivables       ${lakh(receivables)}`, `Trade payables          ${lakh(payables)}`],
    },
    {
      type: "gst_summary",
      title: `GST Summary - ${month}`,
      summary: `GST payable ${inr(outputGst - inputGst)} after ${inr(inputGst)} input credit. Returns filed on time.`,
      lines: [c.name, "", `Output GST on sales     ${lakh(outputGst)}`, `Input tax credit        ${lakh(inputGst)}`, `Net GST payable         ${lakh(outputGst - inputGst)}`, "", "GSTR-1 and GSTR-3B filed."],
    },
  ];

  for (const r of reports) {
    const fileName = `${c.name.replace(/[^A-Za-z0-9]+/g, "-")}-${r.type.replace(/_/g, "-")}-${c.period}.pdf`;
    const filePath = await saveFile("reports", fileName, simplePdf(r.title, [...r.lines, "", "Prepared by Accountanz. Demo figures."]), "application/pdf");
    await ins(conn, "published_reports", {
      client_id: c.clientId,
      period: c.period,
      report_type: r.type,
      file_path: filePath,
      file_name: fileName,
      summary: r.summary,
      prepared_by: c.preparer,
      approved_by: c.approver,
      published_date: c.publishedOn,
    });
  }
}

/** One decision waiting on the client, plus one they made last month. */
export async function addApprovals(conn: PoolConnection, c: DeliverableContext) {
  const month = monthName(c.period);
  await ins(conn, "client_approvals", {
    client_id: c.clientId,
    subject: `Approve your ${month} accounts`,
    description: `Your ${month} profit & loss and balance sheet are ready under Reports. Please confirm they look right so we can finalise the month.`,
    requested_by: c.approver,
    status: "pending",
    created_at: `${c.publishedOn} 10:00:00`,
  });
  if (c.seed % 2 === 0) {
    await ins(conn, "client_approvals", {
      client_id: c.clientId,
      subject: "Write off an old customer balance of ₹4,250",
      description: "A customer balance from last year has not been paid and the customer has closed. We suggest writing it off as a bad debt. This reduces this month's profit by ₹4,250.",
      requested_by: c.approver,
      status: "pending",
      created_at: `${c.publishedOn} 11:00:00`,
    });
  }
  await ins(conn, "client_approvals", {
    client_id: c.clientId,
    subject: "Confirm the bank accounts we reconcile",
    description: "We reconcile your current account and your cash credit account every month. Let us know if there are any others.",
    requested_by: c.approver,
    status: c.clientDecider ? "approved" : "pending",
    created_at: `${c.period}-04 09:30:00`,
    decided_by: c.clientDecider,
    decided_at: c.clientDecider ? `${c.period}-06 11:30:00` : null,
    comment: c.clientDecider ? "Yes, those are the only two." : null,
  });
}

/** Deletes the stored files of every published report (before the seed wipes the table). */
export async function deleteReportFiles(conn: PoolConnection) {
  const rows = await query<{ file_path: string | null }>(`SELECT file_path FROM published_reports WHERE file_path IS NOT NULL`, [], conn);
  for (const r of rows) await deleteFile(r.file_path).catch(() => undefined);
  return rows.length;
}
