import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { activeTeamRoles, isAdmin, requireClientAccess } from "../access/client-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyShared } from "../notifications/notification.service.js";
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

/** The client's folders, each with the people it's shared with directly. */
export async function listFolders(clientId: number) {
  const [folders, shares] = await Promise.all([repo.listFolders(clientId), repo.listShares(clientId)]);
  return folders.map((f) => ({ ...f, shared_with: shares.filter((s) => s.folder_id === f.id).map(({ user_id, full_name }) => ({ user_id, full_name })) }));
}

// ───────────── Privacy: which client files staff can see ─────────────

/**
 * Files the client uploads are private to the client until shared. Admins see every document. Accountants (already
 * limited to their clients by clientScope) see: files the team uploaded, files sent for a team request, files shared
 * with them directly, files in a staff folder (shared tree, any depth below it) and files in a folder shared with
 * them (or under one). Returns a predicate over the alias.
 */
export function documentVisibility(actor: AuthUser, alias = "d"): { sql: string; params: number[] } {
  if (isAdmin(actor)) return { sql: "1 = 1", params: [] };
  return {
    sql: `(${alias}.request_id IS NOT NULL
           OR ${alias}.uploaded_by IN (SELECT su.id FROM users su WHERE su.portal_role NOT IN ('client_owner', 'client_member'))
           OR ${alias}.id IN (SELECT ds.document_id FROM document_shares ds WHERE ds.user_id = ?)
           OR ${alias}.folder_id IN (${repo.VISIBLE_FOLDERS_SQL}))`,
    params: [actor.id, actor.id],
  };
}

/** Same rule for one document already loaded. */
export async function canSeeDocument(actor: AuthUser, doc: { id: number; folder_id: number | null; request_id: number | null; from_client: 0 | 1 | boolean }) {
  if (isAdmin(actor) || doc.request_id !== null || !doc.from_client) return true;
  if ((await repo.documentShareIds(doc.id)).includes(actor.id)) return true;
  return doc.folder_id !== null && (await repo.visibleFolderIds(actor.id)).includes(doc.folder_id);
}

// ───────────── Sharing ─────────────

/** Share targets must be on the company's accounting team today. */
async function assertTeam(clientId: number, userIds: number[]) {
  for (const userId of userIds) {
    if ((await activeTeamRoles(userId, clientId)).length === 0) {
      throw new AppError("VALIDATION_ERROR", "You can only share with people on your accounting team", { fieldErrors: { user_ids: ["Pick people from your accounting team"] } });
    }
  }
}

/** The client's files that are shared directly, with whom. */
export const listDocumentShares = (clientId: number) => repo.listDocumentShares(clientId);

/** Sets exactly who one file is shared with. Newly added people are emailed; removing someone hides it again. */
export async function shareDocument(actor: AuthUser, client: { clientId: number; clientName: string }, documentId: number, userIds: number[]) {
  const doc = await repo.findClientDocument(client.clientId, documentId);
  if (!doc) throw AppError.notFound("Document");
  const wanted = [...new Set(userIds)];
  await assertTeam(client.clientId, wanted);
  const added = await withTransaction(async (conn) => {
    const current = await repo.documentShareIds(documentId, conn);
    const add = wanted.filter((u) => !current.includes(u));
    const remove = current.filter((u) => !wanted.includes(u));
    if (!add.length && !remove.length) return [];
    await repo.addDocumentShares(documentId, add, actor.id, conn);
    await repo.removeDocumentShares(documentId, remove, conn);
    await recordAudit(actor, { action: "File sharing changed", entityType: "Document", entityId: documentId, clientId: client.clientId, details: `${doc.file_name}: ${add.length} added, ${remove.length} removed` }, conn);
    return add;
  });
  if (added.length) void notifyShared(added, { kind: "file", clientName: client.clientName, name: doc.file_name, sharedBy: actor.fullName, key: `document/${documentId}` });
  return { id: documentId, shared_with: (await repo.listDocumentShares(client.clientId)).filter((s) => s.document_id === documentId).map(({ user_id, full_name }) => ({ user_id, full_name })) };
}

