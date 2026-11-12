/**
 * Loads demo data modelled on the existing Accountanz workspace. Wipes all application tables first.
 * Development only. All demo users share the password in SEED_PASSWORD.
 */
import bcrypt from "bcryptjs";
import type { PoolConnection } from "mysql2/promise";
import { env, isProd } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { execute, pool, query, withTransaction, type Param } from "../connection.js";

const ins = async (conn: PoolConnection, table: string, row: Record<string, Param>) => {
  const keys = Object.keys(row);
  const r = await execute(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(row), conn);
  return r.insertId;
};

const period = (offsetMonths = 0) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMonths);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const dayOf = (p: string, day: number) => `${p}-${String(day).padStart(2, "0")}`;

async function main() {
  if (isProd) throw new Error("Refusing to seed a production database");
  if (!env.SEED_PASSWORD || env.SEED_PASSWORD.length < 8) throw new Error("Set SEED_PASSWORD (8+ characters) in .env");
  const hash = await bcrypt.hash(env.SEED_PASSWORD, 12);

  await withTransaction(async (conn) => {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    const tables = await query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_name <> 'schema_migrations'`,
      [env.DB_NAME],
      conn,
    );
    for (const { t } of tables) await conn.query(`TRUNCATE TABLE \`${t}\``);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");

    await ins(conn, "app_settings", {
      id: 1,
      company_name: "Accountanz",
      legal_name: "Accountanz Managed Services Pvt Ltd",
      gstin: "32AABCA1234B1Z9",
      pan: "AABCA1234B",
      address: "2nd Floor, Skyline Chambers, Kochi, Kerala",
      email: "hello@accountanz.in",
      phone: "+91 484 400 1122",
      gst_rate: 18,
    });

    // ── People ──
    const user = (email: string, full_name: string, portal_role: string, phone: string | null = null) =>
      ins(conn, "users", { email, full_name, portal_role, phone, password_hash: hash, status: "active" });
    const staff = async (email: string, name: string, role: string, type: "accountant" | "employee", rate: number, expertise: string[], phone: string) => {
      const id = await user(email, name, role, phone);
      await ins(conn, "staff_profiles", {
        user_id: id,
        staff_type: type,
        hourly_rate: rate,
        expertise: JSON.stringify(expertise),
        verification_status: "verified",
        bank_account_name: type === "accountant" ? name : null,
        bank_account_number: type === "accountant" ? `0000${String(id).padStart(8, "0")}` : null, // demo, not a real account
        bank_ifsc: type === "accountant" ? "DEMO0000001" : null,
      });
      return id;
    };

    const admin = await user("admin@accountanz.in", "Accountanz Admin", "super_admin");
    const ops = await staff("ops@accountanz.in", "Neha Kapoor", "ops_admin", "employee", 500, ["Client onboarding", "Billing"], "+91 99001 22334");
    const meera = await staff("meera@accountanz.in", "Meera Joshi", "finance_manager", "accountant", 850, ["Month-end close", "Ind AS reporting"], "+91 98200 33445");
    const vikram = await staff("vikram@accountanz.in", "Vikram Rao", "bookkeeper", "accountant", 420, ["Bookkeeping", "TDS"], "+91 96320 77881");
    const rahul = await staff("rahul@accountanz.in", "Rahul Verma", "bookkeeper", "accountant", 400, ["Bookkeeping", "GST"], "+91 98450 11223");
    const sneha = await staff("sneha@accountanz.in", "Sneha Iyer", "cfo", "accountant", 1200, ["Financial reporting", "Statutory audit"], "+91 99000 44556");
    const arun = await staff("arun@accountanz.in", "Arun Menon", "bookkeeper", "accountant", 450, ["Bookkeeping", "Payroll"], "+91 97440 55667");
    const priya = await staff("priya@accountanz.in", "Priya Nair", "finance_manager", "accountant", 900, ["GST", "Reviews"], "+91 98950 66778");

    // ── Catalogue ──
    const svc = (code: string, name: string, description: string) => ins(conn, "services", { code, name, description });
    const bk = await svc("BK-M", "Monthly Bookkeeping", "Recording, reconciliation and month-end close support.");
    const gst = await svc("GST-R", "GST Filing", "GSTR-1 and GSTR-3B preparation and filing.");
    const pay = await svc("PAY-R", "Payroll Processing", "Salary processing, statutory deductions and payslips.");
    const rep = await svc("REP-M", "Financial Reporting", "Monthly MIS pack with P&L, balance sheet and cash flow.");

    const growth = await ins(conn, "packages", {
      name: "Growth Compliance",
      description: "Bookkeeping, GST, payroll and monthly reporting.",
      monthly_fee: 48000,
      billing_cycle: "monthly",
      scope_notes: "Up to 1,200 transactions a month. Multi-branch. Quarterly review call with the CFO.",
    });
    const basic = await ins(conn, "packages", {
      name: "Monthly Bookkeeping",
      description: "Core bookkeeping and compliance for growing businesses.",
      monthly_fee: 25000,
      billing_cycle: "monthly",
      scope_notes: "Up to 500 transactions a month. Two bank accounts. GST returns filed by the 20th.",
    });
    for (const s of [bk, gst, pay, rep]) await ins(conn, "package_services", { package_id: growth, service_id: s });
    for (const s of [bk, gst]) await ins(conn, "package_services", { package_id: basic, service_id: s });

    // ── Task templates (as in the existing workspace: all items sit under Monthly Bookkeeping) ──
    const bookkeepingTpl = await ins(conn, "task_templates", { service_id: bk, name: "Monthly Bookkeeping", recurrence: "monthly", due_day_of_period: 10 });
    await ins(conn, "task_templates", { service_id: gst, name: "GST Return Filing", recurrence: "monthly", due_day_of_period: 18 });
    await ins(conn, "task_templates", { service_id: rep, name: "Monthly MIS Pack", recurrence: "monthly", due_day_of_period: 25 });
    const templateItems: [string, string[], boolean][] = [
      ["Bank reconciliations", ["Statements received for every account", "Unreconciled items explained"], true],
      ["Sales register posting", ["Sales export received", "Invoices posted and tied to GSTR-1"], true],
      ["Purchase register posting", ["Purchase bills received", "Bills posted with correct GST"], true],
      ["GST output tax review", ["Output tax agreed to sales register", "Variances explained"], true],
      ["Vendor ledger scrutiny", ["Debit balances reviewed", "Duplicate bills checked"], false],
      ["Customer ledger scrutiny", ["Credit balances reviewed", "Ageing over 90 days flagged"], false],
      ["TDS payable check", ["TDS deducted on all eligible payments", "Payable agreed to challans"], true],
      ["Payroll journal entries", ["Salary register reconciled", "Statutory dues booked"], true],
      ["Fixed asset register update", ["Additions capitalised", "Depreciation posted"], false],
      ["Month-end accruals", ["Accrual list agreed with client", "Entries posted"], false],
      ["Trial balance review", ["Suspense accounts cleared", "Ratio check completed"], true],
      ["Management accounts pack", ["P&L and balance sheet drafted", "Variances commented"], true],
    ];
    for (const [k, [title, checklist, visible]] of templateItems.entries()) {
      await ins(conn, "task_template_items", { template_id: bookkeepingTpl, title, checklist: JSON.stringify(checklist), client_visible: visible, sort_order: k + 1 });
    }

    // ── Clients ──
    const clientDefs = [
      ["ABC Traders Pvt Ltd", "ABC Traders", "32ABCDE1234F1Z5", "ABCDE1234F", "Kerala", "active", "journl", growth, 48000],
      ["Kaveri Constructions Pvt Ltd", "Kaveri Constructions", "29AAFCC2233R1Z8", "AAFCC2233R", "Karnataka", "active", "journl", basic, 25000],
      ["Zenith Pharma Distributors", "Zenith Pharma", "36AAGCZ9911T1Z5", "AAGCZ9911T", "Telangana", "active", "journl", basic, 25000],
      ["Bluewave Retail Pvt Ltd", "Bluewave Retail", "29AAECB7788P1ZQ", "AAECB7788P", "Karnataka", "active", "zoho_books", growth, 48000],
      ["Sunrise Foods Pvt Ltd", "Sunrise Foods", "33AAHCS4455K1Z2", "AAHCS4455K", "Tamil Nadu", "active", "journl", basic, 25000],
      ["Meridian Textiles LLP", "Meridian Textiles", "24AAJFM3344N1Z6", "AAJFM3344N", "Gujarat", "active", "zoho_books", basic, 25000],
      ["Lotus Ayurveda Works", "Lotus Ayurveda", "24AAHCL9012M1Z7", "AAHCL9012M", "Gujarat", "active", "none", basic, 25000],
      ["Nimbus Logistics Pvt Ltd", "Nimbus Logistics", "33AAGCN5678L1Z3", "AAGCN5678L", "Tamil Nadu", "onboarding", "none", null, 0],
      ["XYZ Enterprises", "XYZ Enterprises", null, null, "Maharashtra", "onboarding", "none", null, 0],
    ] as const;

    const cur = period(0);
    const prev = period(-1);
    let invoiceSeq = 1000;
    const bookkeepers = [arun, vikram, rahul];
    const reviewers = [priya, meera];

    for (const [i, [legal_name, trade_name, gstin, pan, state, status, software, pkg, fee]] of clientDefs.entries()) {
      const clientId = await ins(conn, "clients", { legal_name, trade_name, gstin, pan, state, status, accounting_software: software, address: `${state}, India` });

      if (status === "onboarding") {
        await ins(conn, "onboarding_cases", {
          client_id: clientId,
          stage: i % 2 ? "registered" : "proposal_sent",
          monthly_transaction_volume: i % 2 ? null : 820,
          complexity: i % 2 ? null : "medium",
          assessed_by: i % 2 ? null : ops,
          suggested_package_id: i % 2 ? null : growth,
          suggested_monthly_fee: i % 2 ? null : 48000,
          notes: i % 2 ? null : "Two branches on Zoho Books. Needs GST plus payroll.",
        });
        continue;
      }

      const engagementId = await ins(conn, "engagements", {
        client_id: clientId,
        package_id: pkg!,
        status: "active",
        start_date: dayOf(period(-6 + (i % 3)), 1),
        renewal_date: dayOf(period(6 + (i % 3)), 28),
      });
      if (software !== "none") {
        await ins(conn, "integration_connections", {
          client_id: clientId,
          provider: software,
          external_org_name: legal_name,
          external_org_id: `${software === "journl" ? "JL" : "ZB"}-${trade_name.slice(0, 3).toUpperCase()}-${7700 + i}`,
          status: "connected",
        });
      }

      const bookkeeper = bookkeepers[i % bookkeepers.length]!;
      const reviewer = reviewers[i % reviewers.length]!;
      await ins(conn, "assignments", { client_id: clientId, user_id: bookkeeper, team_role: "bookkeeper", valid_from: dayOf(period(-6), 1), journl_access: software === "journl" });
      await ins(conn, "assignments", { client_id: clientId, user_id: reviewer, team_role: "finance_manager", valid_from: dayOf(period(-6), 1) });
      if (i === 0) await ins(conn, "assignments", { client_id: clientId, user_id: sneha, team_role: "cfo", valid_from: dayOf(period(-6), 1) });

      // Last period: all approved and closed. Current period: a mix of states.
      const titles = ["Bank reconciliation", "Sales register posting", "GST output tax review", "Month-end accruals"];
      for (const [p, closed] of [[prev, true], [cur, false]] as const) {
        for (const [k, title] of titles.entries()) {
          const st = closed ? "approved" : (["approved", "submitted", "in_progress", "todo"] as const)[(k + i) % 4];
          const submittedAt = st === "submitted" ? new Date(Date.now() - (k + 1) * 86400000) : st === "approved" ? `${dayOf(p, 8 + k)} 10:00:00` : null;
          const taskId = await ins(conn, "tasks", {
            client_id: clientId,
            engagement_id: engagementId,
            period: p,
            title,
            checklist: JSON.stringify([{ text: "Documents received", done: st !== "todo" }, { text: "Entries posted", done: st === "approved" || st === "submitted" }]),
            created_by: ops,
            assignee_id: bookkeeper,
            reviewer_id: reviewer,
            status: st,
            due_date: dayOf(p, 10 + k * 5),
            submitted_at: submittedAt,
          });
          // Work logged on everything started; reviews on everything approved (one in five needed a resubmission).
          if (st !== "todo") {
            await ins(conn, "work_logs", { task_id: taskId, user_id: bookkeeper, minutes: 45 + ((i + k) % 4) * 15, note: `${title} working`, logged_on: dayOf(p, 5 + k) });
          }
          if (st === "approved") {
            const resubmitted = (i + k) % 5 === 0;
            if (resubmitted) {
              await ins(conn, "task_reviews", { task_id: taskId, reviewer_id: reviewer, decision: "returned", comments: "Supporting schedule missing.", submission_number: 1, created_at: `${dayOf(p, 9 + k)} 12:00:00` });
            }
            await ins(conn, "task_reviews", { task_id: taskId, reviewer_id: reviewer, decision: "approved", comments: "Checked against the source documents.", submission_number: resubmitted ? 2 : 1, created_at: `${dayOf(p, 10 + k)} 15:00:00` });
            await ins(conn, "work_logs", { task_id: taskId, user_id: reviewer, minutes: 20, note: "Review", logged_on: dayOf(p, 10 + k) });
          }
        }
        await ins(conn, "period_closings", { client_id: clientId, period: p, status: closed ? "closed" : "open", closed_by: closed ? reviewer : null, closed_at: closed ? new Date() : null });
      }

      // Documents and requests. Demo rows reference storage keys with no uploaded file behind them.
      const requestId = await ins(conn, "document_requests", { client_id: clientId, requested_by: bookkeeper, description: "Bank statements for all current accounts", due_date: dayOf(cur, 14 + i), period: cur, status: "open" });
      await ins(conn, "documents", {
        client_id: clientId,
        request_id: i % 2 ? requestId : null,
        uploaded_by: bookkeeper,
        category: (["bank_statement", "sales_invoice", "purchase_bill", "gst", "receipt", "other"] as const)[i % 6],
        period: prev,
        file_path: `documents/demo/${clientId}-statement.pdf`,
        file_name: `${trade_name.replace(/\s+/g, "-")}-statement.pdf`,
        mime_type: "application/pdf",
        status: i % 3 ? "reviewed" : "new",
      });

      const amount = fee;
      const gstAmount = Math.round(amount * 0.18 * 100) / 100;
      for (const [p, paid] of [[prev, true], [cur, false]] as const) {
        const invoiceId = await ins(conn, "service_invoices", {
          engagement_id: engagementId,
          invoice_number: `ACC-${p.replace("-", "")}-${++invoiceSeq}`,
          period: p,
          amount,
          gst_rate: 18,
          gst_amount: gstAmount,
          total: amount + gstAmount,
          due_date: dayOf(p, 28),
          status: paid ? "paid" : "issued",
        });
        if (paid) {
          await ins(conn, "service_payments", { invoice_id: invoiceId, amount: amount + gstAmount, paid_date: dayOf(p, 26), method: i % 2 ? "upi" : "bank_transfer", reference: `NEFT-${880000 + i}`, recorded_by: ops });
        }
      }

      await ins(conn, "audit_logs", { actor_id: reviewer, actor_email: null, actor_role: "finance_manager", client_id: clientId, action: "Period closed", entity_type: "PeriodClosing", entity_id: prev, details: `${prev} closed for ${trade_name}` });
    }

    // Fill actor e-mails for the seeded audit rows (snapshots, as the service would write them).
    await conn.query(`UPDATE audit_logs a JOIN users u ON u.id = a.actor_id SET a.actor_email = u.email WHERE a.actor_email IS NULL`);
    await ins(conn, "audit_logs", { actor_id: admin, actor_email: "admin@accountanz.in", actor_role: "super_admin", action: "Workspace seeded", entity_type: "AppSetting", entity_id: "1", details: "Demo data loaded" });

    const kb = (title: string, category: string, summary: string, body: string) => ins(conn, "knowledge_articles", { title, category, summary, body, updated_by: admin });
    await kb("Submitting a task for review", "Task workflow", "What a bookkeeper must check before hitting Submit for review.", "Every checklist item on the task must be ticked, supporting documents attached, and time logged.");
    await kb("Month-end close: the standard order", "Month-end", "The order we work through a client's month, and who signs off on each step.", "1. All tasks for the period approved.\n2. Reports prepared and approved.\n3. Finance manager closes the period.");
    await kb("Rejecting a client document", "Documents", "Always give a reason the client can act on.", "When a document is unusable, reject it with a short note telling the client exactly what to resend.");
  });

  logger.info("Seed complete. Sign in as admin@accountanz.in with SEED_PASSWORD.");
  await pool.end();
}

main().catch(async (err) => {
  logger.error(err, "Seed failed");
  await pool.end();
  process.exit(1);
});
