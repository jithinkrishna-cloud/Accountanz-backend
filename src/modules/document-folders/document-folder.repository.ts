import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne } from "../../database/connection.js";

type Db = PoolConnection | typeof pool;

export interface FolderRow {
  id: number;
  client_id: number;
  parent_id: number | null;
  name: string;
  /** 1 = made by the accounting team (or for a document request): visible to the client and the client's team. */
  staff_folder: 0 | 1;
  created_at: string;
}

const COLS = "id, client_id, parent_id, name, staff_folder, created_at";

export const listFolders = (clientId: number) =>
  query<FolderRow>(`SELECT ${COLS} FROM document_folders WHERE client_id = ? ORDER BY name, id`, [clientId]);

/** Every folder of these clients (for showing staff each document's folder path). */
export const listFoldersForClients = (clientIds: number[]) =>
  clientIds.length
    ? query<FolderRow>(`SELECT ${COLS} FROM document_folders WHERE client_id IN (${clientIds.map(() => "?").join(",")})`, clientIds)
    : Promise.resolve([] as FolderRow[]);

export const findFolder = (clientId: number, id: number, db: Db = pool) =>
  queryOne<FolderRow>(`SELECT ${COLS} FROM document_folders WHERE id = ? AND client_id = ?`, [id, clientId], db);

/** Case-insensitive (the column collation is), so "Bank" and "bank" can't sit side by side. */
export const siblingNamed = (clientId: number, parentId: number | null, name: string, db: Db = pool) =>
  queryOne<{ id: number }>(`SELECT id FROM document_folders WHERE client_id = ? AND parent_id <=> ? AND name = ? LIMIT 1`, [clientId, parentId, name], db);

export async function insertFolder(f: { clientId: number; parentId: number | null; name: string; userId: number; staff?: boolean }, db: Db) {
  return (
    await execute(`INSERT INTO document_folders (client_id, parent_id, name, staff_folder, created_by) VALUES (?, ?, ?, ?, ?)`, [f.clientId, f.parentId, f.name, f.staff ? 1 : 0, f.userId], db)
  ).insertId;
}

export const renameFolder = (id: number, name: string, db: Db) => execute(`UPDATE document_folders SET name = ? WHERE id = ?`, [name, id], db);

export const deleteFolder = (id: number, db: Db) => execute(`DELETE FROM document_folders WHERE id = ?`, [id], db);

export async function folderContents(id: number, db: Db) {
  const row = await queryOne<{ folders: number; files: number }>(
    `SELECT (SELECT COUNT(*) FROM document_folders WHERE parent_id = ?) AS folders, (SELECT COUNT(*) FROM documents WHERE folder_id = ?) AS files`,
    [id, id],
    db,
  );
  return { folders: Number(row?.folders ?? 0), files: Number(row?.files ?? 0) };
}

export const moveDocument = (clientId: number, documentId: number, folderId: number | null, db: Db) =>
  execute(`UPDATE documents SET folder_id = ? WHERE id = ? AND client_id = ?`, [folderId, documentId, clientId], db);

// ── Sharing (folders are private to the client until shared) ──

/** Who each of the client's folders is shared with directly (subfolders inherit; the UI shows that). */
export const listShares = (clientId: number) =>
  query<{ folder_id: number; user_id: number; full_name: string }>(
    `SELECT s.folder_id, s.user_id, u.full_name FROM document_folder_shares s
       JOIN document_folders f ON f.id = s.folder_id JOIN users u ON u.id = s.user_id
      WHERE f.client_id = ? ORDER BY u.full_name`,
    [clientId],
  );

export const folderShareIds = (folderId: number, db: Db = pool) =>
  query<{ user_id: number }>(`SELECT user_id FROM document_folder_shares WHERE folder_id = ?`, [folderId], db).then((r) => r.map((x) => x.user_id));