/**
 * Sets exactly who a folder is shared with (people on the company's accounting team today). Newly added people
 * are emailed; removing someone hides the folder from them again.
 */
export async function shareFolder(actor: AuthUser, client: { clientId: number; clientName: string }, id: number, userIds: number[]) {
  const folder = await requireFolder(client.clientId, id);
  if (folder.staff_folder) throw AppError.conflict("Your accounting team made this folder, so they can already see it.");
  const wanted = [...new Set(userIds)];
  await assertTeam(client.clientId, wanted);
  const added = await withTransaction(async (conn) => {
    const current = await repo.folderShareIds(id, conn);
    const add = wanted.filter((u) => !current.includes(u));
    const remove = current.filter((u) => !wanted.includes(u));
    if (!add.length && !remove.length) return [];
    await repo.addShares(id, add, actor.id, conn);
    await repo.removeShares(id, remove, conn);
    await recordAudit(
      actor,
      { action: "Folder sharing changed", entityType: "DocumentFolder", entityId: id, clientId: client.clientId, details: `${folder.name}: ${add.length} added, ${remove.length} removed` },
      conn,
    );
    return add;
  });
  if (added.length) {
    const path = folderPaths(await repo.listFolders(client.clientId)).get(id) ?? folder.name;
    void notifyShared(added, { kind: "folder", clientName: client.clientName, name: path, sharedBy: actor.fullName, key: `folder/${id}` });
  }
  return (await listFolders(client.clientId)).find((f) => f.id === id)!;
}

/** A parent, upload target or move target must be a folder of the same client. */
async function requireFolder(clientId: number, id: number) {
  const folder = await repo.findFolder(clientId, id);
  if (!folder) throw AppError.notFound("Folder");
  return folder;
}

/**
 * Who may rename or delete a folder: staff only their team's folders (staff folders), the client only its own.
 * Staff folders are part of the shared tree, so the client can add subfolders and files there but not remove them.
 */
function assertManageable(folder: repo.FolderRow, staff: boolean) {
  if (staff && !folder.staff_folder) throw AppError.forbidden("This is the client's own folder. Only the client can rename or delete it.");
  if (!staff && folder.staff_folder) throw AppError.forbidden("Your accounting team made this folder. Ask them to rename or remove it.");
}

/** `staff` = created by the accounting team: visible to the client and the client's team. */
export async function createFolder(actor: AuthUser, clientId: number, input: CreateFolderInput, opts: { staff?: boolean } = {}) {
  if (input.parent_id) await requireFolder(clientId, input.parent_id);
  const id = await withTransaction(async (conn) => {
    if (await repo.siblingNamed(clientId, input.parent_id, input.name, conn)) throw nameTaken();
    const newId = await repo.insertFolder({ clientId, parentId: input.parent_id, name: input.name, userId: actor.id, staff: !!opts.staff }, conn);
    await recordAudit(actor, { action: "Folder created", entityType: "DocumentFolder", entityId: newId, clientId, details: input.name }, conn);
    return newId;
  });
  return (await repo.findFolder(clientId, id))!;
}

