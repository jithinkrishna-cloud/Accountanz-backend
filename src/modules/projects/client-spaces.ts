import type { PoolConnection } from "mysql2/promise";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyWorkspaceSyncIssues } from "../notifications/notification.service.js";
import { effectiveEntitlement, isPortalAdminRole } from "./entitlement.js";
import * as repo from "./project.repository.js";
import type { SyncIssueReason } from "./project.types.js";

export type { SyncIssueReason };

const MAX_KEY = 10;
const KEY_ATTEMPTS = 20;

/** Port of the wizard's suggestKey, padded with "X" to at least 2 characters. */
export function deriveSpaceKey(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  let key = "";
  if (words.length) {
    const raw = words.length === 1 ? words[0].slice(0, 3) : words.map((w) => w[0]).join("").slice(0, MAX_KEY);
    key = /^[A-Z]/.test(raw) ? raw : `P${raw}`.slice(0, MAX_KEY);
  }
  return key.padEnd(2, "X");
}

/** `base`, then `base2`, `base3`, ... with `base` truncated so the result fits in 10 characters. */
export async function nextFreeKey(base: string, taken: (k: string) => Promise<boolean>): Promise<string> {
  if (!(await taken(base))) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = String(n);
    const candidate = `${base.slice(0, MAX_KEY - suffix.length)}${suffix}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new AppError("VALIDATION_ERROR", "Could not find a free space key");
}

const dupKey = (err: unknown, key: string) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "ER_DUP_ENTRY" && !!e.message?.includes(key);
};

/** Creates the client's primary space, or un-archives it. Member sync is the caller's job. */
export async function ensurePrimarySpace(actor: AuthUser, clientId: number, conn: PoolConnection) {
  const existing = await repo.findPrimarySpace(clientId, conn);
  if (existing) {
    if (!existing.archived_at) return { spaceId: existing.id, created: false, restored: false };
    await repo.setArchived(existing.id, false, conn);
    return { spaceId: existing.id, created: false, restored: true };
  }

  const name = ((await repo.clientDisplayName(clientId, conn)) ?? `Client ${clientId}`).slice(0, 80);
  const firstAdminId = isPortalAdminRole(actor.role) ? actor.id : null;
  const tried = new Set<string>();
  const taken = async (k: string) => tried.has(k) || (await repo.keyTaken(k, conn));
  const base = deriveSpaceKey(name);
  let key = await nextFreeKey(base, taken);

  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
    tried.add(key);
    try {
      const spaceId = await repo.insertSpace({ space_key: key, name, template: "kanban", client_id: clientId } as Parameters<typeof repo.insertSpace>[0], "client_primary", actor.id, firstAdminId, conn);
      await recordAudit(actor, { action: "Workspace client space created", entityType: "ProjectSpace", entityId: spaceId, clientId, details: `${key} · ${name}` }, conn);
      return { spaceId, created: true, restored: false };
    } catch (err) {
      if (dupKey(err, "uq_project_space_primary")) {
        const raced = await repo.findPrimarySpaceLocking(clientId, conn);
        if (raced) return { spaceId: raced.id, created: false, restored: false };
        throw err;
      }
      if (!dupKey(err, "uq_project_space_key")) throw err;
      key = await nextFreeKey(base, taken);
    }
  }
  throw new AppError("VALIDATION_ERROR", "Could not find a free space key");
}

export async function archivePrimaryForClient(actor: AuthUser, clientId: number, conn: PoolConnection): Promise<void> {
  const primary = await repo.findPrimarySpace(clientId, conn);
  if (!primary) return;
  await repo.setArchived(primary.id, true, conn);
  await recordAudit(actor, { action: "Workspace client space archived", entityType: "ProjectSpace", entityId: primary.id, clientId, details: "Client engagement ended" }, conn);
}

/**
 * Makes the primary space's client_team members mirror the client's active team, within package rules.
 * Idempotent; never touches manual members; removals deliberately bypass the "at least one Administrator" rule.
 */
export async function syncPrimaryMembers(actor: AuthUser, clientId: number, conn: PoolConnection) {
  const result = { added: [] as number[], removed: [] as number[], issues: [] as { userId: number; reason: SyncIssueReason }[] };
  const space = await repo.findPrimarySpace(clientId, conn);
  if (!space) return result;

  const [team, members, entitlement] = await Promise.all([repo.listClientTeam(clientId, conn), repo.listMembersWithSource(space.id, conn), effectiveEntitlement(clientId, conn)]);
  const memberIds = new Set(members.map((x) => x.user_id));
  const wanted = team.filter((t) => !isPortalAdminRole(t.portal_role));
  const issueFor = new Map<number, SyncIssueReason>();
  const eligible = new Set<number>(); // wanted people who may hold a client_team seat
  const candidates: typeof wanted = []; // eligible people who are not members yet, in assignment order

  for (const t of wanted) {
    if (!entitlement) {
      // No active package: existing members stay, nobody new is added.
      if (memberIds.has(t.user_id)) eligible.add(t.user_id);
      else issueFor.set(t.user_id, "no_active_package");
    } else if (!entitlement.teamRoles.includes(t.portal_role)) {
      issueFor.set(t.user_id, "role_not_included");
    } else {
      eligible.add(t.user_id);
      if (!memberIds.has(t.user_id)) candidates.push(t);
    }
  }

  // Removals first, so freed seats can be reused in this run.
  const toRemove = members.filter((x) => x.source === "client_team" && !eligible.has(x.user_id));
  for (const r of toRemove) {
    await repo.removeMember(space.id, r.user_id, conn);
    memberIds.delete(r.user_id);
    result.removed.push(r.user_id);
  }

  const limit = entitlement?.staffPerWorkspace ?? null;
  let seats = members.filter((x) => memberIds.has(x.user_id) && !isPortalAdminRole(x.portal_role)).length;
  for (const c of candidates) {
    if (limit !== null && seats >= limit) {
      issueFor.set(c.user_id, "staff_limit");
      continue;
    }
    await repo.addMember(space.id, c.user_id, "member", actor.id, conn, "client_team");
    seats++;
    result.added.push(c.user_id);
  }

  if (result.added.length && (await repo.countAdmins(space.id, conn)) === 0) await repo.setMemberRole(space.id, result.added[0], "admin", conn);

  const opened: { userName: string; reason: SyncIssueReason }[] = [];
  for (const [userId, reason] of issueFor) {
    result.issues.push({ userId, reason });
    if (await repo.upsertSyncIssue(space.id, userId, reason, conn)) opened.push({ userName: team.find((t) => t.user_id === userId)?.full_name ?? `User ${userId}`, reason });
  }
  await repo.resolveSyncIssues(space.id, [...issueFor.keys()], conn);

  if (opened.length) void notifyWorkspaceSyncIssues(space.id, (await repo.clientDisplayName(clientId, conn)) ?? `Client ${clientId}`, opened);
  return result;
}
