import type { PoolConnection } from "mysql2/promise";
import { activeAssignmentSql } from "../access/client-access.js";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { ClientBranchRow, ClientDetail, ClientRow } from "./client.types.js";
import type { BranchInput, ClientInput, ClientListQuery, ClientUpdateInput } from "./client.validation.js";

type Db = PoolConnection | typeof pool;

const COLUMNS = "id, legal_name, trade_name, gstin, pan, state, address, status, accounting_software, created_at, updated_at";
const WRITABLE = ["legal_name", "trade_name", "gstin", "pan", "state", "address", "status", "accounting_software"] as const;

export async function listClients(q: ClientListQuery): Promise<Paged<ClientRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(legal_name LIKE ? OR trade_name LIKE ? OR gstin LIKE ? OR state LIKE ?)");
    params.push(like, like, like, like);
  }
  if (q.status) {
    where.push("status = ?");
    params.push(q.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<ClientRow>(
    `SELECT ${COLUMNS} FROM clients ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM clients ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export function findClientById(id: number, db: Db = pool) {
  return queryOne<ClientRow>(`SELECT ${COLUMNS} FROM clients WHERE id = ?`, [id], db);
}

export function findClientByGstin(gstin: string) {
  return queryOne<{ id: number }>(`SELECT id FROM clients WHERE gstin = ?`, [gstin]);
}

export async function getClientDetail(id: number): Promise<ClientDetail | null> {
  const client = await findClientById(id);
  if (!client) return null;
  const [branches, portalUsers, team] = await Promise.all([
    query<ClientBranchRow>(`SELECT id, name, gstin, external_branch_ref FROM client_branches WHERE client_id = ? ORDER BY name`, [id]),
    query<ClientDetail["portalUsers"][number]>(
      `SELECT u.id AS user_id, u.full_name, u.email, cu.role, cu.can_approve
         FROM client_users cu JOIN users u ON u.id = cu.user_id
        WHERE cu.client_id = ? ORDER BY cu.role, u.full_name`,
      [id],
    ),
    query<ClientDetail["team"][number]>(
      `SELECT u.id AS user_id, u.full_name, a.team_role, a.valid_from, a.valid_to
         FROM assignments a JOIN users u ON u.id = a.user_id
        WHERE a.client_id = ? AND ${activeAssignmentSql("a")}
        ORDER BY a.team_role, u.full_name`,
      [id],
    ),
  ]);
  return { ...client, branches, portalUsers, team };
}

export async function insertClient(input: ClientInput, db: Db = pool): Promise<number> {
  const r = await execute(
    `INSERT INTO clients (${WRITABLE.join(", ")}) VALUES (${WRITABLE.map(() => "?").join(", ")})`,
    WRITABLE.map((k) => input[k] ?? null),
    db,
  );
  return r.insertId;
}

export async function updateClient(id: number, input: ClientUpdateInput, db: Db = pool) {
  const keys = WRITABLE.filter((k) => k in input);
  if (!keys.length) return;
  await execute(
    `UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...keys.map((k) => input[k] ?? null), id],
    db,
  );
}

export async function linkClientUser(clientId: number, userId: number, role: "owner" | "member", canApprove: boolean, db: Db) {
  await execute(`INSERT INTO client_users (client_id, user_id, role, can_approve) VALUES (?, ?, ?, ?)`, [clientId, userId, role, role === "owner" || canApprove], db);
}

// ── Branches ──
export const findBranch = (clientId: number, branchId: number, db: Db = pool) =>
  queryOne<ClientBranchRow>(`SELECT id, name, gstin, external_branch_ref FROM client_branches WHERE id = ? AND client_id = ?`, [branchId, clientId], db);

/** Another client (its own GSTIN or one of its branches) already registered under this GSTIN. */
export const findOtherClientWithGstin = (gstin: string, clientId: number) =>
  queryOne<{ id: number }>(
    `SELECT id FROM clients WHERE gstin = ? AND id <> ?
     UNION SELECT client_id AS id FROM client_branches WHERE gstin = ? AND client_id <> ?
     LIMIT 1`,
    [gstin, clientId, gstin, clientId],
  );

export async function insertBranch(clientId: number, input: BranchInput, db: Db) {
  const r = await execute(`INSERT INTO client_branches (client_id, name, gstin, external_branch_ref) VALUES (?, ?, ?, ?)`, [clientId, input.name, input.gstin, input.external_branch_ref], db);
  return r.insertId;
}

export async function updateBranch(branchId: number, input: BranchInput, db: Db) {
  await execute(`UPDATE client_branches SET name = ?, gstin = ?, external_branch_ref = ? WHERE id = ?`, [input.name, input.gstin, input.external_branch_ref, branchId], db);
}

export async function deleteBranch(branchId: number, db: Db) {
  await execute(`DELETE FROM client_branches WHERE id = ?`, [branchId], db);
}
