import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import {
  ONBOARDING_STAGES,
  type OnboardingCaseRow,
  type OnboardingServiceRequirements,
  type OnboardingStage,
  type StageCounts,
} from "./onboarding.types.js";
import type { AssessmentInput, OnboardingListQuery, ServiceRequirementsInput } from "./onboarding.validation.js";

type Db = PoolConnection | typeof pool;

const SELECT = `
  SELECT oc.id, oc.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, c.legal_name, c.status AS client_status,
         c.business_type, c.gstin, c.state, oc.stage, oc.monthly_transaction_volume, oc.complexity, oc.notes,
         u.full_name AS assessed_by_name, oc.suggested_package_id, p.name AS suggested_package_name, oc.suggested_monthly_fee, oc.package_source,
         oc.proposal_message, oc.proposal_sent_at, oc.accepted_at, ab.full_name AS accepted_by_name, oc.accepted_via,
         (SELECT COUNT(*) FROM client_users cu JOIN users ou ON ou.id = cu.user_id WHERE cu.client_id = oc.client_id AND cu.role = 'owner' AND ou.status = 'active') AS owner_logins,
         e.id AS engagement_id, e.status AS engagement_status, e.package_id AS engagement_package_id, ep.name AS engagement_package_name,
         COALESCE(e.monthly_fee, ep.monthly_fee) AS engagement_monthly_fee,
         pcr.id AS pending_change_id, tp.name AS pending_change_package_name, pcr.source AS pending_change_source,
         oc.created_at, oc.updated_at
    FROM onboarding_cases oc
    JOIN clients c ON c.id = oc.client_id
    LEFT JOIN users u ON u.id = oc.assessed_by
    LEFT JOIN users ab ON ab.id = oc.accepted_by
    LEFT JOIN packages p ON p.id = oc.suggested_package_id
    LEFT JOIN engagements e ON e.id = (SELECT MAX(e2.id) FROM engagements e2 WHERE e2.client_id = oc.client_id)
    LEFT JOIN packages ep ON ep.id = e.package_id
    LEFT JOIN package_change_requests pcr ON pcr.id = (SELECT MAX(r.id) FROM package_change_requests r WHERE r.engagement_id = e.id AND r.status = 'pending')
    LEFT JOIN packages tp ON tp.id = pcr.to_package_id`;

