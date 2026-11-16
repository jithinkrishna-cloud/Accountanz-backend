import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../../database/connection.js";
import { closedClientIds, isPeriodClosed } from "../closing/closing.repository.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { activeTeamRoles, clientScope, isAdmin, REVIEWER_TEAM_ROLES, TASK_MANAGER_ROLES } from "../access/client-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyTaskAssigned, notifyTaskSubmitted } from "../notifications/notification.service.js";
import * as repo from "./task.repository.js";
import { OPEN_STATUSES, type ChecklistItem, type GenerationCandidate, type GenerationResult, type TaskDetail, type TaskOptions, type TaskRecord } from "./task.types.js";
import type { CreateTaskInput, TaskListQuery, UpdateTaskInput, WorkLogInput } from "./task.validation.js";

// ───────────────────────────── Permissions (single source for both portals) ─────────────────────────────

/** Admins manage every client's tasks; finance managers / CFOs only clients they're assigned to today. */
async function canManageTasks(actor: AuthUser, clientId: number) {
  if (!TASK_MANAGER_ROLES.includes(actor.role)) return false;
  return isAdmin(actor) || (await activeTeamRoles(actor.id, clientId)).length > 0;
}

async function assertCanManage(actor: AuthUser, clientId: number) {
  if (!(await canManageTasks(actor, clientId))) {
    throw AppError.forbidden(TASK_MANAGER_ROLES.includes(actor.role) ? "You aren't assigned to this client" : "Only finance managers, CFOs and admins can create or edit tasks");
  }
}

/** Reviewing needs a reviewer-type assignment on the client (or admin), and never your own work. */
export async function canReviewTask(actor: AuthUser, task: Pick<TaskRecord, "client_id" | "assignee_id">) {
  if (task.assignee_id === actor.id) return false;
  if (isAdmin(actor)) return true;
  const roles = await activeTeamRoles(actor.id, task.client_id);
  return roles.some((r) => (REVIEWER_TEAM_ROLES as readonly string[]).includes(r));
}

async function assertCanView(actor: AuthUser, task: TaskRecord) {
  if (isAdmin(actor) || task.assignee_id === actor.id || task.reviewer_id === actor.id) return;
  if ((await activeTeamRoles(actor.id, task.client_id)).length === 0) throw AppError.notFound("Task");
}

const fieldError = (field: string, message: string) => new AppError("VALIDATION_ERROR", "Please check the highlighted fields", { fieldErrors: { [field]: [message] } });

/** Closed months stay closed: reopen through Month-End Closing (audited) before adding work to them. */
async function assertPeriodOpen(clientId: number, period: string, conn?: PoolConnection) {
  if (await isPeriodClosed(clientId, period, conn)) {
    throw fieldError("period", `${period} is closed for this client. Reopen it in Month-End Closing first.`);
  }
}

/** Assignee: an active assignment on the client today. Reviewer: a reviewer-type assignment or an admin; never the assignee. */
async function assertPeople(clientId: number, assigneeId: number, reviewerId: number) {
  if (assigneeId === reviewerId) throw fieldError("reviewer_id", "The reviewer must be someone other than the assignee");
  const [assignee, reviewer] = await Promise.all([repo.findActiveUser(assigneeId), repo.findActiveUser(reviewerId)]);
  if (!assignee || (await activeTeamRoles(assigneeId, clientId)).length === 0) {
    throw fieldError("assignee_id", "The assignee needs an active assignment to this client");
  }
  if (!reviewer) throw fieldError("reviewer_id", "Pick an active reviewer");
  const reviewerIsAdmin = reviewer.portal_role === "super_admin" || reviewer.portal_role === "ops_admin";
  const reviewerRoles = await activeTeamRoles(reviewerId, clientId);
  if (!reviewerIsAdmin && !reviewerRoles.some((r) => (REVIEWER_TEAM_ROLES as readonly string[]).includes(r))) {
    throw fieldError("reviewer_id", "The reviewer needs a finance manager, reviewer or CFO assignment to this client");
  }
}

