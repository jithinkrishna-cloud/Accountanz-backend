import { z } from "zod";
import { ITEM_TYPES, PRIORITIES } from "./item.types.js";

const id = z.coerce.number().int().positive();
const nullableId = id.nullable();
const date = z.iso.date("Use a valid date").nullable();
const label = z.string().trim().min(1).max(40).regex(/^[^,\s]+$/, "Labels cannot contain spaces or commas");

export const itemParam = z.object({ key: z.string(), number: id });
export const childParam = z.object({ key: z.string(), number: id, id });

export const createItemSchema = z.object({
  title: z.string().trim().min(1, "Enter a summary").max(255),
  type: z.enum(ITEM_TYPES).default("task"),
  description: z.string().max(20000).nullable().optional(),
  status_id: id.optional(),
  priority: z.enum(PRIORITIES).default("medium"),
  assignee_id: nullableId.optional(),
  parent_number: id.nullable().optional(),
  /** Omitted: Scrum items go to the backlog. */
  sprint_id: nullableId.optional(),
  client_id: nullableId.optional(),
  story_points: z.coerce.number().min(0).max(999).nullable().optional(),
  start_date: date.optional(),
  due_date: date.optional(),
  labels: z.array(label).max(20).optional(),
});

export const updateItemSchema = z
  .object({
    title: z.string().trim().min(1, "Enter a summary").max(255),
    type: z.enum(ITEM_TYPES),
    description: z.string().max(20000).nullable(),
    status_id: id,
    priority: z.enum(PRIORITIES),
    assignee_id: nullableId,
    reporter_id: nullableId,
    parent_number: id.nullable(),
    sprint_id: nullableId,
    client_id: nullableId,
    story_points: z.coerce.number().min(0).max(999).nullable(),
    /** Minutes; null clears the estimate. */
    original_estimate_minutes: z.coerce.number().int().min(1, "Enter an estimate, e.g. 2h or 1d 4h").max(10_000_000).nullable(),
    start_date: date,
    due_date: date,
    labels: z.array(label).max(20),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

/** Drag and drop: new column/section plus the neighbours it was dropped between (by item number). */
export const moveItemSchema = z.object({
  status_id: id.optional(),
  sprint_id: nullableId.optional(),
  prev_number: id.nullable().optional(),
  next_number: id.nullable().optional(),
});

export const listItemsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  assignee_id: z.string().optional(),
  type: z.enum(ITEM_TYPES).optional(),
  status_id: id.optional(),
  priority: z.enum(PRIORITIES).optional(),
  client_id: id.optional(),
  /** A sprint id, "active" (the active sprint) or "none" (backlog). */
  sprint: z.string().regex(/^(\d+|active|none)$/).optional(),
  parent_number: id.optional(),
  /** Kanban board: hide done items resolved more than N days ago. */
  done_within_days: z.coerce.number().int().min(1).max(365).optional(),
  sort: z.enum(["rank", "key", "title", "priority", "status", "assignee", "reporter", "due_date", "created_at", "updated_at", "story_points"]).default("rank"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export const commentSchema = z.object({ body: z.string().trim().min(1, "Write a comment").max(10000) });

export type CreateItemInput = z.infer<typeof createItemSchema>;
/** Logging work: minutes spent (at most 24h in one entry), the day it was done, an optional note. */
export const worklogSchema = z.object({
  minutes: z.coerce.number().int().min(1, "Enter the time spent, e.g. 1h 30m").max(24 * 60, "Log at most 24h in one entry"),
  work_date: z.iso.date("Pick the day"),
  note: z.string().trim().max(500).nullable().optional(),
});

export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type WorklogInput = z.infer<typeof worklogSchema>;
export type MoveItemInput = z.infer<typeof moveItemSchema>;
export type ListItemsQuery = z.infer<typeof listItemsQuery>;
