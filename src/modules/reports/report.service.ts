import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { deleteFile, openFile, saveFile } from "../../utils/file-storage.js";
import { clientScope, isClientReviewer, requireClientAccess } from "../access/client-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyReportPublished } from "../notifications/notification.service.js";
import * as repo from "./report.repository.js";
import { REPORT_LABELS, type ReportRow } from "./report.types.js";
import type { CreateReportInput, ReportListQuery } from "./report.validation.js";

/**
 * Report delivery: anyone on the client's team prepares a draft (file and/or summary, typically exported from
 * JournL); a reviewer on that client, or an admin, publishes it. Publishing is what makes it visible to the client.
 */
const toView = ({ file_path, ...r }: ReportRow) => ({ ...r, has_file: !!file_path });
const describe = (r: Pick<ReportRow, "report_type" | "period">) => `${REPORT_LABELS[r.report_type]} ${r.period}`;

async function requireReport(actor: AuthUser, id: number) {
  const report = await repo.findReport(id);
  if (!report) throw AppError.notFound("Report");
  await requireClientAccess(actor, report.client_id, "Report");
  return report;
}

async function requireReviewer(actor: AuthUser, clientId: number) {
  if (!(await isClientReviewer(actor, clientId))) throw AppError.forbidden("Only a reviewer on this client, or an admin, can publish reports");
}

export async function listReports(actor: AuthUser, q: ReportListQuery) {
  const page = await repo.listReports(q, clientScope(actor, "r.client_id"));
  return { ...page, items: page.items.map(toView) };
}

export async function createReport(actor: AuthUser, input: CreateReportInput, file: Express.Multer.File | undefined) {
  await requireClientAccess(actor, input.client_id);
  if (!file && !input.summary) throw new AppError("VALIDATION_ERROR", "Attach the report file or write a summary", { fieldErrors: { summary: ["Attach a file or write a summary"] } });
  const key = file ? await saveFile("reports", file.originalname, file.buffer, file.mimetype) : null;
  try {
    const id = await withTransaction(async (conn) => {
      const reportId = await repo.insertReport(input, key && file ? { key, name: file.originalname } : null, actor.id, conn);
      await recordAudit(actor, { action: "Report drafted", entityType: "Report", entityId: reportId, clientId: input.client_id, details: describe(input) }, conn);
      return reportId;
    });
    return toView((await repo.findReport(id))!);
  } catch (err) {
    await deleteFile(key);
    throw err;
  }
}

export async function publishReport(actor: AuthUser, id: number) {
  const report = await requireReport(actor, id);
  await requireReviewer(actor, report.client_id);
  await withTransaction(async (conn) => {
    const row = await repo.findReport(id, conn);
    if (row?.published_date) throw AppError.conflict("This report is already published");
    await repo.publish(id, actor.id, conn);
    await recordAudit(actor, { action: "Report published", entityType: "Report", entityId: id, clientId: report.client_id, details: describe(report) }, conn);
  });
  void notifyReportPublished(id, { clientId: report.client_id, reportLabel: REPORT_LABELS[report.report_type], period: report.period, summary: report.summary });
  return toView((await repo.findReport(id))!);
}

/** Takes a report back from the client (e.g. published by mistake); it returns to draft. */
export async function unpublishReport(actor: AuthUser, id: number) {
  const report = await requireReport(actor, id);
  await requireReviewer(actor, report.client_id);
  await withTransaction(async (conn) => {
    const row = await repo.findReport(id, conn);
    if (!row?.published_date) throw AppError.conflict("This report isn't published");
    await repo.unpublish(id, conn);
    await recordAudit(actor, { action: "Report unpublished", entityType: "Report", entityId: id, clientId: report.client_id, details: describe(report) }, conn);
  });
  return toView((await repo.findReport(id))!);
}

/** Drafts only: a published report must be unpublished first, so nothing disappears from the client silently. */
export async function deleteReport(actor: AuthUser, id: number) {
  const report = await requireReport(actor, id);
  await withTransaction(async (conn) => {
    const row = await repo.findReport(id, conn);
    if (row?.published_date) throw AppError.conflict("Unpublish the report before deleting it");
    await repo.deleteReport(id, conn);
    await recordAudit(actor, { action: "Report draft deleted", entityType: "Report", entityId: id, clientId: report.client_id, details: describe(report) }, conn);
  });
  await deleteFile(report.file_path);
}

export async function openReport(actor: AuthUser, id: number) {
  const report = await requireReport(actor, id);
  if (!report.file_path || !report.file_name) throw AppError.notFound("File");
  return { file: await openFile(report.file_path), name: report.file_name };
}