// ───────────────────────────── Queries ─────────────────────────────

export const listTasks = (q: TaskListQuery) => repo.listTasks(q);

/** Accountant portal list: my tasks, or (managers) every task on my clients. */
export function listTasksForStaff(actor: AuthUser, q: TaskListQuery) {
  if (q.scope === "clients" && TASK_MANAGER_ROLES.includes(actor.role)) {
    const s = clientScope(actor, "t.client_id");
    return repo.listTasks(q, { scopeSql: s.sql, scopeParams: s.params });
  }
  return repo.listTasks(q, { assigneeId: actor.id });
}

/** Clients with tasks in the same scope as the list, with open / overdue counts. */
export function listTaskClientsForStaff(actor: AuthUser, scope: "mine" | "clients") {
  if (scope === "clients" && TASK_MANAGER_ROLES.includes(actor.role)) {
    const s = clientScope(actor, "t.client_id");
    return repo.taskClientSummary({ scopeSql: s.sql, scopeParams: s.params });
  }
  return repo.taskClientSummary({ assigneeId: actor.id });
}

export async function getTaskDetail(actor: AuthUser, id: number): Promise<TaskDetail> {
  const task = await repo.findTask(id);
  if (!task) throw AppError.notFound("Task");
  await assertCanView(actor, task);
  const [workLogs, reviews, canEdit, canReview] = await Promise.all([
    repo.listWorkLogs(id),
    repo.listTaskReviews(id),
    canManageTasks(actor, task.client_id),
    canReviewTask(actor, task),
  ]);
  const isAssignee = task.assignee_id === actor.id;
  const open = OPEN_STATUSES.includes(task.status);
  return {
    ...task,
    work_logs: workLogs,
    reviews,
    permissions: {
      can_edit: canEdit && open,
      can_work: isAssignee && open,
      can_submit: isAssignee && open,
      can_log_time: isAssignee || task.reviewer_id === actor.id,
      can_review: canReview && task.status === "submitted",
    },
  };
}

export async function getTaskOptions(actor: AuthUser, clientId?: number): Promise<TaskOptions> {
  const clients = await repo.listClientOptions(isAdmin(actor) ? null : actor.id);
  if (!clientId) return { clients, engagements: [], assignees: [], reviewers: [] };
  await assertCanManage(actor, clientId);
  const [engagements, team, admins] = await Promise.all([repo.listActiveEngagements(clientId), repo.listClientTeam(clientId), repo.listActiveAdmins()]);
  const reviewers = [
    ...team.filter((m) => (REVIEWER_TEAM_ROLES as readonly string[]).includes(m.team_role)).map((m) => ({ user_id: m.user_id, full_name: m.full_name, role: m.team_role })),
    ...admins.filter((a) => !team.some((m) => m.user_id === a.user_id)),
  ];
  return { clients, engagements, assignees: team, reviewers };
}

// ───────────────────────────── Create / edit ─────────────────────────────

export async function createTask(actor: AuthUser, input: CreateTaskInput) {
  await assertCanManage(actor, input.client_id);
  const engagement = await repo.findEngagement(input.engagement_id);
  if (!engagement || engagement.client_id !== input.client_id) throw fieldError("engagement_id", "Pick an engagement of this client");
  if (engagement.status !== "active") throw fieldError("engagement_id", "Tasks can only be added to an active engagement");
  await assertPeople(input.client_id, input.assignee_id, input.reviewer_id);

  const period = input.period ?? input.due_date.slice(0, 7);
  await assertPeriodOpen(input.client_id, period);
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertManualTask(
      {
        clientId: input.client_id,
        engagementId: input.engagement_id,
        period,
        title: input.title,
        description: input.description,
        checklist: input.checklist.map((text) => ({ text, done: false })),
        createdBy: actor.id,
        assigneeId: input.assignee_id,
        reviewerId: input.reviewer_id,
        dueDate: input.due_date,
        clientVisible: input.client_visible,
      },
      conn,
    );
    await recordAudit(actor, { action: "Task created", entityType: "Task", entityId: newId, clientId: input.client_id, details: `${input.title} (${period}) · one-off` }, conn);
    return newId;
  });
  void notifyTaskAssigned(id, actor);
  return getTaskDetail(actor, id);
}

