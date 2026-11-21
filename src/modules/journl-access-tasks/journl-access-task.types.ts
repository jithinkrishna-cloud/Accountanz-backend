export const ACCESS_TASK_ACTIONS = ["grant", "revoke", "verify_revoke", "update"] as const;
export type AccessTaskAction = (typeof ACCESS_TASK_ACTIONS)[number];

export const ACCESS_TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type AccessTaskStatus = (typeof ACCESS_TASK_STATUSES)[number];

/** Completed and cancelled are final; anything open can be finished, cancelled or moved between pending and in progress. */
export const ACCESS_TASK_TRANSITIONS: Record<AccessTaskStatus, AccessTaskStatus[]> = {
  pending: ["in_progress", "completed", "cancelled"],
  in_progress: ["pending", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export interface AccessTaskRow {
  id: number;
  client_id: number;
  client_name: string;
  journl_org_id: string | null;
  assignment_id: number | null;
  user_id: number;
  user_name: string;
  user_email: string;
  previous_user_id: number | null;
  previous_user_name: string | null;
  action: AccessTaskAction;
  status: AccessTaskStatus;
  responsible_id: number | null;
  responsible_name: string | null;
  notes: string | null;
  completed_at: string | null;
  completed_by_name: string | null;
  created_by_name: string | null;
  created_at: string;
}

/**
 * What Accountanz knows about one assignment's JournL login, from its to-dos (never assumed):
 * granted = an add was confirmed; pending_grant = an add is waiting; pending_removal = a removal is waiting;
 * unconfirmed = access is on but nothing was ever confirmed (set before to-dos existed); none = off.
 */
export type JournlAccessState = "granted" | "pending_grant" | "pending_removal" | "unconfirmed" | "none";

/** Reads an assignment's newest to-do ("action:status", from `latestTaskSql`) into what Accountanz actually knows. */
export function accessState(journlAccess: boolean, latest: string | null | undefined): JournlAccessState {
  const [action, status] = (latest ?? "").split(":");
  const open = status === "pending" || status === "in_progress";
  if (open && (action === "revoke" || action === "verify_revoke")) return "pending_removal";
  if (!journlAccess) return "none";
  if (open && (action === "grant" || action === "update")) return "pending_grant";
  if (status === "completed" && (action === "grant" || action === "update")) return "granted";
  return "unconfirmed";
}
