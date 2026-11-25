import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { deleteFile, openFile, saveFile } from "../../utils/file-storage.js";
import { clientScope, requireClientAccess } from "../access/client-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyDocumentRequested } from "../notifications/notification.service.js";
import { listFoldersForClients } from "../document-folders/document-folder.repository.js";
import { folderPaths } from "../document-folders/document-folder.service.js";
import * as repo from "./document.repository.js";
import type { DocumentRow, DocumentStatus } from "./document.types.js";
import type { CreateRequestInput, DocumentListQuery, RequestListQuery, StaffUploadInput } from "./document.validation.js";

/**
 * One document workflow for admins (every client) and accountants (clients they are assigned to today).
 * The storage key never leaves the server.
 */
const toView = ({ file_path: _key, ...doc }: DocumentRow) => doc;

async function requireDocument(actor: AuthUser, id: number) {
  const doc = await repo.findDocument(id);
  if (!doc) throw AppError.notFound("Document");
  await requireClientAccess(actor, doc.client_id, "Document");
  return doc;
}

async function assertTaskOnClient(taskId: number | null | undefined, clientId: number) {
  if (taskId && !(await repo.taskBelongsToClient(taskId, clientId))) {
    throw new AppError("VALIDATION_ERROR", "That task belongs to another client", { fieldErrors: { task_id: ["Choose one of this client's tasks"] } });
  }
}

export async function listDocuments(actor: AuthUser, q: DocumentListQuery) {
  const page = await repo.listDocuments(q, clientScope(actor, "d.client_id"));
  // The client's own folder ("Bank / 2026 / March") so staff can see where a file was filed.
  const clientIds = [...new Set(page.items.filter((d) => d.folder_id).map((d) => d.client_id))];
  const paths = folderPaths(await listFoldersForClients(clientIds));
  return { ...page, items: page.items.map((d) => ({ ...toView(d), folder_path: d.folder_id ? (paths.get(d.folder_id) ?? null) : null })) };
}

export async function changeStatus(actor: AuthUser, id: number, status: DocumentStatus) {
  const doc = await requireDocument(actor, id);
  if (doc.status !== status) {
    await withTransaction(async (conn) => {
      await repo.setDocumentStatus(id, status, actor.id, conn);
      await recordAudit(actor, { action: `Document ${status}`, entityType: "Document", entityId: id, clientId: doc.client_id, details: doc.file_name }, conn);
    });
  }
  return toView((await repo.findDocument(id))!);
}

export async function openDocument(actor: AuthUser, id: number) {
  const doc = await requireDocument(actor, id);
  return { file: await openFile(doc.file_path), name: doc.file_name };
}

/** Staff add a document on the client's behalf (received by e-mail, WhatsApp, in person). */
export async function uploadDocument(actor: AuthUser, input: StaffUploadInput, file: Express.Multer.File) {
  await requireClientAccess(actor, input.client_id);
  await assertTaskOnClient(input.task_id, input.client_id);
  const key = await saveFile("documents", file.originalname, file.buffer, file.mimetype);
  try {
    const id = await withTransaction(async (conn) => {
      const docId = await repo.insertDocument(input, { key, name: file.originalname, mime: file.mimetype, size: file.size }, actor.id, conn);
      await recordAudit(actor, { action: "Document uploaded", entityType: "Document", entityId: docId, clientId: input.client_id, details: file.originalname }, conn);
      return docId;
    });
    return toView((await repo.findDocument(id))!);
  } catch (err) {
    await deleteFile(key);
    throw err;
  }
}

// ── Requests ──
export const listRequests = (actor: AuthUser, q: RequestListQuery) => repo.listRequests(q, clientScope(actor, "r.client_id"));

export async function createRequest(actor: AuthUser, input: CreateRequestInput) {
  await requireClientAccess(actor, input.client_id);
  await assertTaskOnClient(input.task_id, input.client_id);
  const id = await withTransaction(async (conn) => {
    const requestId = await repo.insertRequest(input, actor.id, conn);
    await recordAudit(actor, { action: "Document requested", entityType: "DocumentRequest", entityId: requestId, clientId: input.client_id, details: input.description }, conn);
    return requestId;
  });
  void notifyDocumentRequested(id, { clientId: input.client_id, requester: actor.fullName, description: input.description, period: input.period, dueDate: input.due_date });
  return (await repo.findRequest(id))!;
}

/** Only open requests can be withdrawn; fulfilled ones keep their history. */
export async function cancelRequest(actor: AuthUser, id: number) {
  const existing = await repo.findRequest(id);
  if (!existing) throw AppError.notFound("Request");
  await requireClientAccess(actor, existing.client_id, "Request");
  await withTransaction(async (conn) => {
    const row = await repo.findRequest(id, conn);
    if (row?.status !== "open") throw AppError.conflict("Only open requests can be cancelled");
    await repo.cancelRequest(id, conn);
    await recordAudit(actor, { action: "Document request cancelled", entityType: "DocumentRequest", entityId: id, clientId: existing.client_id, details: existing.description }, conn);
  });
  return (await repo.findRequest(id))!;
}