/** Keeps ticks on checklist points whose text is unchanged. */
function mergeChecklist(current: ChecklistItem[], texts: string[]): ChecklistItem[] {
  return texts.map((text) => ({ text, done: current.find((c) => c.text === text)?.done ?? false }));
}

const TEMPLATE_LOCKED = ["title", "description", "checklist"] as const;

/**
 * Edits an open task. Approved tasks are locked; submitted tasks can't change while under review.
 * Template-generated tasks keep their template content (only people, dates and visibility change).
 * Every change is audited with the fields that changed.
 */
export async function updateTask(actor: AuthUser, id: number, input: UpdateTaskInput) {
  const existing = await repo.findTask(id);
  if (!existing) throw AppError.notFound("Task");
  await assertCanManage(actor, existing.client_id);

  let reassigned = false;
  await withTransaction(async (conn) => {
    const task = (await repo.lockTask(id, conn))!;
    if (task.status === "approved") throw AppError.conflict("Approved tasks are locked");
    if (task.status === "submitted") throw AppError.conflict("This task is waiting for review and can't be edited until it's approved or returned");

    const changes: repo.TaskFieldChanges = {};
    if (input.title !== undefined && input.title !== task.title) changes.title = input.title;
    if (input.description !== undefined && input.description !== task.description) changes.description = input.description;
    if (input.checklist !== undefined && JSON.stringify(input.checklist) !== JSON.stringify(task.checklist.map((c) => c.text))) {
      changes.checklist = mergeChecklist(task.checklist, input.checklist);
    }
    if (task.creation_source === "template") {
      const blocked = TEMPLATE_LOCKED.filter((k) => k in changes);
      if (blocked.length) throw fieldError(blocked[0]!, "Generated tasks keep their template's title, description and checklist");
    }
    if (input.assignee_id !== undefined && input.assignee_id !== task.assignee_id) changes.assignee_id = input.assignee_id;
    if (input.reviewer_id !== undefined && input.reviewer_id !== task.reviewer_id) changes.reviewer_id = input.reviewer_id;
    if (input.period !== undefined && input.period !== task.period) changes.period = input.period;
    if (input.due_date !== undefined && input.due_date !== task.due_date) changes.due_date = input.due_date;
    if (input.client_visible !== undefined && input.client_visible !== task.client_visible) changes.client_visible = input.client_visible;
    if (!Object.keys(changes).length) return;
    if (changes.period !== undefined) await assertPeriodOpen(task.client_id, changes.period, conn);

    if (changes.assignee_id !== undefined || changes.reviewer_id !== undefined) {
      const assigneeId = changes.assignee_id ?? task.assignee_id;
      const reviewerId = changes.reviewer_id ?? task.reviewer_id;
      if (!assigneeId) throw fieldError("assignee_id", "Pick an assignee");
      if (!reviewerId) throw fieldError("reviewer_id", "Pick a reviewer");
      await assertPeople(task.client_id, assigneeId, reviewerId);
    }

    await repo.updateTaskFields(id, changes, conn);
    await recordAudit(actor, { action: "Task updated", entityType: "Task", entityId: id, clientId: task.client_id, details: `${task.title}: ${Object.keys(changes).map((k) => k.replaceAll("_", " ")).join(", ")}` }, conn);
    reassigned = changes.assignee_id !== undefined;
  });
  if (reassigned) void notifyTaskAssigned(id, actor);
  return getTaskDetail(actor, id);
}