export async function addShares(folderId: number, userIds: number[], sharedBy: number, db: Db) {
  for (const userId of userIds) {
    await execute(`INSERT IGNORE INTO document_folder_shares (folder_id, user_id, shared_by) VALUES (?, ?, ?)`, [folderId, userId, sharedBy], db);
  }
}

export async function removeShares(folderId: number, userIds: number[], db: Db) {
  if (!userIds.length) return;
  await execute(`DELETE FROM document_folder_shares WHERE folder_id = ? AND user_id IN (${userIds.map(() => "?").join(",")})`, [folderId, ...userIds], db);
}

/**
 * Folder ids (with every descendant) shared with this user: the SQL used to decide which client files an
 * accountant can see. Use as `d.folder_id IN (${SHARED_FOLDERS_SQL})` with the user id as the one parameter.
 */
export const SHARED_FOLDERS_SQL = `
  WITH RECURSIVE shared_tree AS (
    SELECT s.folder_id AS id FROM document_folder_shares s WHERE s.user_id = ?
    UNION
    SELECT f.id FROM document_folders f JOIN shared_tree t ON f.parent_id = t.id
  ) SELECT id FROM shared_tree`;

/**
 * Folder ids (with every descendant) an accountant can see: every staff folder, plus client folders shared with
 * them. Use as `d.folder_id IN (${VISIBLE_FOLDERS_SQL})` with the user id as the one parameter.
 */
export const VISIBLE_FOLDERS_SQL = `
  WITH RECURSIVE visible_tree AS (
    SELECT vf.id FROM document_folders vf
     WHERE vf.staff_folder = 1 OR vf.id IN (SELECT s.folder_id FROM document_folder_shares s WHERE s.user_id = ?)
    UNION
    SELECT f.id FROM document_folders f JOIN visible_tree t ON f.parent_id = t.id
  ) SELECT id FROM visible_tree`;

export const visibleFolderIds = (userId: number) => query<{ id: number }>(VISIBLE_FOLDERS_SQL, [userId]).then((r) => r.map((x) => x.id));

/** The client's files shared directly, with whom. */
export const listDocumentShares = (clientId: number) =>
  query<{ document_id: number; user_id: number; full_name: string }>(
    `SELECT s.document_id, s.user_id, u.full_name FROM document_shares s
       JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = s.user_id
      WHERE d.client_id = ? ORDER BY u.full_name`,
    [clientId],
  );

export const documentShareIds = (documentId: number, db: Db = pool) =>
  query<{ user_id: number }>(`SELECT user_id FROM document_shares WHERE document_id = ?`, [documentId], db).then((r) => r.map((x) => x.user_id));

export async function addDocumentShares(documentId: number, userIds: number[], sharedBy: number, db: Db) {
  for (const userId of userIds) {
    await execute(`INSERT IGNORE INTO document_shares (document_id, user_id, shared_by) VALUES (?, ?, ?)`, [documentId, userId, sharedBy], db);
  }
}

export async function removeDocumentShares(documentId: number, userIds: number[], db: Db) {
  if (!userIds.length) return;
  await execute(`DELETE FROM document_shares WHERE document_id = ? AND user_id IN (${userIds.map(() => "?").join(",")})`, [documentId, ...userIds], db);
}

export const sharedFolderIds = (userId: number) => query<{ id: number }>(SHARED_FOLDERS_SQL, [userId]).then((r) => r.map((x) => x.id));

export const findClientDocument = (clientId: number, id: number, db: Db = pool) =>
  queryOne<{ id: number; file_name: string; folder_id: number | null }>(`SELECT id, file_name, folder_id FROM documents WHERE id = ? AND client_id = ?`, [id, clientId], db);

/** A folder by id alone (staff routes work out the client from the folder, then check access to it). */
export const findFolderById = (id: number) => queryOne<FolderRow>(`SELECT ${COLS} FROM document_folders WHERE id = ?`, [id]);
