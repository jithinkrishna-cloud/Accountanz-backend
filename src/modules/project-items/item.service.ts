import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { deleteFile, openFile, saveFile } from "../../utils/file-storage.js";
import type { SpaceContext } from "../projects/project.types.js";
import * as repo from "./item.repository.js";
import { MAX_ATTACHMENTS, type ItemDetail } from "./item.types.js";
import type { CreateItemInput, ListItemsQuery, MoveItemInput, UpdateItemInput } from "./item.validation.js";

const RANK_STEP = 1024;
const fieldError = (field: string, message: string) => new AppError("VALIDATION_ERROR", message, { fieldErrors: { [field]: [message] } });

async function requireItem(space: SpaceContext, number: number, db?: PoolConnection) {
  const item = await repo.findItem(space.id, number, db);
  if (!item) throw AppError.notFound("Work item");
  return item;
}

// ── Reference checks (all scoped to the space) ──
async function checkMember(space: SpaceContext, userId: number | null | undefined, field: string, conn: PoolConnection) {
  if (!userId) return null;
  const m = await repo.memberName(space.id, userId, conn);
  if (!m) throw fieldError(field, "Pick a member of this space");
  return m.full_name;
}

async function checkSprint(space: SpaceContext, sprintId: number | null | undefined, conn: PoolConnection) {
  if (!sprintId) return null;
  if (space.template !== "scrum") throw fieldError("sprint_id", "Kanban spaces have no sprints");
  const sprint = await repo.findSprint(space.id, sprintId, conn);
  if (!sprint) throw fieldError("sprint_id", "Sprint not found in this space");
  if (sprint.status === "completed") throw fieldError("sprint_id", "This sprint is already completed");
  return sprint.name;
}

async function checkClient(clientId: number | null | undefined, conn: PoolConnection) {
  if (!clientId) return null;
  const c = await repo.clientName(clientId, conn);
  if (!c) throw fieldError("client_id", "Client not found");
  return c.name;
}

/** A subtask needs a parent in the same space that is not itself a subtask; other types have no parent. */
async function resolveParent(space: SpaceContext, type: string, parentNumber: number | null | undefined, selfId: number | null, conn: PoolConnection) {
  if (type !== "subtask") {
    if (parentNumber) throw fieldError("parent_number", "Only subtasks have a parent");
    return null;
  }
  if (!parentNumber) throw fieldError("parent_number", "Pick the parent work item for this subtask");
  const parent = await repo.findItemRef(space.id, parentNumber, conn);
  if (!parent) throw fieldError("parent_number", "Parent work item not found in this space");
  if (parent.type === "subtask") throw fieldError("parent_number", "A subtask cannot be the parent of another subtask");
  if (parent.id === selfId) throw fieldError("parent_number", "An item cannot be its own parent");
  return parent;
}

// ── Items ──
export const listItems = (space: SpaceContext, q: ListItemsQuery) => repo.listItems(space.id, q);

export async function getItem(space: SpaceContext, number: number) {
  const item = await requireItem(space, number);
  const [subtasks, attachments] = await Promise.all([repo.listSubtasks(item.id), repo.listAttachments(item.id)]);
  return { ...item, subtasks, attachments };
}

export async function createItem(actor: AuthUser, space: SpaceContext, input: CreateItemInput) {
  const number = await withTransaction(async (conn) => {
    const status = input.status_id ? await repo.findStatus(space.id, input.status_id, conn) : await repo.firstStatus(space.id, conn);
    if (!status) throw fieldError("status_id", "Status not found in this space");
    await checkMember(space, input.assignee_id, "assignee_id", conn);
    await checkClient(input.client_id, conn);
    const parent = await resolveParent(space, input.type, input.parent_number, null, conn);
    let sprintId = input.sprint_id ?? null;
    let clientId = input.client_id === undefined ? space.client_id : input.client_id;
    if (parent) {
      const p = (await repo.findItemById(parent.id, conn))!;
      sprintId = p.sprint_id; // subtasks follow their parent's sprint
      if (input.client_id === undefined) clientId = p.client_id;
    } else await checkSprint(space, sprintId, conn);
    const n = await repo.nextNumber(space.id, conn);
    const id = await repo.insertItem(
      {
        space_id: space.id,
        number: n,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        status_id: status.id,
        priority: input.priority,
        assignee_id: input.assignee_id ?? null,
        reporter_id: actor.id,
        parent_id: parent?.id ?? null,
        sprint_id: sprintId,
        client_id: clientId,
        story_points: input.story_points ?? null,
        start_date: input.start_date ?? null,
        due_date: input.due_date ?? null,
        rank: (await repo.maxRank(space.id, conn)) + RANK_STEP,
        resolved: status.category === "done",
      },
      conn,
    );
    if (input.labels?.length) await repo.setLabels(id, input.labels, conn);
    await repo.logActivity(id, actor.id, "created", null, null, input.title, conn);
    return n;
  });
  return getItem(space, number);
}