// ───────────────────────────── Doing the work (assignee) ─────────────────────────────

/** Ticks / unticks checklist points. The first change moves a to-do task to in progress. */
export async function updateChecklist(actor: AuthUser, id: number, done: boolean[]) {
  await withTransaction(async (conn) => {
    const task = await repo.lockTask(id, conn);
    if (!task) throw AppError.notFound("Task");
    if (task.assignee_id !== actor.id) throw AppError.forbidden("Only the assignee can work on this task");
    if (!OPEN_STATUSES.includes(task.status)) throw AppError.conflict(`This task is ${task.status.replace("_", " ")} and can't be changed`);
    if (done.length !== task.checklist.length) throw AppError.conflict("The checklist changed. Reload the task and try again.");
    const checklist = task.checklist.map((c, i) => ({ ...c, done: done[i]! }));
    await repo.setChecklistAndStatus(id, checklist, task.status === "todo" ? "in_progress" : task.status, conn);
  });
  return getTaskDetail(actor, id);
}

/** The assignee starts a to-do task, or picks a returned one back up (e.g. by dragging it on the Work Queue). */
export async function startTask(actor: AuthUser, id: number) {
  await withTransaction(async (conn) => {
    const task = await repo.lockTask(id, conn);
    if (!task) throw AppError.notFound("Task");
    if (task.assignee_id !== actor.id) throw AppError.forbidden("Only the assignee can start this task");
    if (task.status === "in_progress") return;
    if (task.status !== "todo" && task.status !== "returned") throw AppError.conflict(`This task is ${task.status.replace("_", " ")} and can't be moved back to in progress`);
    await repo.setChecklistAndStatus(id, task.checklist, "in_progress", conn);
    await recordAudit(actor, { action: task.status === "returned" ? "Task resumed" : "Task started", entityType: "Task", entityId: id, clientId: task.client_id, details: `${task.title} (${task.period})` }, conn);
  });
  return getTaskDetail(actor, id);
}

/** Time logged here feeds the accountant payout run. The assignee and the reviewer can log time. */
export async function logWork(actor: AuthUser, id: number, input: WorkLogInput) {
  const task = await repo.findTask(id);
  if (!task) throw AppError.notFound("Task");
  if (task.assignee_id !== actor.id && task.reviewer_id !== actor.id) throw AppError.forbidden("Only the assignee or reviewer can log time on this task");
  if (input.logged_on > new Date().toISOString().slice(0, 10)) throw fieldError("logged_on", "You can't log time in the future");
  await withTransaction(async (conn) => {
    await repo.insertWorkLog(id, actor.id, input.minutes, input.note, input.logged_on, conn);
    await recordAudit(actor, { action: "Time logged", entityType: "Task", entityId: id, clientId: task.client_id, details: `${task.title}: ${input.minutes} min` }, conn);
  });
  return getTaskDetail(actor, id);
}

/** Every checklist point must be ticked before submitting (Knowledge Base: "Submitting a task for review"). */
export async function submitTask(actor: AuthUser, id: number) {
  await withTransaction(async (conn) => {
    const task = await repo.lockTask(id, conn);
    if (!task) throw AppError.notFound("Task");
    if (task.assignee_id !== actor.id) throw AppError.forbidden("Only the assignee can submit this task");
    if (!OPEN_STATUSES.includes(task.status)) throw AppError.conflict(`This task is ${task.status.replace("_", " ")} and can't be submitted`);
    const open = task.checklist.filter((c) => !c.done).length;
    if (open > 0) throw new AppError("VALIDATION_ERROR", `Tick every checklist point before submitting (${open} left)`);
    if (!task.reviewer_id) throw new AppError("VALIDATION_ERROR", "This task has no reviewer yet. Ask your finance manager to set one.");
    await repo.markSubmitted(id, conn);
    await recordAudit(actor, { action: "Task submitted", entityType: "Task", entityId: id, clientId: task.client_id, details: `${task.title} (${task.period})` }, conn);
  });
  void notifyTaskSubmitted(id);
  return getTaskDetail(actor, id);
}

