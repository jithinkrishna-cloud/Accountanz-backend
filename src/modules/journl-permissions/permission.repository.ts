import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne } from "../../database/connection.js";
import { activeAssignmentSql } from "../access/client-access.js";
import { AREA_LABEL, featuresFor } from "../integrations/journl-features.js";
import type { AssignmentGates, CatalogModule, GrantSource, ModuleGrant, ModulePolicy } from "./permission.types.js";

interface ModuleDbRow {
  module_key: string;
  label: string;
  group_key: string;
  default_policy: ModulePolicy;
  journl_module_id: string | null;
  module_verified_at: string | null;
  action_key: string | null;
  action_label: string | null;
  journl_action_id: string | null;
  action_verified_at: string | null;
}

/** The catalogue in display order, with each module's configured actions. */
export async function catalog(db?: PoolConnection, moduleKey?: string): Promise<CatalogModule[]> {
  const rows = await query<ModuleDbRow>(
    `SELECT m.module_key, m.label, m.group_key, m.default_policy, m.journl_module_id, m.verified_at AS module_verified_at,
            a.action_key, a.label AS action_label, a.journl_action_id, a.verified_at AS action_verified_at
       FROM journl_modules m LEFT JOIN journl_module_actions a ON a.module_key = m.module_key
      ${moduleKey ? "WHERE m.module_key = ?" : ""}
      ORDER BY m.sort_order, a.action_key`,
    moduleKey ? [moduleKey] : [],
    db,
  );
  const modules = new Map<string, CatalogModule>();
  for (const r of rows) {
    let m = modules.get(r.module_key);
    if (!m) {
      m = { module_key: r.module_key, label: r.label, group_key: r.group_key, group_label: AREA_LABEL[r.group_key] ?? r.group_key, default_policy: r.default_policy, journl_module_id: r.journl_module_id, features: featuresFor(r.journl_module_id), verified: r.module_verified_at !== null, actions: [] };
      modules.set(r.module_key, m);
    }
    if (r.action_key) m.actions.push({ action_key: r.action_key, label: r.action_label ?? r.action_key, journl_action_id: r.journl_action_id, verified: r.action_verified_at !== null });
  }
  return [...modules.values()];
}

/** allowed_actions is a JSON array of action keys; anything else is treated as no actions. */
const parseActions = (value: unknown): string[] => {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
};

type GrantDbRow = Omit<ModuleGrant, "allowed_actions" | "grant_source"> & { allowed_actions: unknown; grant_source: GrantSource };

export async function grants(assignmentId: number, db?: PoolConnection): Promise<ModuleGrant[]> {
  const rows = await query<GrantDbRow>(
    `SELECT p.module_key, p.grant_source, p.allowed_actions, p.status, u.full_name AS granted_by_name, p.granted_at, p.revoked_at
       FROM assignment_module_permissions p LEFT JOIN users u ON u.id = p.granted_by WHERE p.assignment_id = ?`,
    [assignmentId],
    db,
  );
  return rows.map((r) => ({ ...r, allowed_actions: parseActions(r.allowed_actions) }));
}

export async function grantsBySource(assignmentId: number, grantSource: GrantSource, db?: PoolConnection): Promise<ModuleGrant[]> {
  const rows = await query<GrantDbRow>(
    `SELECT p.module_key, p.grant_source, p.allowed_actions, p.status, u.full_name AS granted_by_name, p.granted_at, p.revoked_at
       FROM assignment_module_permissions p LEFT JOIN users u ON u.id = p.granted_by WHERE p.assignment_id = ? AND p.grant_source = ?`,
    [assignmentId, grantSource],
    db,
  );
  return rows.map((r) => ({ ...r, allowed_actions: parseActions(r.allowed_actions) }));
}

export async function lockGrant(assignmentId: number, moduleKey: string, grantSource: GrantSource, conn: PoolConnection) {
  const row = await queryOne<{ allowed_actions: unknown; status: "active" | "revoked" }>(
    `SELECT allowed_actions, status FROM assignment_module_permissions WHERE assignment_id = ? AND module_key = ? AND grant_source = ? FOR UPDATE`,
    [assignmentId, moduleKey, grantSource],
    conn,
  );
  return row && { status: row.status, allowed_actions: parseActions(row.allowed_actions) };
}

