import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { openFile } from "../../utils/file-storage.js";
import type { ListQuery } from "../../utils/pagination.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./document.repository.js";
import type { DocumentRow, DocumentStatus } from "./document.types.js";
import type { DocumentListQuery } from "./document.validation.js";

/** The storage key never leaves the server. */
const toView = ({ file_path: _key, ...doc }: DocumentRow) => doc;

export async function listDocuments(q: DocumentListQuery) {
  const page = await repo.listDocuments(q);
  return { ...page, items: page.items.map(toView) };
}

export const listOpenRequests = (q: ListQuery) => repo.listOpenRequests(q);

export async function changeStatus(actor: AuthUser, id: number, status: DocumentStatus) {
  const doc = await repo.findDocument(id);
  if (!doc) throw AppError.notFound("Document");
  if (doc.status !== status) {
    await withTransaction(async (conn) => {
      await repo.setDocumentStatus(id, status, actor.id, conn);
      await recordAudit(actor, { action: `Document ${status}`, entityType: "Document", entityId: id, clientId: doc.client_id, details: doc.file_name }, conn);
    });
  }
  return toView((await repo.findDocument(id))!);
}

/** Streams the private file; only signed-in admins reach this route. */
export async function openDocument(id: number) {
  const doc = await repo.findDocument(id);
  if (!doc) throw AppError.notFound("Document");
  if (!doc.file_path) throw AppError.notFound("File");
  return { file: await openFile(doc.file_path), name: doc.file_name };
}