const display = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

export async function updateItem(actor: AuthUser, space: SpaceContext, number: number, input: UpdateItemInput) {
  await withTransaction(async (conn) => {
    const item = await requireItem(space, number, conn);
    const sets: Record<string, string | number | null> = {};
    const log: [string, string | null, string | null][] = [];
    let resolved: boolean | undefined;
    const change = (field: string, column: string, value: string | number | null, oldText: string | null, newText: string | null) => {
      sets[column] = value;
      log.push([field, oldText, newText]);
    };

    for (const f of ["title", "description", "priority", "story_points", "start_date", "due_date"] as const) {
      if (input[f] === undefined || display(input[f]) === display(item[f])) continue;
      change(f, f, input[f] ?? null, f === "description" ? null : display(item[f]), f === "description" ? null : display(input[f]));
    }
    if (input.status_id !== undefined && input.status_id !== item.status_id) {
      const status = await repo.findStatus(space.id, input.status_id, conn);
      if (!status) throw fieldError("status_id", "Status not found in this space");
      change("status", "status_id", status.id, item.status_name, status.name);
      resolved = status.category === "done";
    }
    if (input.assignee_id !== undefined && input.assignee_id !== item.assignee_id) {
      change("assignee", "assignee_id", input.assignee_id, item.assignee_name, await checkMember(space, input.assignee_id, "assignee_id", conn));
    }
    if (input.reporter_id !== undefined && input.reporter_id !== item.reporter_id) {
      change("reporter", "reporter_id", input.reporter_id, item.reporter_name, await checkMember(space, input.reporter_id, "reporter_id", conn));
    }
    if (input.client_id !== undefined && input.client_id !== item.client_id) {
      change("client", "client_id", input.client_id, item.client_name, await checkClient(input.client_id, conn));
    }

    const type = input.type ?? item.type;
    const typeChanged = type !== item.type;
    const parentNumber = input.parent_number !== undefined ? input.parent_number : type === "subtask" ? item.parent_number : null;
    if (typeChanged || input.parent_number !== undefined) {
      if (type === "subtask" && item.subtask_count > 0) throw fieldError("type", "An item with subtasks cannot become a subtask");
      const parent = await resolveParent(space, type, parentNumber, item.id, conn);
      if (typeChanged) change("type", "type", type, item.type, type);
      if ((parent?.id ?? null) !== item.parent_id) {
        const p = parent ? (await repo.findItemById(parent.id, conn))! : null;
        change("parent", "parent_id", parent?.id ?? null, item.parent_number ? `${space.key}-${item.parent_number}` : null, p ? `${space.key}-${p.number}` : null);
        if (p && p.sprint_id !== item.sprint_id) sets.sprint_id = p.sprint_id;
      }
    }

    if (input.sprint_id !== undefined && input.sprint_id !== item.sprint_id) {
      if (type === "subtask") throw fieldError("sprint_id", "Subtasks follow their parent's sprint");
      change("sprint", "sprint_id", input.sprint_id, item.sprint_name, await checkSprint(space, input.sprint_id, conn));
      await repo.moveSubtasksToSprint(item.id, input.sprint_id, conn);
    }

    await repo.updateItem(item.id, sets, resolved, conn);
    if (input.labels !== undefined && input.labels.join(",") !== item.labels.join(",")) {
      await repo.setLabels(item.id, input.labels, conn);
      log.push(["labels", item.labels.join(", ") || null, [...new Set(input.labels)].sort().join(", ") || null]);
    }
    for (const [field, oldV, newV] of log) await repo.logActivity(item.id, actor.id, "updated", field, oldV, newV, conn);
  });
  return getItem(space, number);
}

/** Drag and drop: new status and/or sprint, placed between two neighbours (by item number). */
export async function moveItem(actor: AuthUser, space: SpaceContext, number: number, input: MoveItemInput) {
  await withTransaction(async (conn) => {
    const item = await requireItem(space, number, conn);
    const prev = input.prev_number ? await repo.findItemRef(space.id, input.prev_number, conn) : null;
    const next = input.next_number ? await repo.findItemRef(space.id, input.next_number, conn) : null;
    const rank = prev && next ? (prev.rank + next.rank) / 2 : prev ? prev.rank + RANK_STEP : next ? next.rank - RANK_STEP : item.rank;
    const sets: Record<string, string | number | null> = { rank };
    let resolved: boolean | undefined;
    if (input.status_id !== undefined && input.status_id !== item.status_id) {
      const status = await repo.findStatus(space.id, input.status_id, conn);
      if (!status) throw fieldError("status_id", "Status not found in this space");
      sets.status_id = status.id;
      resolved = status.category === "done";
      await repo.logActivity(item.id, actor.id, "updated", "status", item.status_name, status.name, conn);
    }
    if (input.sprint_id !== undefined && input.sprint_id !== item.sprint_id) {
      if (item.type === "subtask") throw fieldError("sprint_id", "Subtasks follow their parent's sprint");
      const name = await checkSprint(space, input.sprint_id, conn);
      sets.sprint_id = input.sprint_id;
      await repo.moveSubtasksToSprint(item.id, input.sprint_id, conn);
      await repo.logActivity(item.id, actor.id, "updated", "sprint", item.sprint_name, name, conn);
    }
    await repo.updateItem(item.id, sets, resolved, conn);
  });
  return getItem(space, number);
}

