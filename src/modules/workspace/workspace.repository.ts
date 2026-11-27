import { query, queryOne } from "../../database/connection.js";
import { activeAssignmentSql } from "../access/client-access.js";
import type { Scope } from "../documents/document.repository.js";
import type { MyClientRow, WorkspaceTask } from "./workspace.types.js";

/**
 * Read-only aggregations for the accountant workspace. Every query is restricted by the caller's client scope
 * (clientScope from the access module), so admins see every client and staff only today's assignments.
 */
const OPEN_TASK = "t.status <> 'approved'";
const OVERDUE = "(t.due_date < CURDATE() AND t.status IN ('todo', 'in_progress', 'returned'))";

export async function taskCounts(userId: number) {
  return (await queryOne<{ assigned: number; overdue: number; returned: number; to_review: number; due_week: number }>(
    `SELECT
       SUM(t.assignee_id = ? AND ${OPEN_TASK} AND t.status <> 'submitted') AS assigned,
       SUM(t.assignee_id = ? AND ${OVERDUE}) AS overdue,
       SUM(t.assignee_id = ? AND t.status = 'returned') AS returned,
       SUM(t.reviewer_id = ? AND t.status = 'submitted') AS to_review,
       SUM(t.assignee_id = ? AND t.status IN ('todo', 'in_progress', 'returned') AND t.due_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY) AS due_week
     FROM tasks t WHERE t.assignee_id = ? OR t.reviewer_id = ?`,
    [userId, userId, userId, userId, userId, userId, userId],
  ))!;
}

/** My open work, most urgent first: overdue, then by due date. */
export const myOpenTasks = (userId: number, limit: number) =>
  query<WorkspaceTask>(
    `SELECT t.id, t.title, t.client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, t.period, t.status, t.due_date, ${OVERDUE} AS overdue
       FROM tasks t JOIN clients c ON c.id = t.client_id
      WHERE (t.assignee_id = ? AND t.status IN ('todo', 'in_progress', 'returned')) OR (t.reviewer_id = ? AND t.status = 'submitted')
      ORDER BY ${OVERDUE} DESC, t.due_date IS NULL, t.due_date, t.id LIMIT ?`,
    [userId, userId, limit],
  );

export async function clientActivity(scope: Scope) {
  return (await queryOne<{ open_requests: number; pending_approvals: number; awaiting_reply: number; draft_reports: number }>(
    `SELECT
       (SELECT COUNT(*) FROM document_requests r WHERE r.status = 'open' AND ${scope.sql.replaceAll("{c}", "r.client_id")}) AS open_requests,
       (SELECT COUNT(*) FROM client_approvals a WHERE a.status = 'pending' AND ${scope.sql.replaceAll("{c}", "a.client_id")}) AS pending_approvals,
       (SELECT COUNT(*) FROM message_threads t WHERE t.visibility = 'client' AND ${scope.sql.replaceAll("{c}", "t.client_id")}
          AND (SELECT u.portal_role IN ('client_owner', 'client_member') FROM messages m JOIN users u ON u.id = m.author_id
                WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)) AS awaiting_reply,
       (SELECT COUNT(*) FROM published_reports p WHERE p.published_date IS NULL AND ${scope.sql.replaceAll("{c}", "p.client_id")}) AS draft_reports`,
    [...scope.params, ...scope.params, ...scope.params, ...scope.params],
  ))!;
}

export const upcomingMeetings = (scope: Scope, limit: number) =>
  query<{ id: number; title: string; client_name: string; starts_at: string; meeting_link: string | null }>(
    `SELECT mt.id, mt.title, COALESCE(c.trade_name, c.legal_name) AS client_name, mt.starts_at, mt.meeting_link
       FROM meetings mt JOIN clients c ON c.id = mt.client_id
      WHERE mt.ends_at >= UTC_TIMESTAMP() AND ${scope.sql.replaceAll("{c}", "mt.client_id")} ORDER BY mt.starts_at LIMIT ?`,
    [...scope.params, limit],
  );

export const myClients = (userId: number, scope: Scope, period: string) =>
  query<MyClientRow>(
    `SELECT c.id, COALESCE(c.trade_name, c.legal_name) AS name, c.legal_name, c.status,
            COALESCE((SELECT GROUP_CONCAT(DISTINCT a.team_role ORDER BY a.team_role) FROM assignments a WHERE a.client_id = c.id AND a.user_id = ? AND ${activeAssignmentSql("a")}), '') AS roles,
            (SELECT p.name FROM engagements e JOIN packages p ON p.id = e.package_id WHERE e.client_id = c.id AND e.status = 'active' ORDER BY e.start_date DESC LIMIT 1) AS package_name,
            (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND ${OPEN_TASK}) AS open_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND ${OVERDUE}) AS overdue_tasks,
            (SELECT COUNT(*) FROM document_requests r WHERE r.client_id = c.id AND r.status = 'open') AS open_requests,
            (SELECT COUNT(*) FROM message_threads t WHERE t.client_id = c.id AND t.visibility = 'client'
               AND (SELECT u.portal_role IN ('client_owner', 'client_member') FROM messages m JOIN users u ON u.id = m.author_id
                     WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)) AS awaiting_reply,
            COALESCE((SELECT pc.status FROM period_closings pc WHERE pc.client_id = c.id AND pc.period = ?), 'open') AS closing_status
       FROM clients c WHERE c.status <> 'exited' AND ${scope.sql.replaceAll("{c}", "c.id")} ORDER BY name`,
    [userId, period, ...scope.params],
  );

export const clientOptions = (scope: Scope) =>
  query<{ value: number; label: string }>(
    `SELECT c.id AS value, COALESCE(c.trade_name, c.legal_name) AS label FROM clients c
      WHERE c.status <> 'exited' AND ${scope.sql.replaceAll("{c}", "c.id")} ORDER BY label`,
    scope.params,
  );

// ── Client overview ──
export const clientFacts = (id: number) =>
  queryOne<{ id: number; name: string; legal_name: string; gstin: string | null; pan: string | null; state: string | null; status: string; accounting_software: string }>(
    `SELECT id, COALESCE(trade_name, legal_name) AS name, legal_name, gstin, pan, state, status, accounting_software FROM clients WHERE id = ?`,
    [id],
  );

export const activeEngagement = (clientId: number) =>
  queryOne<{ id: number; package_name: string; scope_notes: string | null; start_date: string | null; renewal_date: string | null; services: string | null }>(
    `SELECT e.id, p.name AS package_name, p.scope_notes, e.start_date, e.renewal_date,
            (SELECT GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR '||') FROM package_services ps JOIN services s ON s.id = ps.service_id WHERE ps.package_id = p.id) AS services
       FROM engagements e JOIN packages p ON p.id = e.package_id WHERE e.client_id = ? AND e.status = 'active' ORDER BY e.start_date DESC LIMIT 1`,
    [clientId],
  );

export const clientTeam = (clientId: number) =>
  query<{ user_id: number; full_name: string; email: string; team_role: string }>(
    `SELECT u.id AS user_id, u.full_name, u.email, a.team_role FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")} ORDER BY FIELD(a.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name`,
    [clientId],
  );

export const clientContacts = (clientId: number) =>
  query<{ full_name: string; email: string; role: string; can_approve: 0 | 1 }>(
    `SELECT u.full_name, u.email, cu.role, cu.can_approve FROM client_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.client_id = ? AND u.status = 'active' ORDER BY cu.role = 'owner' DESC, u.full_name`,
    [clientId],
  );
