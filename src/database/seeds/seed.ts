/**
 * Loads demo data modelled on the existing Accountanz workspace. Development only.
 *
 * Master data is kept: settings, the service/package catalogue, task templates, the knowledge base, JournL modules,
 * staff accounts, and the Workspace (spaces, work items, sprints, comments, attachments). Missing master rows are added; existing ones (and staff passwords) are left untouched.
 * Everything else is wiped and reseeded: clients and all their work, client logins, sessions, tokens and audit logs.
 * New staff accounts get SEED_PASSWORD; demo client logins get 12345678.
 */
import bcrypt from "bcryptjs";
import type { PoolConnection } from "mysql2/promise";
import { env, isProd } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { execute, pool, query, withTransaction, type Param } from "../connection.js";
import { addApprovals, addReports, deleteReportFiles } from "./demo-deliverables.js";
import { JOURNL_AREAS, JOURNL_FEATURE_LIST } from "../../modules/integrations/journl-features.js";

const ins = async (conn: PoolConnection, table: string, row: Record<string, Param>) => {
  const keys = Object.keys(row);
  const r = await execute(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(row), conn);
  return r.insertId;
};
const insIgnore = async (conn: PoolConnection, table: string, row: Record<string, Param>) => {
  const keys = Object.keys(row);
  await execute(`INSERT IGNORE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(row), conn);
};
/** Id of the row matching `where`, inserting `row` first if there is none. */
const ensure = async (conn: PoolConnection, table: string, where: Record<string, Param>, row: Record<string, Param> = {}) => {
  const cols = Object.keys(where);
  const found = await query<{ id: number }>(`SELECT id FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")} LIMIT 1`, Object.values(where), conn);
  return found[0]?.id ?? ins(conn, table, { ...where, ...row });
};

/** Kept between seeds. Every other table (except users, handled below) is wiped. */
const MASTER_TABLES = new Set([
  "schema_migrations",
  "app_settings",
  "services",
  "packages",
  "package_services",
  "task_templates",
  "task_template_items",
  "knowledge_articles",
  "journl_modules",
  "journl_module_actions",
  "users", // staff accounts kept; client logins deleted below
  "staff_profiles",
  // Workspace: the team's own project work, not demo accounting data. Client links are re-pointed after reseeding.
  "project_spaces",
  "project_space_members",
  "project_statuses",
  "project_sprints",
  "project_items",
  "project_item_labels",
  "project_item_comments",
  "project_item_activity",
  "project_item_attachments",
  "project_item_worklogs",
]);

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
    await deleteReportFiles(conn); // stored PDFs of the reports about to be wiped
    // Workspace spaces and items are kept, but clients are recreated with new ids: remember each link by client name.
    const workspaceClientLinks = await query<{ tbl: "project_spaces" | "project_items"; id: number; legal_name: string | null }>(
      `SELECT 'project_spaces' AS tbl, s.id, c.legal_name FROM project_spaces s LEFT JOIN clients c ON c.id = s.client_id WHERE s.client_id IS NOT NULL
       UNION ALL
       SELECT 'project_items', i.id, c.legal_name FROM project_items i LEFT JOIN clients c ON c.id = i.client_id WHERE i.client_id IS NOT NULL`,
      [],
      conn,
    );
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    const tables = await query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?`, [env.DB_NAME], conn);
    for (const { t } of tables) if (!MASTER_TABLES.has(t)) await conn.query(`TRUNCATE TABLE \`${t}\``);
    await conn.query(`DELETE FROM users WHERE portal_role IN ('client_owner', 'client_member')`);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");

    // ── Master data: added only where missing ──
    await insIgnore(conn, "app_settings", {
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
      ensure(conn, "users", { email }, { full_name, portal_role, phone, password_hash: hash, status: "active" });
    const staff = async (email: string, name: string, role: string, type: "accountant" | "employee", rate: number, expertise: string[], phone: string) => {
      const id = await user(email, name, role, phone);
      await insIgnore(conn, "staff_profiles", {
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
    const svc = (code: string, name: string, description: string) => ensure(conn, "services", { code }, { name, description });
    const bk = await svc("BK-M", "Monthly Bookkeeping", "Recording, reconciliation and month-end close support.");
    const gst = await svc("GST-R", "GST Filing", "GSTR-1 and GSTR-3B preparation and filing.");
    const pay = await svc("PAY-R", "Payroll Processing", "Salary processing, statutory deductions and payslips.");
    const rep = await svc("REP-M", "Financial Reporting", "Monthly MIS pack with P&L, balance sheet and cash flow.");

    const growth = await ensure(conn, "packages", { name: "Growth Compliance" }, {
      description: "Bookkeeping, GST, payroll and monthly reporting.",
      monthly_fee: 48000,
      billing_cycle: "monthly",
      scope_notes: "Up to 1,200 transactions a month. Multi-branch. Quarterly review call with the CFO.",
      team_roles: JSON.stringify(["bookkeeper", "finance_manager", "cfo"]),
    });
    const basic = await ensure(conn, "packages", { name: "Monthly Bookkeeping" }, {
      description: "Core bookkeeping and compliance for growing businesses.",
      monthly_fee: 25000,
      billing_cycle: "monthly",
      scope_notes: "Up to 500 transactions a month. Two bank accounts. GST returns filed by the 20th.",
      team_roles: JSON.stringify(["bookkeeper", "finance_manager"]),
    });
    for (const s of [bk, gst, pay, rep]) await insIgnore(conn, "package_services", { package_id: growth, service_id: s });
    for (const s of [bk, gst]) await insIgnore(conn, "package_services", { package_id: basic, service_id: s });

    // ── Task templates (as in the existing workspace: all items sit under Monthly Bookkeeping) ──
    const bookkeepingTpl = await ensure(conn, "task_templates", { name: "Monthly Bookkeeping" }, { service_id: bk, recurrence: "monthly", due_day_of_period: 10 });
    await ensure(conn, "task_templates", { name: "GST Return Filing" }, { service_id: gst, recurrence: "monthly", due_day_of_period: 18 });
    await ensure(conn, "task_templates", { name: "Monthly MIS Pack" }, { service_id: rep, recurrence: "monthly", due_day_of_period: 25 });
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
      await ensure(conn, "task_template_items", { template_id: bookkeepingTpl, title }, { checklist: JSON.stringify(checklist), client_visible: visible, sort_order: k + 1 });
    }

    // ── JournL features, one permission each (same list as migration 021; restores them if a previous seed truncated them) ──
    const areaOrder = Object.fromEntries(JOURNL_AREAS.map((a, i) => [a.key, (i + 1) * 100]));
    for (const [i, f] of JOURNL_FEATURE_LIST.entries()) {
      await insIgnore(conn, "journl_modules", {
        module_key: f.key,
        label: f.name,
        group_key: f.area,
        sort_order: areaOrder[f.area]! + i,
        default_policy: f.restricted ? "restricted" : "configurable",
        journl_module_id: String(f.id),
        verified_at: new Date(),
      });
    }
    await conn.query(
      `INSERT IGNORE INTO journl_module_actions (module_key, action_key, label, journl_action_id, verified_at)
         SELECT module_key, 'view', 'View (read-only)', 'view', UTC_TIMESTAMP() FROM journl_modules`,
    );

    const grantableModules = (await query<{ module_key: string }>(`SELECT module_key FROM journl_modules WHERE default_policy <> 'restricted' ORDER BY sort_order`, [], conn)).map((m) => m.module_key);

    // ── Clients ──
    const clientDefs = [
      ["ABC Traders Pvt Ltd", "ABC Traders", "32ABCDE1234F1Z5", "ABCDE1234F", "Kerala", "active", "journl", growth, 48000],
      ["Kaveri Constructions Pvt Ltd", "Kaveri Constructions", "29AAFCC2233R1Z8", "AAFCC2233R", "Karnataka", "active", "journl", basic, 25000],
      ["Zenith Pharma Distributors", "Zenith Pharma", "36AAGCZ9911T1Z5", "AAGCZ9911T", "Telangana", "active", "journl", basic, 25000],
      ["Bluewave Retail Pvt Ltd", "Bluewave Retail", "29AAECB7788P1ZQ", "AAECB7788P", "Karnataka", "active", "journl", growth, 48000],
      ["Sunrise Foods Pvt Ltd", "Sunrise Foods", "33AAHCS4455K1Z2", "AAHCS4455K", "Tamil Nadu", "active", "journl", basic, 25000],
      ["Meridian Textiles LLP", "Meridian Textiles", "24AAJFM3344N1Z6", "AAJFM3344N", "Gujarat", "active", "journl", basic, 25000],
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
      const business_type = legal_name.endsWith("LLP") ? "llp" : legal_name.includes("Pvt Ltd") ? "private_limited" : "proprietorship";
      const contactFirst = ["Anil", "Kavya", "Sameer", "Divya", "Karthik", "Pooja", "Harsh", "Lakshmi", "Rohit"][i % 9];
      const contactSlug = trade_name.toLowerCase().replace(/[^a-z]+/g, "");
      const clientId = await ins(conn, "clients", {
        legal_name, trade_name, business_type, gstin, pan, state, status, accounting_software: software, address: `${state}, India`,
        date_of_establishment: `${2008 + i}-04-01`,
        primary_contact_name: `${contactFirst} ${trade_name.split(" ")[0]}`,
        primary_contact_email: `${contactFirst.toLowerCase()}@${contactSlug}.example`,
        primary_contact_phone: `+91 98${String(10000000 + i * 1234567).slice(0, 8)}`,
      });

      // Progressive-onboarding profile. The "registered" prospect stays sparse so the readiness checklist has gaps to show.
      const sparse = status === "onboarding" && i % 2 === 1;
      await ins(conn, "company_tax_details", {
        client_id: clientId,
        pan_number: pan, pan_status: pan ? "registered" : "applied",
        gstin, gstin_status: gstin ? "registered" : "not_registered",
        professional_tax_status: sparse ? null : "registered",
      });
      if (!sparse) {
        const ownerType = business_type === "llp" ? "partner" : business_type === "proprietorship" ? "proprietor" : "director";
        const owners = business_type === "proprietorship" ? [100] : [60, 40];
        for (const [n, share] of owners.entries()) {
          await ins(conn, "company_stakeholders", {
            client_id: clientId, stakeholder_type: ownerType,
            full_name: n === 0 ? `${contactFirst} ${trade_name.split(" ")[0]}` : `${["Sunita", "Manoj", "Rekha", "Ajay"][i % 4]} ${trade_name.split(" ")[0]}`,
            designation: ownerType === "director" ? (n === 0 ? "Managing Director" : "Director") : null,
            ownership_percentage: share, is_primary: n === 0,
          });
        }
        await ins(conn, "company_financial_profile", {
          client_id: clientId, financial_year_start_month: 4,
          annual_turnover: (5 + i * 3) * 1_000_000, monthly_transaction_volume: 300 + i * 70,
          employee_count: 8 + i * 4, monthly_invoice_count: 60 + i * 15,
          current_accounting_software: software === "journl" ? "JournL" : "Spreadsheets",
        });
      }

      if (status === "onboarding") {
        const caseId = await ins(conn, "onboarding_cases", {
          client_id: clientId,
          stage: i % 2 ? "registered" : "proposal_sent",
          monthly_transaction_volume: i % 2 ? null : 820,
          complexity: i % 2 ? null : "medium",
          assessed_by: i % 2 ? null : ops,
          suggested_package_id: i % 2 ? null : growth,
          suggested_monthly_fee: i % 2 ? null : 48000,
          notes: i % 2 ? null : "Two branches, books on spreadsheets today. Needs GST plus payroll.",
        });
        if (!sparse) {
          await ins(conn, "onboarding_service_requirements", {
            case_id: caseId, bookkeeping: true, gst_filing: true, income_tax_filing: true, payroll: true, audit_support: false,
            notes: "Two branches; payroll for ~40 staff.",
          });
        }
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
          external_org_id: `JL-${trade_name.slice(0, 3).toUpperCase()}-${7700 + i}`,
          status: "connected",
        });
      }

      const bookkeeper = bookkeepers[i % bookkeepers.length]!;
      const reviewer = reviewers[i % reviewers.length]!;
      const bookkeeperAssignment = await ins(conn, "assignments", { client_id: clientId, user_id: bookkeeper, team_role: "bookkeeper", valid_from: dayOf(period(-6), 1), journl_access: software === "journl" });
      // JournL clients: the bookkeeper may view every grantable JournL module (Assignments → JournL modules).
      if (software === "journl") {
        for (const module_key of grantableModules) {
          await ins(conn, "assignment_module_permissions", { assignment_id: bookkeeperAssignment, module_key, allowed_actions: JSON.stringify(["view"]), status: "active", granted_by: admin, granted_at: new Date() });
        }
      }
      await ins(conn, "assignments", { client_id: clientId, user_id: reviewer, team_role: "finance_manager", valid_from: dayOf(period(-6), 1) });
      if (i === 0) await ins(conn, "assignments", { client_id: clientId, user_id: sneha, team_role: "cfo", valid_from: dayOf(period(-6), 1) });

      // Client portal logins for ABC Traders: an owner (can approve) and a member. Demo password: 12345678.
      let clientDecider: number | null = null;
      if (i === 0) {
        const clientHash = await bcrypt.hash("12345678", 12);
        const clientUser = (email: string, full_name: string, portal_role: string, phone: string) =>
          ins(conn, "users", { email, full_name, portal_role, phone, password_hash: clientHash, status: "active" });
        const owner = await clientUser("owner@abctraders.in", "Anil Thomas", "client_owner", "+91 94470 12345");
        const member = await clientUser("accounts@abctraders.in", "Deepa Varghese", "client_member", "+91 94470 67890");
        await ins(conn, "client_users", { client_id: clientId, user_id: owner, role: "owner", can_approve: true });
        await ins(conn, "client_users", { client_id: clientId, user_id: member, role: "member", can_approve: false });
        clientDecider = owner;
      }

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

      // Last month's reports (small generated PDFs in file storage) and the client's approvals.
      const deliverables = { clientId, name: trade_name, period: prev, publishedOn: dayOf(cur, 3), preparer: bookkeeper, approver: reviewer, clientDecider, seed: i };
      await addReports(conn, deliverables);
      await addApprovals(conn, deliverables);

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

    // ── Workspace: seeded once (kept between runs, client links re-pointed later) ──
    const spaceId = await ins(conn, "project_spaces", {
      space_key: "ACC",
      name: "Accountanz Workspace",
      description: "Primary workspace for Accountanz team project tracking",
      template: "kanban",
      client_id: null,
      next_item_number: 1,
      created_by: admin,
    });
    await ins(conn, "project_space_members", {
      space_id: spaceId,
      user_id: admin,
      role: "admin",
      added_by: admin,
    });
    const statuses = ["Backlog", "In Progress", "Review", "Done"] as const;
    for (const [idx, name] of statuses.entries()) {
      await ins(conn, "project_statuses", { space_id: spaceId, name, category: idx < 2 ? "in_progress" : "done", position: idx });
    }
    await ins(conn, "project_sprints", {
      space_id: spaceId,
      name: "Sprint 1",
      goal: "Initial setup and core bookkeeping",
      start_date: dayOf(period(-3), 1),
      end_date: dayOf(period(0), 1),
      status: "active",
    });
    await ins(conn, "project_items", {
      space_id: spaceId,
      number: 1,
      type: "task",
      title: "Set up chart of accounts",
      description: "Configure accounts and tax categories",
      status_id: (await query<{ id: number }>(`SELECT id FROM project_statuses WHERE space_id = ? ORDER BY position LIMIT 1`, [spaceId], conn))[0].id,
      assignee_id: vikram,
      reporter_id: admin,
      priority: "high",
    });
    // Re-point Workspace client links at the reseeded clients (same legal name); a client that no longer exists is unlinked.
    for (const link of workspaceClientLinks) {
      await execute(
        `UPDATE ${link.tbl} SET client_id = (SELECT id FROM clients WHERE legal_name = ? LIMIT 1) WHERE id = ?`,
        [link.legal_name, link.id],
        conn,
      );
    }

    // Fill actor e-mails for the seeded audit rows (snapshots, as the service would write them).
    await conn.query(`UPDATE audit_logs a JOIN users u ON u.id = a.actor_id SET a.actor_email = u.email WHERE a.actor_email IS NULL`);
    await ins(conn, "audit_logs", { actor_id: admin, actor_email: "admin@accountanz.in", actor_role: "super_admin", action: "Workspace seeded", entity_type: "AppSetting", entity_id: "1", details: "Demo data loaded" });

    const kb = (title: string, category: string, summary: string, body: string) => ensure(conn, "knowledge_articles", { title }, { category, summary, body, updated_by: admin });
    await kb("Submitting a task for review", "Task workflow", "What a bookkeeper must check before hitting Submit for review.", "Every checklist item on the task must be ticked, supporting documents attached, and time logged.");
    await kb("Month-end close: the standard order", "Month-end", "The order we work through a client's month, and who signs off on each step.", "1. All tasks for the period approved.\n2. Reports prepared and approved.\n3. Finance manager closes the period.");
    await kb("Rejecting a client document", "Documents", "Always give a reason the client can act on.", "When a document is unusable, reject it with a short note telling the client exactly what to resend.");
  });

  logger.info("Seed complete. Master data kept; client data reseeded. Sign in as admin@accountanz.in.");
  await pool.end();
}

main().catch(async (err) => {
  logger.error(err, "Seed failed");
  await pool.end();
  process.exit(1);
});