export async function listCases(q: OnboardingListQuery): Promise<Paged<OnboardingCaseRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(c.legal_name LIKE ? OR c.trade_name LIKE ? OR c.gstin LIKE ?)");
    params.push(like, like, like);
  }
  if (q.stage) {
    where.push("oc.stage = ?");
    params.push(q.stage);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await query<OnboardingCaseRow>(
    `${SELECT} ${whereSql}
      ORDER BY FIELD(oc.stage, 'registered', 'assessment', 'proposal_sent', 'accepted', 'rejected'), oc.updated_at DESC, oc.id DESC
      LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM onboarding_cases oc JOIN clients c ON c.id = oc.client_id ${whereSql}`,
    params,
  );
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export async function stageCounts(): Promise<StageCounts> {
  const rows = await query<{ stage: OnboardingStage; n: number }>(`SELECT stage, COUNT(*) AS n FROM onboarding_cases GROUP BY stage`);
  const counts = Object.fromEntries(ONBOARDING_STAGES.map((s) => [s, 0])) as StageCounts;
  for (const r of rows) counts[r.stage] = r.n;
  return counts;
}

export function findCase(id: number, db: Db = pool) {
  return queryOne<OnboardingCaseRow>(`${SELECT} WHERE oc.id = ?`, [id], db);
}

export interface LockedCase {
  id: number;
  client_id: number;
  stage: OnboardingStage;
  complexity: string | null;
  suggested_package_id: number | null;
  suggested_monthly_fee: number | null;
  package_source: "team" | "client" | null;
}

const LOCK_COLUMNS = "id, client_id, stage, complexity, suggested_package_id, suggested_monthly_fee, package_source";

/** Locks the case row for a stage change. */
export function lockCase(id: number, db: PoolConnection) {
  return queryOne<LockedCase>(`SELECT ${LOCK_COLUMNS} FROM onboarding_cases WHERE id = ? FOR UPDATE`, [id], db);
}

/** Locks the client's latest onboarding case (a client normally has one), to keep it in step with the engagement. */
export function lockLatestCaseForClient(clientId: number, db: PoolConnection) {
  return queryOne<LockedCase>(`SELECT ${LOCK_COLUMNS} FROM onboarding_cases WHERE client_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE`, [clientId], db);
}

/** Copies the engagement's package and fee onto the case, optionally moving its stage or marking it accepted. */
export async function syncPackage(
  id: number,
  input: { packageId: number; fee: number | null; source: "team" | "client"; stage?: OnboardingStage; acceptedBy?: number; acceptedVia?: "client" | "team" },
  db: Db = pool,
) {
  const accepting = input.acceptedVia ? 1 : 0;
  await execute(
    `UPDATE onboarding_cases
        SET suggested_package_id = ?, suggested_monthly_fee = ?, package_source = ?, stage = COALESCE(?, stage),
            accepted_at  = IF(? = 1, COALESCE(accepted_at, UTC_TIMESTAMP()), accepted_at),
            accepted_by  = IF(? = 1, COALESCE(accepted_by, ?), accepted_by),
            accepted_via = IF(? = 1, COALESCE(accepted_via, ?), accepted_via)
      WHERE id = ?`,
    [input.packageId, input.fee, input.source, input.stage ?? null, accepting, accepting, input.acceptedBy ?? null, accepting, input.acceptedVia ?? null, id],
    db,
  );
}

export async function insertCase(clientId: number, notes: string | null, db: Db = pool) {
  const r = await execute(`INSERT INTO onboarding_cases (client_id, stage, notes) VALUES (?, 'registered', ?)`, [clientId, notes], db);
  return r.insertId;
}

export async function updateAssessment(id: number, input: AssessmentInput, packageSource: "team" | "client" | null, actorId: number, db: Db = pool) {
  await execute(
    `UPDATE onboarding_cases
        SET monthly_transaction_volume = ?, complexity = ?, suggested_package_id = ?, suggested_monthly_fee = ?, package_source = ?, notes = ?, proposal_message = ?, assessed_by = ?
      WHERE id = ?`,
    [input.monthly_transaction_volume, input.complexity, input.suggested_package_id, input.suggested_monthly_fee, packageSource, input.notes, input.proposal_message ?? null, actorId, id],
    db,
  );
}

export async function setStage(id: number, stage: OnboardingStage, db: Db = pool) {
  await execute(`UPDATE onboarding_cases SET stage = ? WHERE id = ?`, [stage, id], db);
}

export async function markProposalSent(id: number, db: Db = pool) {
  await execute(`UPDATE onboarding_cases SET proposal_sent_at = UTC_TIMESTAMP() WHERE id = ?`, [id], db);
}

export async function markAccepted(id: number, by: number, via: "client" | "team", db: Db = pool) {
  await execute(`UPDATE onboarding_cases SET accepted_at = UTC_TIMESTAMP(), accepted_by = ?, accepted_via = ? WHERE id = ?`, [by, via, id], db);
}

/** The client's open proposal (or the one they accepted), for the client portal. */
export function clientProposal(clientId: number) {
  return queryOne<{
    id: number; stage: OnboardingStage; package_id: number; package_name: string; package_description: string | null; billing_cycle: string;
    scope_notes: string | null; monthly_fee: number; message: string | null; sent_at: string | null; sent_by: string | null;
    accepted_at: string | null; accepted_via: "client" | "team" | null; services: string | null; team_roles: string[];
  }>(
    `SELECT oc.id, oc.stage, p.id AS package_id, p.name AS package_name, p.description AS package_description, p.billing_cycle, p.scope_notes, p.team_roles,
            oc.suggested_monthly_fee AS monthly_fee, oc.proposal_message AS message, oc.proposal_sent_at AS sent_at, u.full_name AS sent_by,
            oc.accepted_at, oc.accepted_via,
            (SELECT GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR '||') FROM package_services ps JOIN services s ON s.id = ps.service_id WHERE ps.package_id = p.id) AS services
       FROM onboarding_cases oc JOIN packages p ON p.id = oc.suggested_package_id LEFT JOIN users u ON u.id = oc.assessed_by
      WHERE oc.client_id = ? AND oc.stage IN ('proposal_sent', 'accepted')
      ORDER BY oc.id DESC LIMIT 1`,
    [clientId],
  );
}

export const getServiceRequirements = (caseId: number, db: Db = pool) =>
  queryOne<OnboardingServiceRequirements>(`SELECT * FROM onboarding_service_requirements WHERE case_id = ?`, [caseId], db);

export async function upsertServiceRequirements(caseId: number, input: ServiceRequirementsInput, db: Db = pool) {
  await execute(
    `INSERT INTO onboarding_service_requirements (case_id, bookkeeping, gst_filing, income_tax_filing, payroll, audit_support, other_services, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      bookkeeping = VALUES(bookkeeping), gst_filing = VALUES(gst_filing), income_tax_filing = VALUES(income_tax_filing),
      payroll = VALUES(payroll), audit_support = VALUES(audit_support), other_services = VALUES(other_services), notes = VALUES(notes)`,
    [caseId, input.bookkeeping ? 1 : 0, input.gst_filing ? 1 : 0, input.income_tax_filing ? 1 : 0, input.payroll ? 1 : 0, input.audit_support ? 1 : 0, input.other_services, input.notes],
    db,
  );
  return getServiceRequirements(caseId, db);
}
