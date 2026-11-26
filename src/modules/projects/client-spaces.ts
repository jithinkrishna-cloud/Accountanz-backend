import type { PoolConnection } from "mysql2/promise";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { isPortalAdminRole } from "./entitlement.js";
import * as repo from "./project.repository.js";

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
  const taken = (k: string) => repo.keyTaken(k, conn);
  const base = deriveSpaceKey(name);
  let key = await nextFreeKey(base, taken);

  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
    try {
      const spaceId = await repo.insertSpace({ space_key: key, name, template: "kanban", client_id: clientId } as Parameters<typeof repo.insertSpace>[0], "client_primary", firstAdminId, conn);
      await recordAudit(actor, { action: "Workspace client space created", entityType: "ProjectSpace", entityId: spaceId, clientId, details: `${key} · ${name}` }, conn);
      return { spaceId, created: true, restored: false };
    } catch (err) {
      if (dupKey(err, "uq_project_space_primary")) {
        const raced = await repo.findPrimarySpace(clientId, conn);
        if (raced) return { spaceId: raced.id, created: false, restored: false };
        throw err;
      }
      if (!dupKey(err, "uq_project_space_key")) throw err;
      key = await nextFreeKey(base, async (k) => k === key || (await taken(k)));
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
