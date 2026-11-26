import { query, queryOne } from "../../database/connection.js";
import { activeAssignmentSql } from "../access/client-access.js";

export interface Contact {
  email: string;
  full_name: string;
}

export const findActiveContact = (userId: number | null) =>
  userId ? queryOne<Contact>(`SELECT email, full_name FROM users WHERE id = ? AND status = 'active'`, [userId]) : Promise.resolve(null);

/** Client portal users who should hear about billing: owners, plus anyone allowed to approve. */
export const listBillingContacts = (clientId: number) =>
  query<Contact>(
    `SELECT u.email, u.full_name FROM client_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.client_id = ? AND u.status = 'active' AND (cu.role = 'owner' OR cu.can_approve = 1)`,
    [clientId],
  );

export const countReviews = async (taskId: number) =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM task_reviews WHERE task_id = ?`, [taskId]))?.n ?? 0;

export function findInvoiceForEmail(invoiceId: number) {
  return queryOne<{ id: number; invoice_number: string; period: string; amount: number; gst_amount: number; total: number; due_date: string; client_id: number; client_name: string }>(
    `SELECT i.id, i.invoice_number, i.period, i.amount, i.gst_amount, i.total, i.due_date, c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name
       FROM service_invoices i JOIN engagements e ON e.id = i.engagement_id JOIN clients c ON c.id = e.client_id
      WHERE i.id = ?`,
    [invoiceId],
  );
}

/** The client's accounting team today (who should hear about client messages). */
export const listClientTeamContacts = (clientId: number) =>
  query<Contact>(
    `SELECT DISTINCT u.email, u.full_name FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ? AND ${activeAssignmentSql("a")} AND u.status = 'active'`,
    [clientId],
  );

/** A client's active owners (who receive proposals). */
export const listOwnerContacts = (clientId: number) =>
  query<Contact>(
    `SELECT u.email, u.full_name FROM client_users cu JOIN users u ON u.id = cu.user_id WHERE cu.client_id = ? AND cu.role = 'owner' AND u.status = 'active'`,
    [clientId],
  );

/** A proposal with what the emails need. */
export const findProposalForEmail = (caseId: number) =>
  queryOne<{ client_id: number; company: string; package_name: string; fee: number; billing_cycle: string; message: string | null; sent_by: string | null; assessor_email: string | null; assessor_name: string | null; accepted_by: string | null; accepted_via: "client" | "team" | null; services: string | null }>(
    `SELECT oc.client_id, COALESCE(c.trade_name, c.legal_name) AS company, p.name AS package_name, oc.suggested_monthly_fee AS fee, p.billing_cycle,
            oc.proposal_message AS message, u.full_name AS sent_by, u.email AS assessor_email, u.full_name AS assessor_name,
            ab.full_name AS accepted_by, oc.accepted_via,
            (SELECT GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR '||') FROM package_services ps JOIN services s ON s.id = ps.service_id WHERE ps.package_id = p.id) AS services
       FROM onboarding_cases oc JOIN clients c ON c.id = oc.client_id JOIN packages p ON p.id = oc.suggested_package_id
       LEFT JOIN users u ON u.id = oc.assessed_by AND u.status = 'active' LEFT JOIN users ab ON ab.id = oc.accepted_by
      WHERE oc.id = ?`,
    [caseId],
  );

/** Active admins (who hear about companies registering themselves). */
export const listAdminContacts = () =>
  query<Contact>(`SELECT email, full_name FROM users WHERE portal_role IN ('super_admin', 'ops_admin') AND status = 'active'`);

export function findRegistrationForEmail(caseId: number) {
  return queryOne<{ client_id: number; company: string; gstin: string | null; state: string | null; owner_name: string; owner_email: string }>(
    `SELECT c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS company, c.gstin, c.state, u.full_name AS owner_name, u.email AS owner_email
       FROM onboarding_cases oc JOIN clients c ON c.id = oc.client_id
       JOIN client_users cu ON cu.client_id = c.id AND cu.role = 'owner' JOIN users u ON u.id = cu.user_id
      WHERE oc.id = ? ORDER BY cu.user_id LIMIT 1`,
    [caseId],
  );
}

export type ClientPref = "document_requests" | "approvals" | "reports";

/** Active portal users of a client; with a preference, only those who haven't switched it off (default on). */
export const listClientContacts = (clientId: number, pref?: ClientPref, approversOnly = false) =>
  query<Contact & { id: number }>(
    `SELECT u.id, u.email, u.full_name FROM client_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.client_id = ? AND u.status = 'active'
        ${approversOnly ? "AND (cu.role = 'owner' OR cu.can_approve = 1)" : ""}
        ${pref ? "AND COALESCE(JSON_EXTRACT(u.notification_prefs, ?), CAST('true' AS JSON)) = CAST('true' AS JSON)" : ""}`,
    pref ? [clientId, `$.${pref}`] : [clientId],
  );

export const findClientName = async (clientId: number) =>
  (await queryOne<{ name: string }>(`SELECT COALESCE(trade_name, legal_name) AS name FROM clients WHERE id = ?`, [clientId]))?.name ?? "your company";

/** Today's team on a client plus every staff member who has written in the thread (internal notes reach both). */
export const listThreadStaff = (clientId: number, threadId: number) =>
  query<Contact & { id: number }>(
    `SELECT DISTINCT u.id, u.email, u.full_name FROM users u
      WHERE u.status = 'active' AND u.portal_role NOT IN ('client_owner', 'client_member')
        AND (u.id IN (SELECT a.user_id FROM assignments a WHERE a.client_id = ? AND ${activeAssignmentSql("a")})
             OR u.id IN (SELECT m.author_id FROM messages m WHERE m.thread_id = ?))`,
    [clientId, threadId],
  );
