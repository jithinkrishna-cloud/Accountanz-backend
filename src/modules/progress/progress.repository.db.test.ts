import type { PoolConnection } from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../database/connection.js";
import { monthRange } from "./progress.service.js";
import { clientBreakdown, findSummary, firmClients, personTasks } from "./progress.repository.js";

/**
 * The progress SQL against a real database: one person, one client and a task in each state, all inside a
 * transaction that is rolled back. Run with RUN_DB_TESTS=1.
 */
describe.skipIf(process.env.RUN_DB_TESTS !== "1")("progress queries (real DB)", () => {
  afterAll(() => pool.end());

  async function withFixture(fn: (conn: PoolConnection, ids: { userId: number; clientId: number; period: string }) => Promise<void>) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[{ period }]] = await conn.query<any[]>("SELECT DATE_FORMAT(CURDATE(), '%Y-%m') AS period");
      const tag = `zz-progress-${Date.now()}`;
      const [u] = await conn.query<any>("INSERT INTO users (email, full_name, portal_role, status) VALUES (?, 'Progress Test', 'bookkeeper', 'active')", [`${tag}@example.test`]);
      const userId = u.insertId;
      await conn.query("INSERT INTO staff_profiles (user_id, staff_type) VALUES (?, 'accountant')", [userId]);
      const [c] = await conn.query<any>("INSERT INTO clients (legal_name, status) VALUES (?, 'active')", [tag]);
      const clientId = c.insertId;
      await conn.query("INSERT INTO assignments (client_id, user_id, team_role, valid_from) VALUES (?, ?, 'bookkeeper', CURDATE() - INTERVAL 1 DAY)", [clientId, userId]);

      const task = async (title: string, status: string, due: string | null, p = period) => {
        const [r] = await conn.query<any>(
          `INSERT INTO tasks (client_id, period, title, checklist, assignee_id, status, due_date) VALUES (?, ?, ?, '[]', ?, ?, ${due ?? "NULL"})`,
          [clientId, p, title, userId, status],
        );
        return r.insertId as number;
      };
      await task("overdue todo", "todo", "CURDATE() - INTERVAL 1 DAY");
      const inProgress = await task("in progress, due later", "in_progress", "CURDATE() + INTERVAL 1 DAY");
      const returned = await task("returned, no due date", "returned", null);
      await task("submitted past due (not overdue: it's with the reviewer)", "submitted", "CURDATE() - INTERVAL 3 DAY");
      const approved = await task("approved", "approved", null);
      await task("old approved task from another period", "approved", null, "2001-01");

      await conn.query("INSERT INTO task_reviews (task_id, decision) VALUES (?, 'approved')", [approved]);
      await conn.query("INSERT INTO task_reviews (task_id, decision) VALUES (?, 'returned')", [returned]);
      await conn.query("INSERT INTO work_logs (task_id, user_id, minutes, logged_on) VALUES (?, ?, 90, CURDATE())", [inProgress, userId]);

      await fn(conn, { userId, clientId, period });
    } finally {
      await conn.rollback();
      conn.release();
    }
  }

  it("counts a person's open, overdue, review, approved and returned work, and time logged", async () => {
    await withFixture(async (conn, { userId, period }) => {
      const s = await findSummary(userId, monthRange(period), conn);
      expect(s).toMatchObject({ active_clients: 1 });
      expect(Number(s!.open_tasks)).toBe(3); // todo + in progress + returned
      expect(Number(s!.overdue)).toBe(1); // only the open one past its due date
      expect(Number(s!.awaiting_review)).toBe(1);
      expect(Number(s!.approved)).toBe(1); // review decisions this month, not task status
      expect(Number(s!.returned)).toBe(1);
      expect(Number(s!.minutes)).toBe(90);
    });
  });

  it("breaks the work down by client, limiting the month column to that period", async () => {
    await withFixture(async (conn, { userId, clientId, period }) => {
      const [row] = await clientBreakdown(userId, period, conn);
      expect(row).toMatchObject({ client_id: clientId, roles: "bookkeeper" });
      expect(Number(row!.period_total)).toBe(5); // the 2001-01 task is excluded
      expect(Number(row!.period_approved)).toBe(1);
      expect(Number(row!.open_tasks)).toBe(3);
      expect(Number(row!.overdue)).toBe(1);
      expect(Number(row!.awaiting_review)).toBe(1);
    });
  });

  it("lists tasks per view with matching counts and paging", async () => {
    await withFixture(async (conn, { userId }) => {
      const page1 = await personTasks(userId, { view: "open", page: 1, pageSize: 2 }, conn);
      expect(page1.total).toBe(3);
      expect(page1.items).toHaveLength(2);
      expect(page1.items[0]!.title).toBe("overdue todo"); // overdue first
      expect(Object.fromEntries(Object.entries(page1.counts!).map(([k, v]) => [k, Number(v)]))).toEqual({
        open: 3, overdue: 1, review: 1, returned: 1, approved: 2, all: 6,
      });
      const overdue = await personTasks(userId, { view: "overdue", page: 1, pageSize: 20 }, conn);
      expect(overdue.items.map((t) => t.title)).toEqual(["overdue todo"]);
      const search = await personTasks(userId, { view: "all", q: "returned", page: 1, pageSize: 20 }, conn);
      expect(search.items.map((t) => t.title)).toEqual(["returned, no due date"]);
    });
  });

  it("shows the client on firm progress with the same numbers", async () => {
    await withFixture(async (conn, { clientId, period }) => {
      const row = (await firmClients(period, conn)).find((c) => c.client_id === clientId);
      expect(row).toMatchObject({ status: "active", closing_status: "open" });
      expect([row!.period_total, row!.period_approved, row!.open_tasks, row!.overdue, row!.awaiting_review].map(Number)).toEqual([5, 1, 3, 1, 1]);
    });
  });
});
