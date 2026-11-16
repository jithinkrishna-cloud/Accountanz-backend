import type { PoolConnection } from "mysql2/promise";
import { activeAssignmentSql } from "../access/client-access.js";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type {
  ClientBranchRow,
  ClientDetail,
  ClientRow,
  CompanyFinancialProfile,
  CompanyStakeholderRow,
  CompanyTaxDetails,
} from "./client.types.js";
import type {
  BranchInput,
  ClientInput,
  ClientListQuery,
  ClientUpdateInput,
  CompanyTaxDetailsInput,
  FinancialProfileInput,
  StakeholderInput,
} from "./client.validation.js";

type Db = PoolConnection | typeof pool;

const COLUMNS =
  "id, legal_name, trade_name, business_type, date_of_establishment, gstin, pan, state, address, primary_contact_name, primary_contact_email, primary_contact_phone, status, accounting_software, created_at, updated_at";
const WRITABLE = [
  "legal_name",
  "trade_name",
  "business_type",
  "date_of_establishment",
  "gstin",
  "pan",
  "state",
  "address",
  "primary_contact_name",
  "primary_contact_email",
  "primary_contact_phone",
  "status",
  "accounting_software",
] as const;

/**
 * Roles each client's package includes vs. the roles assigned today: what's missing. A reviewer covers
 * finance_manager. Only clients that are onboarding or active are checked.
 */