export async function upsertGrant(assignmentId: number, moduleKey: string, grantSource: GrantSource, actions: string[], actorId: number, conn: PoolConnection) {
  await execute(
    `INSERT INTO assignment_module_permissions (assignment_id, module_key, grant_source, allowed_actions, status, granted_by, granted_at)
     VALUES (?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE allowed_actions = VALUES(allowed_actions), status = 'active', granted_by = VALUES(granted_by),
       granted_at = VALUES(granted_at), revoked_by = NULL, revoked_at = NULL`,
    [assignmentId, moduleKey, grantSource, JSON.stringify(actions), actorId],
    conn,
  );
}

export async function revokeGrant(assignmentId: number, moduleKey: string, grantSource: GrantSource, actorId: number, conn: PoolConnection) {
  await execute(
    `UPDATE assignment_module_permissions SET status = 'revoked', revoked_by = ?, revoked_at = UTC_TIMESTAMP() WHERE assignment_id = ? AND module_key = ? AND grant_source = ?`,
    [actorId, assignmentId, moduleKey, grantSource],
    conn,
  );
}

/** A handover keeps the outgoing accountant's active module grants on the new assignment (granted by the admin doing it). */
export async function copyActiveGrants(fromAssignmentId: number, toAssignmentId: number, actorId: number, conn: PoolConnection) {
  const result = await execute(
    `INSERT INTO assignment_module_permissions (assignment_id, module_key, allowed_actions, status, granted_by, granted_at)
     SELECT ?, module_key, allowed_actions, 'active', ?, UTC_TIMESTAMP() FROM assignment_module_permissions WHERE assignment_id = ? AND status = 'active'`,
    [toAssignmentId, actorId, fromAssignmentId],
    conn,
  );
  return result.affectedRows;
}

/** Accountanz's gates for one assignment: active today, the client has an active engagement, JournL access on. */
export async function gates(assignmentId: number, db?: PoolConnection) {
  const row = await queryOne<{ assignment_id: number; client_id: number; user_id: number; assignment_active: 0 | 1; engagement_active: 0 | 1; journl_access: 0 | 1 }>(
    `SELECT a.id AS assignment_id, a.client_id, a.user_id, (${activeAssignmentSql("a")}) AS assignment_active,
            EXISTS (SELECT 1 FROM engagements e WHERE e.client_id = a.client_id AND e.status = 'active') AS engagement_active,
            a.journl_access
       FROM assignments a WHERE a.id = ?`,
    [assignmentId],
    db,
  );
  return row && ({ ...row, assignment_active: !!row.assignment_active, engagement_active: !!row.engagement_active, journl_access: !!row.journl_access } satisfies AssignmentGates);
}

/** A person's assignments on a client that grant access today. */
export const activeAssignmentIds = async (userId: number, clientId: number) =>
  (await query<{ id: number }>(`SELECT a.id FROM assignments a WHERE a.user_id = ? AND a.client_id = ? AND ${activeAssignmentSql("a")}`, [userId, clientId])).map((r) => r.id);

/** Every client that uses JournL or has someone assigned, with its connection and whether a JournL session is live. */
export const accessClients = () =>
  query<{
    client_id: number;
    client_name: string;
    client_status: string;
    engagement_active: 0 | 1;
    connection_status: string | null;
    org_id: string | null;
    org_name: string | null;
    session_until: string | null;
    verification_note: string | null;
  }>(
    `SELECT c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, c.status AS client_status,
            EXISTS (SELECT 1 FROM engagements e WHERE e.client_id = c.id AND e.status = 'active') AS engagement_active,
            ic.status AS connection_status, ic.external_org_id AS org_id, ic.external_org_name AS org_name,
            CASE WHEN ic.access_token_enc IS NOT NULL AND ic.token_expires_at > UTC_TIMESTAMP() THEN ic.token_expires_at END AS session_until,
            ic.verification_note
       FROM clients c
       LEFT JOIN integration_connections ic ON ic.client_id = c.id AND ic.provider = 'journl'
      WHERE c.status <> 'exited'
        AND (ic.id IS NOT NULL OR EXISTS (SELECT 1 FROM assignments a WHERE a.client_id = c.id AND ${activeAssignmentSql("a")}))
      ORDER BY client_name`,
  );

/** Today's assignments (one row per person and role) on the given clients. */
export const accessAssignments = (clientIds: number[]) =>
  clientIds.length
    ? query<{ assignment_id: number; client_id: number; user_id: number; full_name: string; team_role: string }>(
        `SELECT a.id AS assignment_id, a.client_id, a.user_id, u.full_name, a.team_role
           FROM assignments a JOIN users u ON u.id = a.user_id
          WHERE a.client_id IN (${clientIds.map(() => "?").join(",")}) AND ${activeAssignmentSql("a")}
          ORDER BY u.full_name`,
        clientIds,
      )
    : Promise.resolve([]);
