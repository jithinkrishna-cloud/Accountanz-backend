import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { clientScope, isAdmin, isClientReviewer, requireClientAccess } from "../access/client-access.js";
import { getJournlOverview } from "../integrations/journl-data.service.js";
import { assessChecklist, recentPeriods, setStatus as setClosingStatus } from "../closing/closing.service.js";
import { checklist as closingChecklist, currentStatus } from "../closing/closing.repository.js";
import { withTransaction } from "../../database/connection.js";
import { myClientPermissions } from "../journl-permissions/permission.service.js";
import * as repo from "./workspace.repository.js";

/** The repository substitutes "{c}" with each query's client column. */
const scopeOf = (actor: AuthUser) => clientScope(actor, "{c}");
const thisPeriod = () => recentPeriods(new Date(), 1)[0]!;

export async function dashboard(actor: AuthUser) {
  const scope = scopeOf(actor);
  const period = thisPeriod();
  const [tasks, queue, activity, meetings, clients] = await Promise.all([
    repo.taskCounts(actor.id),
    repo.myOpenTasks(actor.id, 8),
    repo.clientActivity(scope),
    repo.upcomingMeetings(scope, 5),
    repo.myClients(actor.id, scope, period),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  return {
    period,
    counts: {
      clients: clients.length,
      assigned: n(tasks.assigned),
      overdue: n(tasks.overdue),
      returned: n(tasks.returned),
      to_review: n(tasks.to_review),
      due_week: n(tasks.due_week),
      open_requests: n(activity.open_requests),
      pending_approvals: n(activity.pending_approvals),
      awaiting_reply: n(activity.awaiting_reply),
      draft_reports: n(activity.draft_reports),
    },
    queue,
    meetings,
  };
}

export const myClients = (actor: AuthUser) => repo.myClients(actor.id, scopeOf(actor), thisPeriod());
export const clientOptions = (actor: AuthUser) => repo.clientOptions(scopeOf(actor));

export async function clientOverview(actor: AuthUser, clientId: number) {
  await requireClientAccess(actor, clientId);
  const [client, engagement, team, contacts, summary, journl, journlConnection] = await Promise.all([
    repo.clientFacts(clientId),
    repo.activeEngagement(clientId),
    repo.clientTeam(clientId),
    repo.clientContacts(clientId),
    repo.myClients(actor.id, { sql: "{c} = ?", params: [clientId] }, thisPeriod()),
    myClientPermissions(actor, clientId),
    repo.journlConnection(clientId),
  ]);
  if (!client) throw AppError.notFound("Client");
  return {
    client,
    engagement: engagement && { ...engagement, services: engagement.services ? engagement.services.split("||") : [] },
    team,
    contacts,
    summary: summary[0] ?? null,
    can_review: await isClientReviewer(actor, clientId),
    /** The caller's own JournL module permissions (one entry per active assignment; none for admins). */
    journl,
    /** The client's JournL connection; `session_until` is set while its books can be read. */
    journl_connection: journlConnection && { status: journlConnection.status, org_id: journlConnection.external_org_id, org_name: journlConnection.external_org_name, session_until: journlConnection.session_until },
  };
}

/** Each client's month-end checklist, judged by the closing module's readiness rule. */
export async function checklist(actor: AuthUser, period = thisPeriod()) {
  const rows = await closingChecklist(scopeOf(actor), period);
  const items = await Promise.all(
    rows.map(async (r) => ({
      client_id: r.client_id,
      client_name: r.client_name,
      closing_status: r.closing_status,
      ready_override: r.ready_override,
      ...assessChecklist(r),
      can_review: await isClientReviewer(actor, r.client_id),
    })),
  );
  return { period, periods: recentPeriods(), items };
}

/**
 * A reviewer on the client marks the period ready for closing (or takes it back). Closing and reopening a closed
 * period stay with admins in Month-End Closing, so a closed month can't be reopened from here.
 */
export async function setReadiness(actor: AuthUser, clientId: number, period: string, status: "open" | "ready", reason?: string) {
  await requireClientAccess(actor, clientId);
  if (!(await isClientReviewer(actor, clientId))) throw AppError.forbidden("Only a reviewer on this client can mark the month ready");
  const before = await withTransaction(async (conn) => (await currentStatus(clientId, period, conn))?.status ?? "open");
  if (before === "closed") throw AppError.conflict("This month is closed. Ask an admin to reopen it.");
  await setClosingStatus(actor, clientId, period, status, reason);
  return checklist(actor, period);
}

/**
 * Read-only JournL books for an accountant on this client: needs a current assignment with JournL access
 * (admins always pass). Reuses the admin view; the data comes live from JournL with the owner's session.
 */
export async function clientJournlData(actor: AuthUser, clientId: number, period: { from: string; to: string }) {
  await requireClientAccess(actor, clientId);
  if (!isAdmin(actor) && !(await repo.hasJournlAccess(actor.id, clientId))) {
    throw AppError.forbidden("Your assignment on this client doesn't include JournL access. Ask an admin to turn it on.");
  }
  const connection = await repo.journlConnection(clientId);
  if (!connection || connection.status !== "connected") throw AppError.conflict("This client hasn't connected JournL yet");
  return getJournlOverview(connection.id, period);
}