// ───────────────────────────── Bulk generation (admin) ─────────────────────────────

function periodBounds(period: string) {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { month: m, daysInMonth, start: `${period}-01`, end: `${period}-${String(daysInMonth).padStart(2, "0")}` };
}

/**
 * Whether a template recurs in this month. Quarterly templates fall in quarter-end months and annual
 * templates in March (Indian financial year end). Assumption: the existing app only has monthly templates.
 */
function recursIn(recurrence: GenerationCandidate["recurrence"], month: number) {
  if (recurrence === "quarterly") return month % 3 === 0;
  if (recurrence === "annual") return month === 3;
  return true;
}

const REVIEWER_PREFERENCE = ["finance_manager", "reviewer", "cfo"];

/** Days a task gets when it's generated after its template due day has already passed. */
const LATE_GENERATION_GRACE_DAYS = 3;

/**
 * A template's due day for the period, unless that day has already gone by (tasks generated late in the month,
 * or for a past month): then the task is due a few days from today rather than born overdue. Dates are India time.
 */
function dueOnGeneration(templateDue: string): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (templateDue >= today) return templateDue;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + LATE_GENERATION_GRACE_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Creates the period's tasks from templates for every active engagement, skipping tasks that already
 * exist (unique engagement × template item × period). One-off tasks are never touched.
 */
export async function generateTasks(actor: AuthUser, period: string): Promise<GenerationResult> {
  const { month, daysInMonth, start, end } = periodBounds(period);

  return withTransaction(async (conn) => {
    const closed = await closedClientIds(period, conn);
    const recurring = (await repo.listGenerationCandidates(start, end, conn)).filter((c) => recursIn(c.recurrence, month));
    const candidates = recurring.filter((c) => !closed.has(c.client_id));
    const closedClientsSkipped = new Set(recurring.filter((c) => closed.has(c.client_id)).map((c) => c.client_id)).size;
    const clientIds = [...new Set(candidates.map((c) => c.client_id))];
    const team = await repo.listTeamForPeriod(clientIds, start, end, conn);

    const pick = (clientId: number, roles: string[]) => {
      for (const role of roles) {
        const member = team.find((m) => m.client_id === clientId && m.team_role === role);
        if (member) return member.user_id;
      }
      return null;
    };

    let created = 0;
    for (const c of candidates) {
      const assigneeId = pick(c.client_id, ["bookkeeper"]);
      let reviewerId = pick(c.client_id, REVIEWER_PREFERENCE);
      if (reviewerId === assigneeId) reviewerId = null; // nobody reviews their own work
      const inserted = await repo.insertGeneratedTask(
        {
          clientId: c.client_id,
          engagementId: c.engagement_id,
          templateItemId: c.template_item_id,
          period,
          title: c.title,
          checklist: c.checklist.map((text) => ({ text, done: false })),
          createdBy: actor.id,
          assigneeId,
          reviewerId,
          dueDate: dueOnGeneration(`${period}-${String(Math.min(c.due_day_of_period, daysInMonth)).padStart(2, "0")}`),
          clientVisible: Boolean(c.client_visible),
        },
        conn,
      );
      if (inserted) created++;
    }

    const result: GenerationResult = {
      period,
      engagements: new Set(candidates.map((c) => c.engagement_id)).size,
      created,
      skipped: candidates.length - created,
      closed_clients_skipped: closedClientsSkipped,
    };
    const closedNote = closedClientsSkipped ? `, ${closedClientsSkipped} closed client(s) skipped` : "";
    await recordAudit(
      actor,
      { action: "Tasks generated", entityType: "Task", entityId: period, details: `${period}: ${created} created, ${result.skipped} already existed, ${result.engagements} engagement(s)${closedNote}` },
      conn,
    );
    return result;
  });
}