export async function renameFolder(actor: AuthUser, clientId: number, id: number, input: RenameFolderInput, opts: { staff?: boolean } = {}) {
  const folder = await requireFolder(clientId, id);
  assertManageable(folder, !!opts.staff);
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
export async function deleteFolder(actor: AuthUser, clientId: number, id: number, opts: { staff?: boolean } = {}) {
  const folder = await requireFolder(clientId, id);
  assertManageable(folder, !!opts.staff);
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

// ───────────── Staff side (admin and team portals) ─────────────

/** Folder ids this staff member can see (null = every folder: admins). */
const staffVisibleIds = async (actor: AuthUser) => (isAdmin(actor) ? null : new Set(await repo.visibleFolderIds(actor.id)));

/** A folder of the client that this staff member can see; a hidden client folder answers like a missing one. */
export async function requireStaffFolder(actor: AuthUser, clientId: number, id: number) {
  const folder = await requireFolder(clientId, id);
  const visible = await staffVisibleIds(actor);
  if (visible && !visible.has(id)) throw AppError.notFound("Folder");
  return folder;
}

/** Checks a staff upload or move target (null = top level). */
export async function assertStaffFolder(actor: AuthUser, clientId: number, folderId: number | null | undefined) {
  if (folderId) await requireStaffFolder(actor, clientId, folderId);
}

/** The client's folders this staff member may see: admins all; others staff folders plus folders shared with them. */
export async function listStaffFolders(actor: AuthUser, clientId: number) {
  await requireClientAccess(actor, clientId);
  const [folders, visible] = await Promise.all([listFolders(clientId), staffVisibleIds(actor)]);
  return visible ? folders.filter((f) => visible.has(f.id)) : folders;
}

export async function createStaffFolder(actor: AuthUser, input: CreateFolderInput & { client_id: number }) {
  await requireClientAccess(actor, input.client_id);
  if (input.parent_id) await requireStaffFolder(actor, input.client_id, input.parent_id);
  return createFolder(actor, input.client_id, { name: input.name, parent_id: input.parent_id }, { staff: true });
}

/** Staff routes address a folder by id alone; the client comes from the folder. */
async function staffFolderById(actor: AuthUser, id: number) {
  const folder = await repo.findFolderById(id);
  if (!folder) throw AppError.notFound("Folder");
  await requireClientAccess(actor, folder.client_id, "Folder");
  return requireStaffFolder(actor, folder.client_id, id);
}

export async function renameStaffFolder(actor: AuthUser, id: number, input: RenameFolderInput) {
  const folder = await staffFolderById(actor, id);
  return renameFolder(actor, folder.client_id, id, input, { staff: true });
}

export async function deleteStaffFolder(actor: AuthUser, id: number) {
  const folder = await staffFolderById(actor, id);
  await deleteFolder(actor, folder.client_id, id, { staff: true });
}

// ───────────── Document request folders ─────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NAME_MAX = 100;

/** "2026-11" → "Nov 2026"; no period → the current month. */
export function monthFolderName(period: string | null | undefined, now = new Date()) {
  const [y, m] = period ? period.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
  return `${MONTHS[m - 1]} ${y}`;
}

/** A request description as a folder name: one line, no slashes, at most 100 characters. */
export function requestFolderName(description: string) {
  const clean = description.replace(/[\/]+/g, "-").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
  return clean === "" || clean === "." || clean === ".." ? "Request" : clean;
}

/** `base`, or "base (2)", "base (3)"… whichever is free among the siblings (kept within 100 characters). */
async function freeSiblingName(clientId: number, parentId: number, base: string, conn: PoolConnection) {
  if (!(await repo.siblingNamed(clientId, parentId, base, conn))) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const name = `${base.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!(await repo.siblingNamed(clientId, parentId, name, conn))) return name;
  }
  throw AppError.conflict("Too many folders with this name");
}

/**
 * Makes the folder files for a new document request land in: "<Mon YYYY>" (top level) / "<task>" / "<description>".
 * The month and task folders are reused when they exist, so every request for a task sits together. All are staff
 * folders, so the client and the client's team see them. Returns the request folder.
 */
export async function createRequestFolder(
  r: { clientId: number; period: string | null; taskTitle?: string | null; description: string; userId: number },
  conn: PoolConnection,
) {
  const reuse = async (parentId: number | null, name: string) =>
    (await repo.siblingNamed(r.clientId, parentId, name, conn))?.id ?? (await repo.insertFolder({ clientId: r.clientId, parentId, name, userId: r.userId, staff: true }, conn));
  const monthId = await reuse(null, monthFolderName(r.period));
  const parentId = r.taskTitle ? await reuse(monthId, requestFolderName(r.taskTitle)) : monthId;
  const name = await freeSiblingName(r.clientId, parentId, requestFolderName(r.description), conn);
  return repo.insertFolder({ clientId: r.clientId, parentId, name, userId: r.userId, staff: true }, conn);
}
