import type { StatusCategory } from "../projects/project.types.js";

export const ITEM_TYPES = ["task", "bug", "story", "subtask"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const PRIORITIES = ["highest", "high", "medium", "low", "lowest"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MAX_ATTACHMENTS = 10;
export const ATTACHMENT_MAX_MB = 10;
export const ATTACHMENT_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "csv", "xls", "xlsx", "doc", "docx", "ppt", "pptx", "zip"];

export interface ItemRow {
  id: number;
  number: number;
  key: string;
  type: ItemType;
  title: string;
  status_id: number;
  status_name: string;
  status_category: StatusCategory;
  priority: Priority;
  assignee_id: number | null;
  assignee_name: string | null;
  reporter_id: number | null;
  reporter_name: string | null;
  parent_id: number | null;
  parent_number: number | null;
  parent_title: string | null;
  sprint_id: number | null;
  sprint_name: string | null;
  client_id: number | null;
  client_name: string | null;
  story_points: number | null;
  /** Original estimate and total logged work, in minutes (shown as 1d 4h; 1d = 8h). */
  original_estimate_minutes: number | null;
  time_spent_minutes: number;
  start_date: string | null;
  due_date: string | null;
  rank: number;
  labels: string[];
  subtask_count: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemDetail extends ItemRow {
  description: string | null;
}

export interface AttachmentRow {
  id: number;
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: number | null;
  uploaded_by_name: string | null;
  created_at: string;
}

/** Time logged against a work item. */
export interface WorklogRow {
  id: number;
  user_id: number | null;
  user_name: string | null;
  minutes: number;
  work_date: string;
  note: string | null;
  created_at: string;
}