export async function teamCoverage(clientIds: number[]) {
  const out = new Map<number, { package_name: string; package_roles: string[]; missing: string[] }>();
  if (!clientIds.length) return out;
  const marks = clientIds.map(() => "?").join(",");
  const packages = await query<{ client_id: number; package_name: string; team_roles: string[] }>(
    `SELECT e.client_id, p.name AS package_name, p.team_roles FROM engagements e JOIN packages p ON p.id = e.package_id
       JOIN clients c ON c.id = e.client_id
      WHERE e.client_id IN (${marks}) AND e.status <> 'ended' AND c.status IN ('onboarding', 'active')
      ORDER BY e.id DESC`,
    clientIds,
  );
  const assigned = await query<{ client_id: number; team_role: string }>(
    `SELECT DISTINCT a.client_id, a.team_role FROM assignments a WHERE a.client_id IN (${marks}) AND ${activeAssignmentSql("a")}`,
    clientIds,
  );
  for (const p of packages) {
    if (out.has(p.client_id)) continue; // latest open engagement wins
    const have = new Set(assigned.filter((a) => a.client_id === p.client_id).map((a) => a.team_role));
    const missing = p.team_roles.filter((r) => !have.has(r) && !(r === "finance_manager" && have.has("reviewer")));
    out.set(p.client_id, { package_name: p.package_name, package_roles: p.team_roles, missing });
  }
  return out;
}

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
  const coverage = await teamCoverage(items.map((c) => c.id));
  return { items: items.map((c) => ({ ...c, missing_roles: coverage.get(c.id)?.missing ?? [] })), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export function findClientById(id: number, db: Db = pool) {
  return queryOne<ClientRow>(`SELECT ${COLUMNS} FROM clients WHERE id = ?`, [id], db);
}

export function findClientByGstin(gstin: string) {
  return queryOne<{ id: number }>(`SELECT id FROM clients WHERE gstin = ?`, [gstin]);
}

export const getTaxDetails = (clientId: number, db: Db = pool) =>
  queryOne<CompanyTaxDetails>(`SELECT * FROM company_tax_details WHERE client_id = ?`, [clientId], db);

export async function upsertTaxDetails(clientId: number, input: CompanyTaxDetailsInput, db: Db = pool) {
  await execute(
    `INSERT INTO company_tax_details
      (client_id, pan_number, pan_status, tan_number, tan_status, gstin, gstin_status, cin, cin_status, llpin, llpin_status, msme_udyam_number, msme_status, professional_tax_registration, professional_tax_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      pan_number = VALUES(pan_number), pan_status = VALUES(pan_status), tan_number = VALUES(tan_number), tan_status = VALUES(tan_status),
      gstin = VALUES(gstin), gstin_status = VALUES(gstin_status), cin = VALUES(cin), cin_status = VALUES(cin_status),
      llpin = VALUES(llpin), llpin_status = VALUES(llpin_status), msme_udyam_number = VALUES(msme_udyam_number), msme_status = VALUES(msme_status),
      professional_tax_registration = VALUES(professional_tax_registration), professional_tax_status = VALUES(professional_tax_status)`,
    [
      clientId,
      input.pan_number,
      input.pan_status,
      input.tan_number,
      input.tan_status,
      input.gstin,
      input.gstin_status,
      input.cin,
      input.cin_status,
      input.llpin,
      input.llpin_status,
      input.msme_udyam_number,
      input.msme_status,
      input.professional_tax_registration,
      input.professional_tax_status,
    ],
    db,
  );
  return getTaxDetails(clientId, db);
}

export const listStakeholders = (clientId: number, db: Db = pool) =>
  query<CompanyStakeholderRow>(
    `SELECT id, client_id, stakeholder_type, full_name, email, phone, designation, ownership_percentage, pan_number, din_number, address, is_primary, created_at, updated_at
       FROM company_stakeholders WHERE client_id = ? ORDER BY is_primary DESC, id ASC`,
    [clientId],
    db,
  );

export const findStakeholder = (clientId: number, stakeholderId: number, db: Db = pool) =>
  queryOne<CompanyStakeholderRow>(`SELECT * FROM company_stakeholders WHERE id = ? AND client_id = ?`, [stakeholderId, clientId], db);

export async function insertStakeholder(clientId: number, input: StakeholderInput, db: Db = pool) {
  const r = await execute(
    `INSERT INTO company_stakeholders (client_id, stakeholder_type, full_name, email, phone, designation, ownership_percentage, pan_number, din_number, address, is_primary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [clientId, input.stakeholder_type, input.full_name, input.email, input.phone, input.designation, input.ownership_percentage, input.pan_number, input.din_number, input.address, input.is_primary ? 1 : 0],
    db,
  );
  return r.insertId;
}

export async function updateStakeholder(stakeholderId: number, input: StakeholderInput, db: Db = pool) {
  await execute(
    `UPDATE company_stakeholders SET stakeholder_type = ?, full_name = ?, email = ?, phone = ?, designation = ?, ownership_percentage = ?, pan_number = ?, din_number = ?, address = ?, is_primary = ? WHERE id = ?`,
    [input.stakeholder_type, input.full_name, input.email, input.phone, input.designation, input.ownership_percentage, input.pan_number, input.din_number, input.address, input.is_primary ? 1 : 0, stakeholderId],
    db,
  );
}

export async function deleteStakeholder(stakeholderId: number, db: Db = pool) {
  await execute(`DELETE FROM company_stakeholders WHERE id = ?`, [stakeholderId], db);
}

export async function replaceStakeholders(clientId: number, stakeholders: StakeholderInput[], db: Db = pool) {
  await execute(`DELETE FROM company_stakeholders WHERE client_id = ?`, [clientId], db);
  for (const s of stakeholders) await insertStakeholder(clientId, s, db);
  return listStakeholders(clientId, db);
}

export const getFinancialProfile = (clientId: number, db: Db = pool) =>
  queryOne<CompanyFinancialProfile>(`SELECT * FROM company_financial_profile WHERE client_id = ?`, [clientId], db);

export async function upsertFinancialProfile(clientId: number, input: FinancialProfileInput, db: Db = pool) {
  await execute(
    `INSERT INTO company_financial_profile
      (client_id, financial_year_start_month, annual_turnover, monthly_transaction_volume, employee_count, monthly_invoice_count, current_accounting_software, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      financial_year_start_month = VALUES(financial_year_start_month), annual_turnover = VALUES(annual_turnover),
      monthly_transaction_volume = VALUES(monthly_transaction_volume), employee_count = VALUES(employee_count),
      monthly_invoice_count = VALUES(monthly_invoice_count), current_accounting_software = VALUES(current_accounting_software), notes = VALUES(notes)`,
    [clientId, input.financial_year_start_month, input.annual_turnover, input.monthly_transaction_volume, input.employee_count, input.monthly_invoice_count, input.current_accounting_software, input.notes],
    db,
  );
  return getFinancialProfile(clientId, db);
}

export async function getClientDetail(id: number): Promise<ClientDetail | null> {
  const client = await findClientById(id);
  if (!client) return null;
  const [branches, portalUsers, team, tax_details, stakeholders, financial_profile] = await Promise.all([
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
    getTaxDetails(id),
    listStakeholders(id),
    getFinancialProfile(id),
  ]);
  const coverage = (await teamCoverage([id])).get(id);
  return {
    ...client,
    branches,
    portalUsers,
    team,
    package_roles: coverage?.package_roles ?? null,
    package_name: coverage?.package_name ?? null,
    missing_roles: coverage?.missing ?? [],
    tax_details,
    stakeholders,
    financial_profile,
  };
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
