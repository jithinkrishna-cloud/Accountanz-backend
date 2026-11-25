/**
 * Client portal queries. Every query takes the client id from the resolved ClientContext, never
 * from the request, so a client user can only ever read their own company's rows.
 */
import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne } from "../../database/connection.js";
import { activeAssignmentSql } from "../access/client-access.js";
import { MESSAGE_EDIT_SQL, MESSAGE_MENTIONS_SQL } from "../communication/communication.repository.js";
import type { MessageRow } from "../communication/communication.types.js";

type Db = PoolConnection | typeof pool;

export function findMembership(userId: number) {
  return queryOne<{ client_id: number; client_name: string; client_status: string; role: "owner" | "member"; can_approve: 0 | 1 }>(
    `SELECT cu.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, c.status AS client_status, cu.role, cu.can_approve
       FROM client_users cu JOIN clients c ON c.id = cu.client_id
      WHERE cu.user_id = ? AND c.status <> 'exited'
      ORDER BY cu.role = 'owner' DESC, cu.client_id
      LIMIT 1`,
    [userId],
  );
}

// ── Dashboard ──
export async function dashboard(clientId: number, period: string) {
  return (await queryOne<{
    tasks_done: number; tasks_total: number; open_requests: number; pending_approvals: number;
    reports: number; outstanding: number; next_meeting_title: string | null; next_meeting_at: string | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE client_id = ? AND period = ? AND client_visible = 1 AND status = 'approved') AS tasks_done,
       (SELECT COUNT(*) FROM tasks WHERE client_id = ? AND period = ? AND client_visible = 1) AS tasks_total,
       (SELECT COUNT(*) FROM document_requests WHERE client_id = ? AND status = 'open') AS open_requests,
       (SELECT COUNT(*) FROM client_approvals WHERE client_id = ? AND status = 'pending') AS pending_approvals,
       (SELECT COUNT(*) FROM published_reports WHERE client_id = ? AND published_date IS NOT NULL) AS reports,
       (SELECT COALESCE(SUM(i.total - COALESCE((SELECT SUM(amount) FROM service_payments WHERE invoice_id = i.id), 0)), 0)
          FROM service_invoices i JOIN engagements e ON e.id = i.engagement_id
         WHERE e.client_id = ? AND i.status IN ('issued', 'overdue')) AS outstanding,
       (SELECT title FROM meetings WHERE client_id = ? AND starts_at >= UTC_TIMESTAMP() ORDER BY starts_at LIMIT 1) AS next_meeting_title,
       (SELECT starts_at FROM meetings WHERE client_id = ? AND starts_at >= UTC_TIMESTAMP() ORDER BY starts_at LIMIT 1) AS next_meeting_at`,
    [clientId, period, clientId, period, clientId, clientId, clientId, clientId, clientId, clientId],
  ))!;
}

// ── Business, team, software ──
export const business = (clientId: number) =>
  queryOne<Record<string, unknown>>(
    `SELECT legal_name, trade_name, business_type, date_of_establishment, gstin, pan, state, address,
            primary_contact_name, primary_contact_email, primary_contact_phone, status, accounting_software
       FROM clients WHERE id = ?`,
    [clientId],
  );

// Progressive-onboarding profile, read-only in the portal. Column lists are explicit on purpose: internal notes and
// stakeholders' personal identifiers/contact details (PAN, DIN, address, email, phone) stay with Accountanz staff.
export const taxDetails = (clientId: number) =>
  queryOne<Record<string, unknown>>(
    `SELECT pan_number, pan_status, gstin, gstin_status, tan_number, tan_status, cin, cin_status, llpin, llpin_status,
            msme_udyam_number, msme_status, professional_tax_registration, professional_tax_status
       FROM company_tax_details WHERE client_id = ?`,
    [clientId],
  );

export const stakeholders = (clientId: number) =>
  query<Record<string, unknown>>(
    `SELECT id, stakeholder_type, full_name, designation, ownership_percentage, is_primary
       FROM company_stakeholders WHERE client_id = ? ORDER BY is_primary DESC, id ASC`,
    [clientId],
  );

export const financialProfile = (clientId: number) =>
  queryOne<Record<string, unknown>>(
    `SELECT financial_year_start_month, annual_turnover, monthly_transaction_volume, employee_count, monthly_invoice_count, current_accounting_software
       FROM company_financial_profile WHERE client_id = ?`,
    [clientId],
  );

/** Requirements captured on the company's most recent onboarding case. */
export const serviceRequirements = (clientId: number) =>
  queryOne<Record<string, unknown>>(
    `SELECT r.bookkeeping, r.gst_filing, r.income_tax_filing, r.payroll, r.audit_support, r.other_services
       FROM onboarding_service_requirements r JOIN onboarding_cases oc ON oc.id = r.case_id
      WHERE oc.client_id = ? ORDER BY oc.id DESC LIMIT 1`,
    [clientId],
  );
export const branches = (clientId: number) =>
  query<{ id: number; name: string; gstin: string | null }>(`SELECT id, name, gstin FROM client_branches WHERE client_id = ? ORDER BY name`, [clientId]);

export const team = (clientId: number) =>
  query<{ assignment_id: number; user_id: number; full_name: string; email: string; team_role: string }>(
    `SELECT a.id AS assignment_id, u.id AS user_id, u.full_name, u.email, a.team_role FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")} AND u.status = 'active'
      ORDER BY FIELD(a.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name`,
    [clientId],
  );

export const software = (clientId: number) =>
  query<{ provider: string; external_org_name: string | null; external_org_id: string | null; status: string; last_health_check: string | null; verified_at: string | null; authorized_at: string | null; session_until: string | null }>(
    `SELECT provider, external_org_name, external_org_id, status, last_health_check, verified_at, authorized_at,
            CASE WHEN access_token_enc IS NOT NULL AND token_expires_at > UTC_TIMESTAMP() THEN token_expires_at END AS session_until
       FROM integration_connections WHERE client_id = ? AND provider = 'journl' ORDER BY provider`,
    [clientId],
  );

export const lockJournlConnection = (clientId: number, conn: PoolConnection) =>
  queryOne<{ id: number; status: string; external_org_id: string | null }>(
    `SELECT id, status, external_org_id FROM integration_connections WHERE client_id = ? AND provider = 'journl' FOR UPDATE`,
    [clientId],
    conn,
  );

/** The owner withdrew access; the organisation details stay so they can reconnect, the verification does not. */
export async function disconnectJournlConnection(id: number, conn: PoolConnection) {
  await execute(
    `UPDATE integration_connections SET status = 'disconnected', disconnected_at = UTC_TIMESTAMP(), last_error = NULL,
            verified_by = NULL, verified_at = NULL, verification_note = NULL, authorized_by = NULL, authorized_at = NULL, access_token_enc = NULL, token_expires_at = NULL WHERE id = ?`,
    [id],
    conn,
  );
}

// ── Documents & requests ──
export const listDocuments = (clientId: number) =>
  query<{ id: number; file_name: string; category: string; period: string | null; status: string; review_note: string | null; created_at: string; uploaded_by: string | null; request_id: number | null; folder_id: number | null; size_bytes: number | null; from_client: 0 | 1 }>(
    `SELECT d.id, d.file_name, d.category, d.period, d.status, d.review_note, d.created_at, u.full_name AS uploaded_by, d.request_id, d.folder_id, d.size_bytes,
            COALESCE(u.portal_role IN ('client_owner', 'client_member'), 0) AS from_client
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.client_id = ? ORDER BY d.created_at DESC, d.id DESC`,
    [clientId],
  );

export const findDocument = (clientId: number, id: number) =>
  queryOne<{ id: number; file_name: string; file_path: string }>(`SELECT id, file_name, file_path FROM documents WHERE id = ? AND client_id = ?`, [id, clientId]);

export const listRequests = (clientId: number) =>
  query<{ id: number; description: string; due_date: string | null; period: string | null; status: string; requested_by: string | null; requested_by_id: number | null; requested_by_role: string | null; files: number }>(
    `SELECT r.id, r.description, r.due_date, r.period, r.status, u.full_name AS requested_by, r.requested_by AS requested_by_id,
            COALESCE((SELECT a.team_role FROM assignments a WHERE a.user_id = r.requested_by AND a.client_id = r.client_id
                       ORDER BY a.status = 'active' DESC, FIELD(a.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper') LIMIT 1), u.portal_role) AS requested_by_role,
            (SELECT COUNT(*) FROM documents d WHERE d.request_id = r.id) AS files
       FROM document_requests r LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.client_id = ? AND r.status <> 'cancelled'
      ORDER BY r.status = 'open' DESC, r.due_date IS NULL, r.due_date, r.id`,
    [clientId],
  );

/** The task each request belongs to (only client-visible tasks), keyed by request id. */
export const requestTasks = (clientId: number) =>
  query<{ request_id: number; task_id: number; title: string; status: string; period: string }>(
    `SELECT r.id AS request_id, t.id AS task_id, t.title, t.status, t.period
       FROM document_requests r JOIN tasks t ON t.id = r.task_id
      WHERE r.client_id = ? AND t.client_visible = 1`,
    [clientId],
  );

/** Files sent for this client's requests, oldest first. */
export const requestFiles = (clientId: number) =>
  query<{ request_id: number; id: number; file_name: string; created_at: string }>(
    `SELECT d.request_id, d.id, d.file_name, d.created_at FROM documents d
      WHERE d.client_id = ? AND d.request_id IS NOT NULL ORDER BY d.created_at, d.id`,
    [clientId],
  );

export const lockOpenRequest = (clientId: number, id: number, db: PoolConnection) =>
  queryOne<{ id: number; description: string; requested_by: number | null; period: string | null }>(
    `SELECT id, description, requested_by, period FROM document_requests WHERE id = ? AND client_id = ? AND status = 'open' FOR UPDATE`,
    [id, clientId],
    db,
  );

export async function insertDocument(d: { clientId: number; requestId: number | null; folderId?: number | null; userId: number; category: string; period: string | null; path: string; name: string; mime: string; size: number }, db: Db) {
  const r = await execute(
    `INSERT INTO documents (client_id, request_id, folder_id, uploaded_by, category, period, file_path, file_name, mime_type, size_bytes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    [d.clientId, d.requestId, d.folderId ?? null, d.userId, d.category, d.period, d.path, d.name, d.mime, d.size],
    db,
  );
  return r.insertId;
}

/** A document of this client with everything needed to send it for a request. */
export const findDocumentForRequest = (clientId: number, id: number, db: Db) =>
  queryOne<{ id: number; file_name: string; file_path: string; mime_type: string | null; size_bytes: number | null; category: string; period: string | null; folder_id: number | null; request_id: number | null }>(
    `SELECT id, file_name, file_path, mime_type, size_bytes, category, period, folder_id, request_id FROM documents WHERE id = ? AND client_id = ?`,
    [id, clientId],
    db,
  );

export const linkDocumentToRequest = (id: number, requestId: number, db: PoolConnection) =>
  execute(`UPDATE documents SET request_id = ? WHERE id = ?`, [requestId, id], db);

export const fulfilRequest = (id: number, db: PoolConnection) => execute(`UPDATE document_requests SET status = 'fulfilled' WHERE id = ?`, [id], db);

// ── Tasks & reports ──
export const visibleTasks = (clientId: number, period: string) =>
  query<{ id: number; title: string; description: string | null; status: string; due_date: string | null; checklist: { text: string; done: boolean }[]; assignee_id: number | null; handled_by: string | null; reviewer_id: number | null; checked_by: string | null; created_by_client: 0 | 1 }>(
    `SELECT t.id, t.title, t.description, t.status, t.due_date, t.checklist, t.assignee_id, a.full_name AS handled_by, t.reviewer_id, r.full_name AS checked_by,
            EXISTS (SELECT 1 FROM client_users cu WHERE cu.user_id = t.created_by AND cu.client_id = t.client_id) AS created_by_client
       FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users r ON r.id = t.reviewer_id
      WHERE t.client_id = ? AND t.period = ? AND t.client_visible = 1 ORDER BY t.due_date IS NULL, t.due_date, t.id`,
    [clientId, period],
  );

export const taskPeriods = (clientId: number) =>
  query<{ period: string }>(`SELECT DISTINCT period FROM tasks WHERE client_id = ? AND client_visible = 1 ORDER BY period DESC LIMIT 12`, [clientId]);

export const listReports = (clientId: number) =>
  query<{ id: number; period: string; report_type: string; file_name: string | null; summary: string | null; published_date: string }>(
    `SELECT id, period, report_type, file_name, summary, published_date FROM published_reports
      WHERE client_id = ? AND published_date IS NOT NULL ORDER BY period DESC, published_date DESC`,
    [clientId],
  );

export const findReport = (clientId: number, id: number) =>
  queryOne<{ file_name: string | null; file_path: string | null }>(
    `SELECT file_name, file_path FROM published_reports WHERE id = ? AND client_id = ? AND published_date IS NOT NULL`,
    [id, clientId],
  );

// ── Approvals ──
export const listApprovals = (clientId: number) =>
  query<{
    id: number; subject: string; description: string | null; status: string; requested_by: string | null; requested_by_role: string | null;
    decided_by: string | null; decided_at: string | null; comment: string | null; created_at: string;
    task_id: number | null; task_title: string | null; task_period: string | null; task_status: string | null;
  }>(
    `SELECT a.id, a.subject, a.description, a.status, rq.full_name AS requested_by,
            COALESCE((SELECT x.team_role FROM assignments x WHERE x.user_id = a.requested_by AND x.client_id = a.client_id
                       ORDER BY x.status = 'active' DESC, FIELD(x.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper') LIMIT 1), rq.portal_role) AS requested_by_role,
            dc.full_name AS decided_by, a.decided_at, a.comment, a.created_at,
            t.id AS task_id, t.title AS task_title, t.period AS task_period, t.status AS task_status
       FROM client_approvals a LEFT JOIN users rq ON rq.id = a.requested_by LEFT JOIN users dc ON dc.id = a.decided_by
       LEFT JOIN tasks t ON t.id = a.related_task_id AND t.client_visible = 1
      WHERE a.client_id = ? ORDER BY a.status = 'pending' DESC, a.created_at DESC`,
    [clientId],
  );

export const lockApproval = (clientId: number, id: number, db: PoolConnection) =>
  queryOne<{ id: number; subject: string; status: string; requested_by: number | null }>(
    `SELECT id, subject, status, requested_by FROM client_approvals WHERE id = ? AND client_id = ? FOR UPDATE`,
    [id, clientId],
    db,
  );

export const decideApproval = (id: number, status: string, userId: number, comment: string | null, db: PoolConnection) =>
  execute(`UPDATE client_approvals SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(), comment = ? WHERE id = ?`, [status, userId, comment, id], db);

// ── Messages & meetings ──
export const listThreads = (clientId: number) =>
  query<{ id: number; subject: string | null; created_at: string; messages: number; last_at: string | null; last_body: string | null; last_author: string | null; last_author_id: number | null }>(
    `SELECT t.id, t.subject, t.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = t.id) AS last_at,
            (SELECT m.body FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
            (SELECT u.full_name FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_author,
            (SELECT m.author_id FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_author_id
       FROM message_threads t WHERE t.client_id = ? AND t.visibility = 'client' ORDER BY COALESCE(last_at, t.created_at) DESC`,
    [clientId],
  );

export const findThread = (clientId: number, id: number) =>
  queryOne<{ id: number; subject: string | null }>(`SELECT id, subject FROM message_threads WHERE id = ? AND client_id = ? AND visibility = 'client'`, [id, clientId]);

export const threadMessages = (threadId: number) =>
  query<MessageRow>(
    `SELECT m.id, m.body, m.created_at, ${MESSAGE_EDIT_SQL}, u.full_name AS author, m.author_id, u.portal_role IN ('client_owner', 'client_member') AS from_client, ${MESSAGE_MENTIONS_SQL}
       FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = ? ORDER BY m.created_at, m.id`,
    [threadId],
  );

export async function insertThread(clientId: number, userId: number, subject: string, db: PoolConnection) {
  return (await execute(`INSERT INTO message_threads (client_id, subject, visibility, created_by) VALUES (?, ?, 'client', ?)`, [clientId, subject, userId], db)).insertId;
}
export async function insertMessage(threadId: number, userId: number, body: string, db: Db) {
  return (await execute(`INSERT INTO messages (thread_id, author_id, body) VALUES (?, ?, ?)`, [threadId, userId, body], db)).insertId;
}

export const listMeetings = (clientId: number) =>
  query<{ id: number; title: string; starts_at: string; ends_at: string; meeting_link: string | null; organiser: string | null; attendees: string | null }>(
    `SELECT mt.id, mt.title, mt.starts_at, mt.ends_at, mt.meeting_link, u.full_name AS organiser,
            (SELECT GROUP_CONCAT(ma.email ORDER BY ma.email SEPARATOR ', ') FROM meeting_attendees ma WHERE ma.meeting_id = mt.id) AS attendees
       FROM meetings mt LEFT JOIN users u ON u.id = mt.organiser_id WHERE mt.client_id = ? ORDER BY mt.starts_at DESC`,
    [clientId],
  );

// ── Billing ──
export const activePackage = (clientId: number) =>
  queryOne<{ package_name: string; monthly_fee: number; billing_cycle: string; scope_notes: string | null; start_date: string | null; renewal_date: string | null }>(
    `SELECT p.name AS package_name, COALESCE(e.monthly_fee, p.monthly_fee) AS monthly_fee, p.billing_cycle, p.scope_notes, e.start_date, e.renewal_date
       FROM engagements e JOIN packages p ON p.id = e.package_id WHERE e.client_id = ? AND e.status = 'active' ORDER BY e.start_date DESC LIMIT 1`,
    [clientId],
  );

export const invoices = (clientId: number) =>
  query<{ id: number; invoice_number: string; period: string; amount: number; gst_amount: number; total: number; due_date: string; status: string; paid: number }>(
    `SELECT i.id, i.invoice_number, i.period, i.amount, i.gst_amount, i.total, i.due_date, i.status,
            COALESCE((SELECT SUM(amount) FROM service_payments WHERE invoice_id = i.id), 0) AS paid
       FROM service_invoices i JOIN engagements e ON e.id = i.engagement_id
      WHERE e.client_id = ? AND i.status NOT IN ('draft', 'cancelled') ORDER BY i.period DESC, i.id DESC`,
    [clientId],
  );

export const payments = (clientId: number) =>
  query<{ id: number; invoice_number: string; amount: number; paid_date: string; method: string; reference: string | null }>(
    `SELECT sp.id, i.invoice_number, sp.amount, sp.paid_date, sp.method, sp.reference
       FROM service_payments sp JOIN service_invoices i ON i.id = sp.invoice_id JOIN engagements e ON e.id = i.engagement_id
      WHERE e.client_id = ? ORDER BY sp.paid_date DESC, sp.id DESC`,
    [clientId],
  );

// ── Settings ──
export const profile = (userId: number) =>
  queryOne<{ full_name: string; email: string; phone: string | null; notification_prefs: Record<string, boolean> | null }>(
    `SELECT full_name, email, phone, notification_prefs FROM users WHERE id = ?`,
    [userId],
  );

export async function updateProfile(userId: number, changes: { full_name?: string; phone?: string | null; notification_prefs?: Record<string, boolean> }) {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (changes.full_name !== undefined) (sets.push("full_name = ?"), params.push(changes.full_name));
  if (changes.phone !== undefined) (sets.push("phone = ?"), params.push(changes.phone));
  if (changes.notification_prefs !== undefined) (sets.push("notification_prefs = ?"), params.push(JSON.stringify(changes.notification_prefs)));
  if (sets.length) await execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...params, String(userId)]);
}

// ── Packages (client chooses a package) ──
export interface OpenEngagement {
  id: number;
  status: "draft" | "sent" | "accepted" | "active";
  package_id: number;
  package_name: string;
}

/** The client's engagement that hasn't ended (at most one), with its package. Locks it when given a transaction. */
export const openEngagement = (clientId: number, conn?: PoolConnection) =>
  queryOne<OpenEngagement>(
    `SELECT e.id, e.status, e.package_id, p.name AS package_name
       FROM engagements e JOIN packages p ON p.id = e.package_id
      WHERE e.client_id = ? AND e.status <> 'ended' ORDER BY e.id DESC LIMIT 1 ${conn ? "FOR UPDATE" : ""}`,
    [clientId],
    conn,
  );

// ── Accountant overview (one team member, everything they do for this client) ──
/** The person's active roles on this client today. Empty = not on the client's team (the overview then 404s). */
export const memberOnTeam = (clientId: number, userId: number) =>
  query<{ user_id: number; full_name: string; email: string; phone: string | null; team_role: string; valid_from: string }>(
    `SELECT u.id AS user_id, u.full_name, u.email, u.phone, a.team_role, DATE_FORMAT(a.valid_from, '%Y-%m-%d') AS valid_from
       FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND a.user_id = ? AND ${activeAssignmentSql("a")} AND u.status = 'active'
      ORDER BY FIELD(a.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper')`,
    [clientId, userId],
  );

/** Client-visible tasks the person does or checks (or, for a CFO who oversees the account, every task), open work first. */
export const memberTasks = (clientId: number, userId: number, oversees = false) =>
  query<{ id: number; title: string; description: string | null; period: string; status: string; due_date: string | null; checklist: { text: string; done: boolean }[]; assignee_id: number | null; handled_by: string | null; reviewer_id: number | null; checked_by: string | null }>(
    `SELECT t.id, t.title, t.description, t.period, t.status, t.due_date, t.checklist, t.assignee_id, a.full_name AS handled_by, t.reviewer_id, r.full_name AS checked_by
       FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users r ON r.id = t.reviewer_id
      WHERE t.client_id = ? AND t.client_visible = 1 AND (? OR t.assignee_id = ? OR t.reviewer_id = ?)
      ORDER BY t.status = 'approved', t.period DESC, t.due_date IS NULL, t.due_date, t.id
      LIMIT 200`,
    [clientId, oversees, userId, userId],
  );

export const memberRequests = (clientId: number, userId: number) =>
  query<{ id: number; description: string; due_date: string | null; period: string | null; status: string; files: number }>(
    `SELECT r.id, r.description, r.due_date, r.period, r.status, (SELECT COUNT(*) FROM documents d WHERE d.request_id = r.id) AS files
       FROM document_requests r
      WHERE r.client_id = ? AND r.requested_by = ? AND r.status <> 'cancelled'
      ORDER BY r.status = 'open' DESC, r.due_date IS NULL, r.due_date, r.id DESC`,
    [clientId, userId],
  );

export const memberApprovals = (clientId: number, userId: number) =>
  query<{ id: number; subject: string; status: string; created_at: string; decided_at: string | null }>(
    `SELECT a.id, a.subject, a.status, a.created_at, a.decided_at FROM client_approvals a
      WHERE a.client_id = ? AND a.requested_by = ? ORDER BY a.status = 'pending' DESC, a.created_at DESC`,
    [clientId, userId],
  );

/** Client-visible conversations the person has written in, latest activity first. */
export const memberThreads = (clientId: number, userId: number) =>
  query<{ id: number; subject: string | null; messages: number; last_at: string | null; last_body: string | null; last_author: string | null }>(
    `SELECT t.id, t.subject,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = t.id) AS last_at,
            (SELECT m.body FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
            (SELECT u.full_name FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_author
       FROM message_threads t
      WHERE t.client_id = ? AND t.visibility = 'client' AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.author_id = ?)
      ORDER BY COALESCE(last_at, t.created_at) DESC
      LIMIT 20`,
    [clientId, userId],
  );

/** Meetings the person organises or attends, upcoming first, then the most recent. */
export const memberMeetings = (clientId: number, userId: number) =>
  query<{ id: number; title: string; starts_at: string; ends_at: string; meeting_link: string | null }>(
    `SELECT mt.id, mt.title, mt.starts_at, mt.ends_at, mt.meeting_link FROM meetings mt
      WHERE mt.client_id = ? AND (mt.organiser_id = ? OR EXISTS (SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id = mt.id AND ma.user_id = ?))
      ORDER BY mt.starts_at < UTC_TIMESTAMP(), CASE WHEN mt.starts_at >= UTC_TIMESTAMP() THEN mt.starts_at END, mt.starts_at DESC
      LIMIT 10`,
    [clientId, userId, userId],
  );
