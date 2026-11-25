import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne } from "../../database/connection.js";

type Db = PoolConnection | typeof pool;

export interface FolderRow {
  id: number;
  client_id: number;
  parent_id: number | null;
  name: string;
  created_at: string;
}

const COLS = "id, client_id, parent_id, name, created_at";

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

export async function insertFolder(f: { clientId: number; parentId: number | null; name: string; userId: number }, db: Db) {
  return (await execute(`INSERT INTO document_folders (client_id, parent_id, name, created_by) VALUES (?, ?, ?, ?)`, [f.clientId, f.parentId, f.name, f.userId], db)).insertId;
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

export const findClientDocument = (clientId: number, id: number, db: Db = pool) =>
  queryOne<{ id: number; file_name: string; folder_id: number | null }>(`SELECT id, file_name, folder_id FROM documents WHERE id = ? AND client_id = ?`, [id, clientId], db);
