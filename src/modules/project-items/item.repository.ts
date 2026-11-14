import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import type { Paged } from "../../utils/pagination.js";
import type { StatusCategory } from "../projects/project.types.js";
import type { AttachmentRow, ItemDetail, ItemRow } from "./item.types.js";
import type { ListItemsQuery } from "./item.validation.js";

type RawItem = Omit<ItemDetail, "labels"> & { labels: string | null };

const SELECT = `
  SELECT i.id, i.number, CONCAT(s.space_key, '-', i.number) AS \`key\`, i.type, i.title, i.description,
         i.status_id, st.name AS status_name, st.category AS status_category, i.priority,
         i.assignee_id, au.full_name AS assignee_name, i.reporter_id, ru.full_name AS reporter_name,
         i.parent_id, p.number AS parent_number, p.title AS parent_title,
         i.sprint_id, sp.name AS sprint_name, i.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name,
         i.story_points, i.start_date, i.due_date, i.\`rank\`, i.resolved_at, i.created_at, i.updated_at,
         (SELECT GROUP_CONCAT(l.label ORDER BY l.label SEPARATOR ',') FROM project_item_labels l WHERE l.item_id = i.id) AS labels,
         (SELECT COUNT(*) FROM project_items sub WHERE sub.parent_id = i.id) AS subtask_count
    FROM project_items i
    JOIN project_spaces s ON s.id = i.space_id
    JOIN project_statuses st ON st.id = i.status_id
    LEFT JOIN users au ON au.id = i.assignee_id
    LEFT JOIN users ru ON ru.id = i.reporter_id
    LEFT JOIN project_items p ON p.id = i.parent_id
    LEFT JOIN project_sprints sp ON sp.id = i.sprint_id
    LEFT JOIN clients c ON c.id = i.client_id`;

const toItem = ({ labels, ...r }: RawItem): ItemDetail => ({ ...r, labels: labels ? labels.split(",") : [] });
const toRow = (r: RawItem): ItemRow => {
  const { description: _d, ...rest } = toItem(r);
  return rest;
};

const SORT: Record<ListItemsQuery["sort"], string> = {
  rank: "i.`rank`",
  key: "i.number",
  title: "i.title",
  priority: "FIELD(i.priority, 'highest', 'high', 'medium', 'low', 'lowest')",
  status: "st.position",
  assignee: "au.full_name",
  reporter: "ru.full_name",
  due_date: "i.due_date",
  created_at: "i.created_at",
  updated_at: "i.updated_at",
  story_points: "i.story_points",
};

