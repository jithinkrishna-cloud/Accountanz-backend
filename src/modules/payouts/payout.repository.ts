import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne } from "../../database/connection.js";
import type { PayoutRow, PayoutSummary } from "./payout.types.js";

const SELECT = `
  SELECT po.id, po.user_id, u.full_name, u.email, po.period, po.minutes, po.hourly_rate, po.amount, po.status,
         po.paid_date, po.reference, RIGHT(sp.bank_account_number, 4) AS bank_account_last4, sp.verification_status
    FROM accountant_payouts po
    JOIN users u ON u.id = po.user_id
    LEFT JOIN staff_profiles sp ON sp.user_id = po.user_id`;

export const listPayouts = (period: string) => query<PayoutRow>(`${SELECT} WHERE po.period = ? ORDER BY u.full_name`, [period]);

export const findPayout = (id: number, conn?: PoolConnection) =>
  queryOne<PayoutRow>(`${SELECT} WHERE po.id = ?${conn ? " FOR UPDATE" : ""}`, [id], conn);

/** Payable = draft + approved; paid = paid; logged = every accountant's work-log minutes in the period. */
export async function payoutSummary(period: string): Promise<PayoutSummary> {
  return (await queryOne<PayoutSummary>(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM accountant_payouts WHERE period = ? AND status IN ('draft', 'approved')) AS payable,
            (SELECT COALESCE(SUM(amount), 0) FROM accountant_payouts WHERE period = ? AND status = 'paid') AS paid,
            (SELECT COALESCE(SUM(w.minutes), 0) FROM work_logs w JOIN staff_profiles sp ON sp.user_id = w.user_id
              WHERE sp.staff_type = 'accountant' AND DATE_FORMAT(w.logged_on, '%Y-%m') = ?) AS logged_minutes`,
    [period, period, period],
  ))!;
}

/** Draft + approved total, read on the run's own connection so it includes uncommitted rows. */
export async function payableTotal(period: string, conn: PoolConnection) {
  return (
    (await queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM accountant_payouts WHERE period = ? AND status IN ('draft', 'approved')`,
      [period],
      conn,
    ))?.total ?? 0
  );
}

/** Logged minutes per accountant for the period, with their current hourly rate and verification. */
export function loggedMinutesByAccountant(period: string, conn: PoolConnection) {
  return query<{ user_id: number; full_name: string; minutes: number; hourly_rate: number | null; verification_status: string }>(
    `SELECT w.user_id, u.full_name, SUM(w.minutes) AS minutes, sp.hourly_rate, sp.verification_status
       FROM work_logs w JOIN staff_profiles sp ON sp.user_id = w.user_id JOIN users u ON u.id = w.user_id
      WHERE sp.staff_type = 'accountant' AND w.logged_on BETWEEN ? AND LAST_DAY(?)
      GROUP BY w.user_id, u.full_name, sp.hourly_rate, sp.verification_status`,
    [`${period}-01`, `${period}-01`],
    conn,
  );
}

export function existingPayouts(period: string, conn: PoolConnection) {
  return query<{ id: number; user_id: number; status: string }>(
    `SELECT id, user_id, status FROM accountant_payouts WHERE period = ? FOR UPDATE`,
    [period],
    conn,
  );
}

export async function insertPayout(p: { userId: number; period: string; minutes: number; rate: number; amount: number }, conn: PoolConnection) {
  await execute(
    `INSERT INTO accountant_payouts (user_id, period, minutes, hourly_rate, amount, status) VALUES (?, ?, ?, ?, ?, 'draft')`,
    [p.userId, p.period, p.minutes, p.rate, p.amount],
    conn,
  );
}

export async function refreshDraft(id: number, minutes: number, rate: number, amount: number, conn: PoolConnection) {
  await execute(`UPDATE accountant_payouts SET minutes = ?, hourly_rate = ?, amount = ? WHERE id = ? AND status = 'draft'`, [minutes, rate, amount, id], conn);
}

export async function approvePayout(id: number, approvedBy: number, conn: PoolConnection) {
  await execute(`UPDATE accountant_payouts SET status = 'approved', approved_by = ? WHERE id = ?`, [approvedBy, id], conn);
}

export async function markPaid(id: number, reference: string | null, conn: PoolConnection) {
  await execute(`UPDATE accountant_payouts SET status = 'paid', paid_date = CURDATE(), reference = ? WHERE id = ?`, [reference, id], conn);
}
