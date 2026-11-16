import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { clientScope, isAdmin, isClientReviewer, requireClientAccess } from "../access/client-access.js";
import { getJournlOverview, openJournlSession } from "../integrations/journl-data.service.js";
import { JOURNL_VIEWS, MODULE_TABS, OVERVIEW_SECTION_FEATURES } from "../integrations/journl-views.js";
import { JOURNL_FEATURE_LIST } from "../integrations/journl-features.js";
import type { JournlViewQuery } from "./workspace.validation.js";
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
  const overview = await getJournlOverview(connection.id, period);
  // Each report section needs its own JournL feature (Profit & Loss, Trial Balance, Day Book).
  const features = await readableFeatures(actor, clientId);
  for (const [section, feature] of Object.entries(OVERVIEW_SECTION_FEATURES) as [keyof typeof OVERVIEW_SECTION_FEATURES, string][]) {
    if (features.has(feature)) continue;
    const name = JOURNL_FEATURE_LIST.find((f) => f.key === feature)?.name ?? feature;
    overview[section] = { data: null, error: `You don't have ${name} access in this client's JournL.` };
  }
  return overview;
}

/** JournL features (journl_modules keys) this person may read in a client's JournL today; every feature for admins. */
async function readableFeatures(actor: AuthUser, clientId: number): Promise<Set<string>> {
  if (isAdmin(actor)) return new Set(JOURNL_FEATURE_LIST.map((f) => f.key));
  const perms = await myClientPermissions(actor, clientId);
  return new Set(perms.flatMap((p) => p.modules.filter((m) => m.effective_actions.includes("view")).map((m) => m.module_key)));
}

/** Workspace pages (areas) and the views on them this person may open: an area shows when any of its views (or report sections) is readable. */
function readableAreas(features: Set<string>) {
  const views = Object.values(JOURNL_VIEWS).filter((v) => features.has(v.feature)).map((v) => v.key);
  const areas = Object.entries(MODULE_TABS)
    .filter(([area, tabs]) => (area === "financial_reports" ? Object.values(OVERVIEW_SECTION_FEATURES).some((f) => features.has(f)) : tabs.some((t) => views.includes(t))))
    .map(([area]) => area);
  return { areas, views };
}

/**
 * The bookkeeper's JournL workspace: each of their clients, which JournL modules they may read there, and whether
 * Accountanz currently holds a JournL session for it. Feeds the "Accounting — JournL" pages.
 */
export async function journlWorkspace(actor: AuthUser) {
  const clients = await repo.clientOptions(scopeOf(actor));
  const items = await Promise.all(
    clients.map(async (c) => {
      const [features, connection] = await Promise.all([readableFeatures(actor, c.value), repo.journlConnection(c.value)]);
      const { areas, views } = readableAreas(features);
      return {
        client_id: c.value,
        client_name: c.label,
        connected: connection?.status === "connected",
        org_id: connection?.external_org_id ?? null,
        org_name: connection?.external_org_name ?? null,
        session_until: connection?.session_until ?? null,
        modules: areas,
        /** Tabs this person may open for this client (others on a page are hidden). */
        views,
      };
    }),
  );
  return {
    modules: Object.entries(MODULE_TABS).map(([key, tabs]) => ({ key, tabs: tabs.map((t) => ({ key: t, label: JOURNL_VIEWS[t]!.label })) })),
    clients: items,
  };
}

/** One read-only JournL view for a client: assignment, engagement, JournL access and the module grant must all allow it. */
export async function clientJournlView(actor: AuthUser, clientId: number, viewKey: string, q: JournlViewQuery) {
  await requireClientAccess(actor, clientId);
  const view = JOURNL_VIEWS[viewKey];
  if (!view) throw AppError.notFound("JournL view");
  if (!(await readableFeatures(actor, clientId)).has(view.feature)) {
    const name = JOURNL_FEATURE_LIST.find((f) => f.key === view.feature)?.name ?? view.feature;
    throw AppError.forbidden(`You don't have ${name} access in this client's JournL. It needs both Accountanz's grant and the client's.`);
  }
  const connection = await repo.journlConnection(clientId);
  if (!connection || connection.status !== "connected") throw AppError.conflict("This client hasn't connected JournL yet");
  const { token } = await openJournlSession(connection.id);
  const result = await view.load(token, q);
  if (result.kind === "expired") throw AppError.conflict("The JournL session has expired. Ask the client owner to refresh it from their portal.");
  if (result.kind === "failed") throw AppError.conflict(result.reason);
  return {
    view: view.key,
    module: view.module,
    label: view.label,
    uses_period: view.usesPeriod,
    period: { from: q.from, to: q.to },
    columns: view.columns,
    rows: result.data.rows,
    total: result.data.total,
    page: q.page,
    page_size: q.pageSize,
    drill: result.data.drill ?? null,
  };
}