export async function listItems(spaceId: number, q: ListItemsQuery): Promise<Paged<ItemRow>> {
  const where = ["i.space_id = ?"];
  const params: Param[] = [spaceId];
  if (q.q) {
    const n = /^\D*-?(\d+)$/.exec(q.q)?.[1];
    where.push(`(i.title LIKE ?${n ? " OR i.number = ?" : ""})`);
    params.push(`%${q.q}%`, ...(n ? [Number(n)] : []));
  }
  if (q.assignee_id === "unassigned") where.push("i.assignee_id IS NULL");
  else if (q.assignee_id) {
    const ids = q.assignee_id.split(",").map(Number).filter((x) => Number.isInteger(x) && x > 0);
    const unassigned = q.assignee_id.split(",").includes("unassigned");
    if (ids.length || unassigned) {
      where.push(`(${[ids.length ? `i.assignee_id IN (${ids.map(() => "?").join(",")})` : "", unassigned ? "i.assignee_id IS NULL" : ""].filter(Boolean).join(" OR ")})`);
      params.push(...ids);
    }
  }
  if (q.type) (where.push("i.type = ?"), params.push(q.type));
  if (q.status_id) (where.push("i.status_id = ?"), params.push(q.status_id));
  if (q.priority) (where.push("i.priority = ?"), params.push(q.priority));
  if (q.client_id) (where.push("i.client_id = ?"), params.push(q.client_id));
  if (q.parent_number) (where.push("p.number = ?"), params.push(q.parent_number));
  if (q.sprint === "none") where.push("i.sprint_id IS NULL");
  else if (q.sprint === "active") where.push("sp.status = 'active'");
  else if (q.sprint) (where.push("i.sprint_id = ?"), params.push(Number(q.sprint)));
  if (q.done_within_days) (where.push("(st.category <> 'done' OR i.resolved_at >= UTC_TIMESTAMP() - INTERVAL ? DAY)"), params.push(q.done_within_days));
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const order = `${SORT[q.sort]} ${q.dir === "desc" ? "DESC" : "ASC"}, i.number ${q.dir === "desc" ? "DESC" : "ASC"}`;
  const rows = await query<RawItem>(`${SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM project_items i JOIN project_statuses st ON st.id = i.status_id
       LEFT JOIN users au ON au.id = i.assignee_id LEFT JOIN users ru ON ru.id = i.reporter_id
       LEFT JOIN project_items p ON p.id = i.parent_id LEFT JOIN project_sprints sp ON sp.id = i.sprint_id ${whereSql}`,
    params,
  );
  return { items: rows.map(toRow), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export async function findItem(spaceId: number, number: number, db?: PoolConnection) {
  const r = await queryOne<RawItem>(`${SELECT} WHERE i.space_id = ? AND i.number = ?`, [spaceId, number], db);
  return r ? toItem(r) : null;
}

export async function findItemById(id: number, db?: PoolConnection) {
  const r = await queryOne<RawItem>(`${SELECT} WHERE i.id = ?`, [id], db);
  return r ? toItem(r) : null;
}

export const listSubtasks = async (itemId: number) => (await query<RawItem>(`${SELECT} WHERE i.parent_id = ? ORDER BY i.number`, [itemId])).map(toRow);

export const findItemRef = (spaceId: number, number: number, db?: PoolConnection) =>
  queryOne<{ id: number; type: string; rank: number }>(`SELECT id, type, \`rank\` FROM project_items WHERE space_id = ? AND number = ?`, [spaceId, number], db);

/** Allocates the next item number while holding the space row. */
export async function nextNumber(spaceId: number, conn: PoolConnection) {
  const row = await queryOne<{ n: number }>(`SELECT next_item_number AS n FROM project_spaces WHERE id = ? FOR UPDATE`, [spaceId], conn);
  await execute(`UPDATE project_spaces SET next_item_number = next_item_number + 1 WHERE id = ?`, [spaceId], conn);
  return row!.n;
}

export const maxRank = async (spaceId: number, conn: PoolConnection) =>
  (await queryOne<{ r: number | null }>(`SELECT MAX(\`rank\`) AS r FROM project_items WHERE space_id = ?`, [spaceId], conn))?.r ?? 0;

export const firstStatus = (spaceId: number, conn: PoolConnection) =>
  queryOne<{ id: number; category: StatusCategory }>(`SELECT id, category FROM project_statuses WHERE space_id = ? ORDER BY position, id LIMIT 1`, [spaceId], conn);

export const findStatus = (spaceId: number, id: number, db?: PoolConnection) =>
  queryOne<{ id: number; name: string; category: StatusCategory }>(`SELECT id, name, category FROM project_statuses WHERE space_id = ? AND id = ?`, [spaceId, id], db);

export const findSprint = (spaceId: number, id: number, db?: PoolConnection) =>
  queryOne<{ id: number; name: string; status: string }>(`SELECT id, name, status FROM project_sprints WHERE space_id = ? AND id = ?`, [spaceId, id], db);

export const memberName = (spaceId: number, userId: number, db?: PoolConnection) =>
  queryOne<{ full_name: string }>(
    `SELECT u.full_name FROM project_space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? AND m.user_id = ?`,
    [spaceId, userId],
    db,
  );

export const userName = (id: number, db?: PoolConnection) => queryOne<{ full_name: string }>(`SELECT full_name FROM users WHERE id = ?`, [id], db);
export const clientName = (id: number, db?: PoolConnection) => queryOne<{ name: string }>(`SELECT COALESCE(trade_name, legal_name) AS name FROM clients WHERE id = ?`, [id], db);

export interface ItemWrite {
  space_id: number;
  number: number;
  type: string;
  title: string;
  description: string | null;
  status_id: number;
  priority: string;
  assignee_id: number | null;
  reporter_id: number;
  parent_id: number | null;
  sprint_id: number | null;
  client_id: number | null;
  story_points: number | null;
  start_date: string | null;
  due_date: string | null;
  rank: number;
  resolved: boolean;
}

export async function insertItem(w: ItemWrite, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO project_items (space_id, number, type, title, description, status_id, priority, assignee_id, reporter_id, parent_id, sprint_id,
                                client_id, story_points, start_date, due_date, \`rank\`, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${w.resolved ? "UTC_TIMESTAMP()" : "NULL"})`,
    [w.space_id, w.number, w.type, w.title, w.description, w.status_id, w.priority, w.assignee_id, w.reporter_id, w.parent_id, w.sprint_id, w.client_id, w.story_points, w.start_date, w.due_date, w.rank],
    conn,
  );
  return r.insertId;
}

/** Column → value updates; `resolved` keeps resolved_at in step with the status category. */
export async function updateItem(id: number, sets: Record<string, Param>, resolved: boolean | undefined, conn: PoolConnection) {
  const cols = Object.keys(sets);
  const extra = resolved === undefined ? [] : [resolved ? "resolved_at = COALESCE(resolved_at, UTC_TIMESTAMP())" : "resolved_at = NULL"];
  if (!cols.length && !extra.length) return;
  await execute(`UPDATE project_items SET ${[...cols.map((c) => `\`${c}\` = ?`), ...extra].join(", ")} WHERE id = ?`, [...Object.values(sets), id], conn);
}

export async function setLabels(itemId: number, labels: string[], conn: PoolConnection) {
  await execute(`DELETE FROM project_item_labels WHERE item_id = ?`, [itemId], conn);
  for (const l of new Set(labels)) await execute(`INSERT INTO project_item_labels (item_id, label) VALUES (?, ?)`, [itemId, l], conn);
}

export const deleteItem = (id: number, conn: PoolConnection) => execute(`DELETE FROM project_items WHERE id = ?`, [id], conn);

/** Subtasks follow their parent's sprint. */
export const moveSubtasksToSprint = (parentId: number, sprintId: number | null, conn: PoolConnection) =>
  execute(`UPDATE project_items SET sprint_id = ? WHERE parent_id = ?`, [sprintId, parentId], conn);

export const attachmentKeysForItemTree = (itemId: number, conn: PoolConnection) =>
  query<{ file_key: string }>(`SELECT a.file_key FROM project_item_attachments a JOIN project_items i ON i.id = a.item_id WHERE i.id = ? OR i.parent_id = ?`, [itemId, itemId], conn);

// ── Activity ──
export async function logActivity(itemId: number, actorId: number, action: string, field: string | null, oldValue: string | null, newValue: string | null, conn: PoolConnection) {
  const cut = (v: string | null) => (v === null ? null : v.slice(0, 500));
  await execute(`INSERT INTO project_item_activity (item_id, actor_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)`, [itemId, actorId, action, field, cut(oldValue), cut(newValue)], conn);
}

export const listActivity = (itemId: number) =>
  query<{ id: number; actor_id: number | null; actor_name: string | null; action: string; field: string | null; old_value: string | null; new_value: string | null; created_at: string }>(
    `SELECT a.id, a.actor_id, u.full_name AS actor_name, a.action, a.field, a.old_value, a.new_value, a.created_at
       FROM project_item_activity a LEFT JOIN users u ON u.id = a.actor_id WHERE a.item_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    [itemId],
  );

