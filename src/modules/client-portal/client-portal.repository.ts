/**
 * Client portal queries. Every query takes the client id from the resolved ClientContext, never
 * from the request, so a client user can only ever read their own company's rows.
 */
import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne } from "../../database/connection.js";
import { activeAssignmentSql } from "../access/client-access.js";

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
    `SELECT legal_name, trade_name, gstin, pan, state, address, status, accounting_software FROM clients WHERE id = ?`,
    [clientId],
  );
export const branches = (clientId: number) =>
  query<{ id: number; name: string; gstin: string | null }>(`SELECT id, name, gstin FROM client_branches WHERE client_id = ? ORDER BY name`, [clientId]);

export const team = (clientId: number) =>
  query<{ full_name: string; email: string; team_role: string }>(
    `SELECT u.full_name, u.email, a.team_role FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")} AND u.status = 'active'
      ORDER BY FIELD(a.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name`,
    [clientId],
  );

export const software = (clientId: number) =>
  query<{ provider: string; external_org_name: string | null; status: string; last_health_check: string | null }>(
    `SELECT provider, external_org_name, status, last_health_check FROM integration_connections WHERE client_id = ? ORDER BY provider`,
    [clientId],
  );

export const lockJournlConnection = (clientId: number, conn: PoolConnection) =>
  queryOne<{ id: number; status: string }>(`SELECT id, status FROM integration_connections WHERE client_id = ? AND provider = 'journl' FOR UPDATE`, [clientId], conn);

/** Saves the client's JournL organisation as a pending connection for the Accountanz team to verify. */
export async function saveJournlConnection(clientId: number, existingId: number | null, name: string, orgId: string, conn: PoolConnection) {
  if (existingId) {
    await execute(
      `UPDATE integration_connections SET external_org_name = ?, external_org_id = ?, status = 'pending', last_error = NULL, last_health_check = NULL WHERE id = ?`,
      [name, orgId, existingId],
      conn,
    );
    return existingId;
  }
  const r = await execute(
    `INSERT INTO integration_connections (client_id, provider, external_org_name, external_org_id, status) VALUES (?, 'journl', ?, ?, 'pending')`,
    [clientId, name, orgId],
    conn,
  );
  return r.insertId;
}

// ── Documents & requests ──
export const listDocuments = (clientId: number) =>
  query<{ id: number; file_name: string; category: string; period: string | null; status: string; review_note: string | null; created_at: string; uploaded_by: string | null; request_id: number | null }>(
    `SELECT d.id, d.file_name, d.category, d.period, d.status, d.review_note, d.created_at, u.full_name AS uploaded_by, d.request_id
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.client_id = ? ORDER BY d.created_at DESC, d.id DESC`,
    [clientId],
  );

export const findDocument = (clientId: number, id: number) =>
  queryOne<{ id: number; file_name: string; file_path: string }>(`SELECT id, file_name, file_path FROM documents WHERE id = ? AND client_id = ?`, [id, clientId]);

export const listRequests = (clientId: number) =>
  query<{ id: number; description: string; due_date: string | null; period: string | null; status: string; requested_by: string | null; requested_by_id: number | null; files: number }>(
    `SELECT r.id, r.description, r.due_date, r.period, r.status, u.full_name AS requested_by, r.requested_by AS requested_by_id,
            (SELECT COUNT(*) FROM documents d WHERE d.request_id = r.id) AS files
       FROM document_requests r LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.client_id = ? AND r.status <> 'cancelled'
      ORDER BY r.status = 'open' DESC, r.due_date IS NULL, r.due_date, r.id`,
    [clientId],
  );

export const lockOpenRequest = (clientId: number, id: number, db: PoolConnection) =>
  queryOne<{ id: number; description: string; requested_by: number | null; period: string | null }>(
    `SELECT id, description, requested_by, period FROM document_requests WHERE id = ? AND client_id = ? AND status = 'open' FOR UPDATE`,
    [id, clientId],
    db,
  );

export async function insertDocument(d: { clientId: number; requestId: number | null; userId: number; category: string; period: string | null; path: string; name: string; mime: string; size: number }, db: Db) {
  const r = await execute(
    `INSERT INTO documents (client_id, request_id, uploaded_by, category, period, file_path, file_name, mime_type, size_bytes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    [d.clientId, d.requestId, d.userId, d.category, d.period, d.path, d.name, d.mime, d.size],
    db,
  );
  return r.insertId;
}

export const fulfilRequest = (id: number, db: PoolConnection) => execute(`UPDATE document_requests SET status = 'fulfilled' WHERE id = ?`, [id], db);

// ── Tasks & reports ──
export const visibleTasks = (clientId: number, period: string) =>
  query<{ id: number; title: string; status: string; due_date: string | null; checklist: { text: string; done: boolean }[] }>(
    `SELECT id, title, status, due_date, checklist FROM tasks WHERE client_id = ? AND period = ? AND client_visible = 1 ORDER BY due_date IS NULL, due_date, id`,
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
  query<{ id: number; subject: string; description: string | null; status: string; requested_by: string | null; decided_by: string | null; decided_at: string | null; comment: string | null; created_at: string }>(
    `SELECT a.id, a.subject, a.description, a.status, rq.full_name AS requested_by, dc.full_name AS decided_by, a.decided_at, a.comment, a.created_at
       FROM client_approvals a LEFT JOIN users rq ON rq.id = a.requested_by LEFT JOIN users dc ON dc.id = a.decided_by
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
  query<{ id: number; subject: string | null; created_at: string; messages: number; last_at: string | null; last_body: string | null; last_author: string | null }>(
    `SELECT t.id, t.subject, t.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = t.id) AS last_at,
            (SELECT m.body FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
            (SELECT u.full_name FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_author
       FROM message_threads t WHERE t.client_id = ? ORDER BY COALESCE(last_at, t.created_at) DESC`,
    [clientId],
  );

export const findThread = (clientId: number, id: number) =>
  queryOne<{ id: number; subject: string | null }>(`SELECT id, subject FROM message_threads WHERE id = ? AND client_id = ?`, [id, clientId]);

export const threadMessages = (threadId: number) =>
  query<{ id: number; body: string; created_at: string; author: string | null; author_id: number | null; from_client: 0 | 1 }>(
    `SELECT m.id, m.body, m.created_at, u.full_name AS author, m.author_id, u.portal_role IN ('client_owner', 'client_member') AS from_client
       FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = ? ORDER BY m.created_at, m.id`,
    [threadId],
  );

export async function insertThread(clientId: number, userId: number, subject: string, db: PoolConnection) {
  return (await execute(`INSERT INTO message_threads (client_id, subject, created_by) VALUES (?, ?, ?)`, [clientId, subject, userId], db)).insertId;
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
    `SELECT p.name AS package_name, p.monthly_fee, p.billing_cycle, p.scope_notes, e.start_date, e.renewal_date
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
