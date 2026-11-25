import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./document-folder.repository.js";
import type { CreateFolderInput, MoveDocumentInput, RenameFolderInput } from "./document-folder.validation.js";

const nameTaken = () => new AppError("VALIDATION_ERROR", "Please check the highlighted fields", { fieldErrors: { name: ["A folder with this name is already here"] } });

/** "Bank / 2026 / March" for each folder id, walking up the parents. */
export function folderPaths(folders: repo.FolderRow[]) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<number, string>();
  const pathOf = (id: number, depth = 0): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const f = byId.get(id);
    if (!f || depth > 500) return "";
    const path = f.parent_id ? `${pathOf(f.parent_id, depth + 1)} / ${f.name}` : f.name;
    paths.set(id, path);
    return path;
  };
  for (const f of folders) pathOf(f.id);
  return paths;
}

export const listFolders = (clientId: number) => repo.listFolders(clientId);

/** A parent, upload target or move target must be a folder of the same client. */
async function requireFolder(clientId: number, id: number) {
  const folder = await repo.findFolder(clientId, id);
  if (!folder) throw AppError.notFound("Folder");
  return folder;
}

export async function createFolder(actor: AuthUser, clientId: number, input: CreateFolderInput) {
  if (input.parent_id) await requireFolder(clientId, input.parent_id);
  const id = await withTransaction(async (conn) => {
    if (await repo.siblingNamed(clientId, input.parent_id, input.name, conn)) throw nameTaken();
    const newId = await repo.insertFolder({ clientId, parentId: input.parent_id, name: input.name, userId: actor.id }, conn);
    await recordAudit(actor, { action: "Folder created", entityType: "DocumentFolder", entityId: newId, clientId, details: input.name }, conn);
    return newId;
  });
  return (await repo.findFolder(clientId, id))!;
}

export async function renameFolder(actor: AuthUser, clientId: number, id: number, input: RenameFolderInput) {
  const folder = await requireFolder(clientId, id);
  if (folder.name === input.name) return folder;
  await withTransaction(async (conn) => {
    const clash = await repo.siblingNamed(clientId, folder.parent_id, input.name, conn);
    if (clash && clash.id !== id) throw nameTaken();
    await repo.renameFolder(id, input.name, conn);
    await recordAudit(actor, { action: "Folder renamed", entityType: "DocumentFolder", entityId: id, clientId, details: `${folder.name} → ${input.name}` }, conn);
  });
  return (await repo.findFolder(clientId, id))!;
}

/** Only empty folders: removing a folder never deletes files. */
export async function deleteFolder(actor: AuthUser, clientId: number, id: number) {
  const folder = await requireFolder(clientId, id);
  await withTransaction(async (conn) => {
    const inside = await repo.folderContents(id, conn);
    if (inside.folders || inside.files) {
      throw AppError.conflict(`"${folder.name}" isn't empty (${inside.folders} folder(s), ${inside.files} file(s)). Move or remove what's inside first.`);
    }
    await repo.deleteFolder(id, conn);
    await recordAudit(actor, { action: "Folder deleted", entityType: "DocumentFolder", entityId: id, clientId, details: folder.name }, conn);
  });
}

/** Checks an upload's target folder belongs to the company (null = top level). */
export async function assertUploadFolder(clientId: number, folderId: number | null | undefined) {
  if (folderId) await requireFolder(clientId, folderId);
}

export async function moveDocument(actor: AuthUser, clientId: number, documentId: number, input: MoveDocumentInput) {
  const doc = await repo.findClientDocument(clientId, documentId);
  if (!doc) throw AppError.notFound("Document");
  const target = input.folder_id ? await requireFolder(clientId, input.folder_id) : null;
  if (doc.folder_id === (target?.id ?? null)) return;
  await withTransaction(async (conn) => {
    await repo.moveDocument(clientId, documentId, target?.id ?? null, conn);
    await recordAudit(actor, { action: "Document moved", entityType: "Document", entityId: documentId, clientId, details: `${doc.file_name} → ${target?.name ?? "top level"}` }, conn);
  });
}