// ── Comments ──
export const listComments = (itemId: number) =>
  query<{ id: number; author_id: number | null; author_name: string | null; body: string; created_at: string; edited_at: string | null }>(
    `SELECT cm.id, cm.author_id, u.full_name AS author_name, cm.body, cm.created_at, cm.edited_at
       FROM project_item_comments cm LEFT JOIN users u ON u.id = cm.author_id WHERE cm.item_id = ? ORDER BY cm.created_at DESC, cm.id DESC`,
    [itemId],
  );

export const findComment = (itemId: number, id: number) => queryOne<{ id: number; author_id: number | null }>(`SELECT id, author_id FROM project_item_comments WHERE item_id = ? AND id = ?`, [itemId, id]);

export async function insertComment(itemId: number, authorId: number, body: string, conn: PoolConnection) {
  return (await execute(`INSERT INTO project_item_comments (item_id, author_id, body) VALUES (?, ?, ?)`, [itemId, authorId, body], conn)).insertId;
}

export const updateComment = (id: number, body: string) => execute(`UPDATE project_item_comments SET body = ?, edited_at = UTC_TIMESTAMP() WHERE id = ?`, [body, id]);
export const deleteComment = (id: number) => execute(`DELETE FROM project_item_comments WHERE id = ?`, [id]);

// ── Attachments ──
export const listAttachments = (itemId: number) =>
  query<AttachmentRow>(
    `SELECT a.id, a.file_name, a.content_type, a.size_bytes, a.uploaded_by, u.full_name AS uploaded_by_name, a.created_at
       FROM project_item_attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.item_id = ? ORDER BY a.created_at DESC`,
    [itemId],
  );

export const countAttachments = async (itemId: number, conn: PoolConnection) =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM project_item_attachments WHERE item_id = ? FOR UPDATE`, [itemId], conn))?.n ?? 0;

export const findAttachment = (itemId: number, id: number) =>
  queryOne<{ id: number; file_key: string; file_name: string; uploaded_by: number | null }>(
    `SELECT id, file_key, file_name, uploaded_by FROM project_item_attachments WHERE item_id = ? AND id = ?`,
    [itemId, id],
  );

export async function insertAttachment(itemId: number, a: { file_key: string; file_name: string; content_type: string; size_bytes: number }, userId: number, conn: PoolConnection) {
  await execute(
    `INSERT INTO project_item_attachments (item_id, file_key, file_name, content_type, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [itemId, a.file_key, a.file_name, a.content_type, a.size_bytes, userId],
    conn,
  );
}

export const deleteAttachment = (id: number, conn: PoolConnection) => execute(`DELETE FROM project_item_attachments WHERE id = ?`, [id], conn);