/** Space Administrators or the item's reporter. Deleting a parent deletes its subtasks. */
export async function deleteItem(actor: AuthUser, space: SpaceContext, number: number) {
  const keys = await withTransaction(async (conn) => {
    const item = await requireItem(space, number, conn);
    if (space.role !== "admin" && item.reporter_id !== actor.id) throw AppError.forbidden("Only the reporter or a space Administrator can delete this item");
    const files = await repo.attachmentKeysForItemTree(item.id, conn);
    await repo.deleteItem(item.id, conn);
    return files.map((f) => f.file_key);
  });
  await Promise.all(keys.map((k) => deleteFile(k)));
}

// ── Activity & comments ──
export async function getActivity(space: SpaceContext, number: number) {
  return repo.listActivity((await requireItem(space, number)).id);
}

export async function getComments(space: SpaceContext, number: number) {
  return repo.listComments((await requireItem(space, number)).id);
}

export async function addComment(actor: AuthUser, space: SpaceContext, number: number, body: string) {
  const item = await requireItem(space, number);
  await withTransaction(async (conn) => {
    await repo.insertComment(item.id, actor.id, body, conn);
    await repo.logActivity(item.id, actor.id, "commented", null, null, body.slice(0, 120), conn);
  });
  return repo.listComments(item.id);
}

async function ownComment(actor: AuthUser, space: SpaceContext, item: ItemDetail, id: number, allowAdmin: boolean) {
  const c = await repo.findComment(item.id, id);
  if (!c) throw AppError.notFound("Comment");
  if (c.author_id !== actor.id && !(allowAdmin && space.role === "admin")) throw AppError.forbidden("You can only change your own comments");
}

export async function editComment(actor: AuthUser, space: SpaceContext, number: number, id: number, body: string) {
  const item = await requireItem(space, number);
  await ownComment(actor, space, item, id, false);
  await repo.updateComment(id, body);
  return repo.listComments(item.id);
}

export async function deleteComment(actor: AuthUser, space: SpaceContext, number: number, id: number) {
  const item = await requireItem(space, number);
  await ownComment(actor, space, item, id, true);
  await repo.deleteComment(id);
  return repo.listComments(item.id);
}

// ── Attachments ──
export async function addAttachment(actor: AuthUser, space: SpaceContext, number: number, file: Express.Multer.File) {
  const item = await requireItem(space, number);
  const key = await saveFile(`projects/${space.key}/${item.number}`, file.originalname, file.buffer, file.mimetype);
  try {
    await withTransaction(async (conn) => {
      if ((await repo.countAttachments(item.id, conn)) >= MAX_ATTACHMENTS) throw AppError.conflict(`A work item can have at most ${MAX_ATTACHMENTS} attachments`);
      await repo.insertAttachment(item.id, { file_key: key, file_name: file.originalname, content_type: file.mimetype || "application/octet-stream", size_bytes: file.size }, actor.id, conn);
      await repo.logActivity(item.id, actor.id, "attachment_added", null, null, file.originalname, conn);
    });
  } catch (err) {
    await deleteFile(key);
    throw err;
  }
  return repo.listAttachments(item.id);
}

export async function openAttachment(space: SpaceContext, number: number, id: number) {
  const item = await requireItem(space, number);
  const a = await repo.findAttachment(item.id, id);
  if (!a) throw AppError.notFound("Attachment");
  return { file: await openFile(a.file_key), name: a.file_name };
}

export async function deleteAttachment(actor: AuthUser, space: SpaceContext, number: number, id: number) {
  const item = await requireItem(space, number);
  const a = await repo.findAttachment(item.id, id);
  if (!a) throw AppError.notFound("Attachment");
  if (a.uploaded_by !== actor.id && space.role !== "admin") throw AppError.forbidden("Only the uploader or a space Administrator can remove this attachment");
  await withTransaction(async (conn) => {
    await repo.deleteAttachment(a.id, conn);
    await repo.logActivity(item.id, actor.id, "attachment_removed", null, a.file_name, null, conn);
  });
  await deleteFile(a.file_key);
  return repo.listAttachments(item.id);
}
