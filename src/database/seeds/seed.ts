/**
 * Loads a clean, realistic demo workspace. Development only.
 *
 * WIPES EVERY TABLE (except schema_migrations), then builds six months of consistent history so every screen
 * has real numbers: clients joining over time, monthly tasks reviewed (some late, some returned and redone), time
 * logged, invoices raised and paid (one client overdue), month-end closings, payouts and published reports. The
 * current month is left mid-flight: some work approved, some waiting for review, some overdue.
 *
 * Staff sign in with SEED_PASSWORD; demo client logins use 12345678. Deterministic: same data on every run
 * (dates are relative to today).
 */
import bcrypt from "bcryptjs";
import type { PoolConnection } from "mysql2/promise";
import { env, isProd } from "../../config/env.js";
import { onEngagementActivated } from "../../modules/projects/client-space-hooks.js";
import type { AuthUser } from "../../types/auth.types.js";
import { logger } from "../../utils/logger.js";
import { execute, pool, query, withTransaction, type Param } from "../connection.js";
import { addApprovals, addReports, deleteReportFiles } from "./demo-deliverables.js";

const ins = async (conn: PoolConnection, table: string, row: Record<string, Param>) => {
  const keys = Object.keys(row);
  const r = await execute(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(row), conn);
  return r.insertId;
};

/** Small deterministic random source, so every run produces the same workspace. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Dates (all relative to today, local time) ──
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = new Date();
/** A timestamp on that day at about `hour`, never later than now (so "today at 4 pm" can't be in the future). */
const at = (d: Date, hour: number) => {
  let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, (hour * 7) % 60);
  if (t > NOW) t = new Date(NOW.getTime() - 20 * 60_000);
  return `${ymd(t)} ${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
};
/** 'YYYY-MM' for a month offset from the current one. */
const period = (offset = 0) => {
  const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + offset, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const daysIn = (p: string) => {
  const [y, m] = p.split("-").map(Number) as [number, number];
  return new Date(y, m, 0).getDate();
};
const dateIn = (p: string, day: number) => {
  const [y, m] = p.split("-").map(Number) as [number, number];
  return new Date(y, m - 1, Math.min(day, daysIn(p)));
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Never later than today: history can't happen in the future. */
const notAfterToday = (d: Date) => (d > TODAY ? new Date(TODAY) : d);

/**
 * The monthly checklist work, in the order it's usually done, with its due day and who sees it. Month-end close work
 * (`nextMonth`) is due in the first week of the following month, as it is in practice.
 */
const TEMPLATE_ITEMS: { title: string; checklist: string[]; visible: boolean; dueDay: number; nextMonth?: true }[] = [
  { title: "Bank reconciliations", checklist: ["Statements received for every account", "Unreconciled items explained"], visible: true, dueDay: 7 },
  { title: "Sales register posting", checklist: ["Sales export received", "Invoices posted and tied to GSTR-1"], visible: true, dueDay: 8 },
  { title: "Purchase register posting", checklist: ["Purchase bills received", "Bills posted with correct GST"], visible: true, dueDay: 10 },
  { title: "GST output tax review", checklist: ["Output tax agreed to sales register", "Variances explained"], visible: true, dueDay: 11 },
  { title: "TDS payable check", checklist: ["TDS deducted on all eligible payments", "Payable agreed to challans"], visible: true, dueDay: 14 },
  { title: "Payroll journal entries", checklist: ["Salary register reconciled", "Statutory dues booked"], visible: true, dueDay: 16 },
  { title: "Vendor ledger scrutiny", checklist: ["Debit balances reviewed", "Duplicate bills checked"], visible: false, dueDay: 18 },
  { title: "Customer ledger scrutiny", checklist: ["Credit balances reviewed", "Ageing over 90 days flagged"], visible: false, dueDay: 19 },
  { title: "Month-end accruals", checklist: ["Accrual list agreed with client", "Entries posted"], visible: false, dueDay: 3, nextMonth: true },
  { title: "Fixed asset register update", checklist: ["Additions capitalised", "Depreciation posted"], visible: false, dueDay: 4, nextMonth: true },
  { title: "Trial balance review", checklist: ["Suspense accounts cleared", "Ratio check completed"], visible: true, dueDay: 5, nextMonth: true },
  { title: "Management accounts pack", checklist: ["P&L and balance sheet drafted", "Variances commented"], visible: true, dueDay: 7, nextMonth: true },
];

/** Which template items each package covers each month (indexes into TEMPLATE_ITEMS). */
const PACKAGE_ITEMS = {
  starter: [0, 1, 2, 3],
  basic: [0, 1, 2, 3, 4, 8, 10],
  growth: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11],
} as const;
type PackageKey = keyof typeof PACKAGE_ITEMS;

const RETURN_COMMENTS = [
  "Supporting schedule missing.",
  "Two bank entries still unexplained; please add notes.",
  "GST on the freight bills looks wrong; recheck the rate.",
  "Totals don't tie to the register; please reconcile.",
];

async function main() {
  if (isProd) throw new Error("Refusing to seed a production database");
  if (!env.SEED_PASSWORD || env.SEED_PASSWORD.length < 8) throw new Error("Set SEED_PASSWORD (8+ characters) in .env");
  const hash = await bcrypt.hash(env.SEED_PASSWORD, 12);
  const clientHash = await bcrypt.hash("12345678", 12);
  const rand = rng(20261128);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  // ── Wipe everything ── TRUNCATE commits implicitly, so it runs on its own before the seeding transaction.
  const wipe = await pool.getConnection();
  try {
    await deleteReportFiles(wipe); // stored PDFs of reports about to be removed
    await wipe.query("SET FOREIGN_KEY_CHECKS = 0");
    const tables = await query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`, [env.DB_NAME], wipe);
    for (const { t } of tables) if (t !== "schema_migrations") await wipe.query(`TRUNCATE TABLE \`${t}\``);
  } finally {
    await wipe.query("SET FOREIGN_KEY_CHECKS = 1");
    wipe.release();
  }

  await withTransaction(async (conn) => {

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
    const joined = at(addDays(dateIn(period(-7), 1), 2), 10);
    const user = (email: string, full_name: string, portal_role: string, phone: string | null = null) =>
      ins(conn, "users", { email, full_name, portal_role, phone, password_hash: hash, status: "active", created_at: joined });
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
    const priya = await staff("priya@accountanz.in", "Priya Nair", "finance_manager", "accountant", 900, ["GST", "Reviews"], "+91 98950 66778");
    const sneha = await staff("sneha@accountanz.in", "Sneha Iyer", "cfo", "accountant", 1200, ["Financial reporting", "Statutory audit"], "+91 99000 44556");
    const arun = await staff("arun@accountanz.in", "Arun Menon", "bookkeeper", "accountant", 450, ["Bookkeeping", "Payroll"], "+91 97440 55667");
    const rahul = await staff("rahul@accountanz.in", "Rahul Verma", "bookkeeper", "accountant", 400, ["Bookkeeping", "GST"], "+91 98450 11223");
    const vikram = await staff("vikram@accountanz.in", "Vikram Rao", "bookkeeper", "accountant", 420, ["Bookkeeping", "TDS"], "+91 96320 77881");
    const actor: AuthUser = { id: admin, email: "admin@accountanz.in", fullName: "Accountanz Admin", role: "super_admin" };

    // How each bookkeeper works: how often they submit late, and how often a first review sends work back.
    const habits = new Map<number, { late: number; returned: number; pace: number }>([
      [arun, { late: 0.1, returned: 0.18, pace: 1.0 }],
      [rahul, { late: 0.3, returned: 0.1, pace: 0.9 }],
      [vikram, { late: 0.15, returned: 0.08, pace: 1.1 }],
    ]);
    const rates = new Map<number, number>([[meera, 850], [priya, 900], [sneha, 1200], [arun, 450], [rahul, 400], [vikram, 420]]);

    // ── Catalogue ──
    const svc = (code: string, name: string, description: string) => ins(conn, "services", { code, name, description });
    const bk = await svc("BK-M", "Monthly Bookkeeping", "Recording, reconciliation and month-end close support.");
    const gst = await svc("GST-R", "GST Filing", "GSTR-1 and GSTR-3B preparation and filing.");
    const pay = await svc("PAY-R", "Payroll Processing", "Salary processing, statutory deductions and payslips.");
    const rep = await svc("REP-M", "Financial Reporting", "Monthly MIS pack with P&L, balance sheet and cash flow.");
    const pkg = async (name: string, description: string, fee: number, scope: string, roles: string[], services: number[]) => {
      const id = await ins(conn, "packages", { name, description, monthly_fee: fee, billing_cycle: "monthly", scope_notes: scope, team_roles: JSON.stringify(roles) });
      for (const s of services) await ins(conn, "package_services", { package_id: id, service_id: s });
      return { id, fee, services };
    };
    const packages: Record<PackageKey, { id: number; fee: number; services: number[] }> = {
      starter: await pkg("Starter Books", "Bookkeeping and GST for small businesses.", 15000, "Up to 200 transactions a month. One bank account.", ["bookkeeper", "finance_manager"], [bk, gst]),
      basic: await pkg("Monthly Bookkeeping", "Core bookkeeping and compliance for growing businesses.", 25000, "Up to 500 transactions a month. Two bank accounts. GST returns filed by the 20th.", ["bookkeeper", "finance_manager"], [bk, gst]),
      growth: await pkg("Growth Compliance", "Bookkeeping, GST, payroll and monthly reporting.", 48000, "Up to 1,200 transactions a month. Multi-branch. Quarterly review call with the CFO.", ["bookkeeper", "finance_manager", "cfo"], [bk, gst, pay, rep]),
    };

    // ── Task templates ──
    const bookkeepingTpl = await ins(conn, "task_templates", { name: "Monthly Bookkeeping", service_id: bk, recurrence: "monthly", due_day_of_period: 10 });
    await ins(conn, "task_templates", { name: "GST Return Filing", service_id: gst, recurrence: "monthly", due_day_of_period: 18 });
    await ins(conn, "task_templates", { name: "Monthly MIS Pack", service_id: rep, recurrence: "monthly", due_day_of_period: 25 });
    const templateItemIds: number[] = [];
    for (const [k, t] of TEMPLATE_ITEMS.entries()) {
      templateItemIds.push(await ins(conn, "task_template_items", { template_id: bookkeepingTpl, title: t.title, checklist: JSON.stringify(t.checklist), client_visible: t.visible, sort_order: k + 1 }));
    }

    // ── Staff groups (Vikram works across teams, so he's not in one) ──
    const group = async (name: string, description: string, members: [number, string][]) => {
      const id = await ins(conn, "staff_groups", { name, description, created_by: admin });
      for (const [userId, role] of members) await ins(conn, "staff_group_members", { group_id: id, user_id: userId, team_role: role });
      return id;
    };
    const kochi = await group("Team Kochi", "Kerala and Tamil Nadu clients.", [[arun, "bookkeeper"], [priya, "finance_manager"]]);
    const bengaluru = await group("Team Bengaluru", "Karnataka, Gujarat and Telangana clients.", [[rahul, "bookkeeper"], [meera, "finance_manager"]]);

    // ── Clients ──
    type ClientDef = {
      legal: string; trade: string; type: string; gstin: string | null; pan: string | null; state: string; contact: string;
      status: "active" | "onboarding" | "lead"; pkg?: PackageKey; since?: number; fee?: number; bookkeeper?: number; reviewer?: number; group?: number;
      software: "journl" | "none"; latePayer?: boolean;
    };
    const clientDefs: ClientDef[] = [
      { legal: "ABC Traders Pvt Ltd", trade: "ABC Traders", type: "private_limited", gstin: "32ABCDE1234F1Z5", pan: "ABCDE1234F", state: "Kerala", contact: "Anil Thomas", status: "active", pkg: "growth", since: -6, bookkeeper: arun, reviewer: priya, group: kochi, software: "journl" },
      { legal: "Kaveri Constructions Pvt Ltd", trade: "Kaveri Constructions", type: "private_limited", gstin: "29AAFCC2233R1Z8", pan: "AAFCC2233R", state: "Karnataka", contact: "Kavya Rao", status: "active", pkg: "basic", since: -6, bookkeeper: rahul, reviewer: meera, group: bengaluru, software: "journl" },
      { legal: "Zenith Pharma Distributors", trade: "Zenith Pharma", type: "partnership", gstin: "36AAGFZ9911T1Z5", pan: "AAGFZ9911T", state: "Telangana", contact: "Sameer Reddy", status: "active", pkg: "basic", since: -5, bookkeeper: vikram, reviewer: meera, software: "journl" },
      { legal: "Bluewave Retail Pvt Ltd", trade: "Bluewave Retail", type: "private_limited", gstin: "29AAECB7788P1ZQ", pan: "AAECB7788P", state: "Karnataka", contact: "Divya Shetty", status: "active", pkg: "growth", since: -5, fee: 45000, bookkeeper: rahul, reviewer: meera, group: bengaluru, software: "journl" },
      { legal: "Sunrise Foods Pvt Ltd", trade: "Sunrise Foods", type: "private_limited", gstin: "33AAHCS4455K1Z2", pan: "AAHCS4455K", state: "Tamil Nadu", contact: "Karthik Subramanian", status: "active", pkg: "basic", since: -4, bookkeeper: arun, reviewer: priya, group: kochi, software: "journl" },
      { legal: "Meridian Textiles LLP", trade: "Meridian Textiles", type: "llp", gstin: "24AAJFM3344N1Z6", pan: "AAJFM3344N", state: "Gujarat", contact: "Pooja Desai", status: "active", pkg: "basic", since: -4, bookkeeper: vikram, reviewer: meera, software: "none", latePayer: true },
      { legal: "Lotus Ayurveda Works", trade: "Lotus Ayurveda", type: "proprietorship", gstin: "32AAHPL9012M1Z7", pan: "AAHPL9012M", state: "Kerala", contact: "Lakshmi Menon", status: "active", pkg: "starter", since: -3, bookkeeper: arun, reviewer: priya, group: kochi, software: "none" },
      { legal: "Coastal Seafoods Exports Pvt Ltd", trade: "Coastal Seafoods", type: "private_limited", gstin: "32AAKCC6612H1Z4", pan: "AAKCC6612H", state: "Kerala", contact: "Joseph Mathew", status: "active", pkg: "growth", since: -2, bookkeeper: vikram, reviewer: priya, software: "journl" },
      { legal: "Pinnacle Software Solutions Pvt Ltd", trade: "Pinnacle Software", type: "private_limited", gstin: "29AAMCP4410Q1Z2", pan: "AAMCP4410Q", state: "Karnataka", contact: "Harsh Kulkarni", status: "active", pkg: "starter", since: -1, bookkeeper: rahul, reviewer: meera, group: bengaluru, software: "none" },
      { legal: "Nimbus Logistics Pvt Ltd", trade: "Nimbus Logistics", type: "private_limited", gstin: "33AAGCN5678L1Z3", pan: "AAGCN5678L", state: "Tamil Nadu", contact: "Rohit Iyer", status: "onboarding", software: "none" },
      { legal: "Greenfield Agro Farms", trade: "Greenfield Agro", type: "partnership", gstin: null, pan: "AAJFG2290B", state: "Maharashtra", contact: "Sunita Patil", status: "lead", software: "none" },
    ];

    const cur = period(0);
    let invoiceSeq = 1000;
    let paymentSeq = 880100;

    for (const [i, c] of clientDefs.entries()) {
      const firstName = c.contact.split(" ")[0]!;
      const slug = c.trade.toLowerCase().replace(/[^a-z]+/g, "");
      // Clients arrive a couple of weeks before their engagement starts; prospects arrived this month.
      const created = c.since !== undefined ? addDays(dateIn(period(c.since), 1), -12) : notAfterToday(addDays(TODAY, -(4 + i)));
      const clientId = await ins(conn, "clients", {
        legal_name: c.legal, trade_name: c.trade, business_type: c.type, gstin: c.gstin, pan: c.pan, state: c.state, status: c.status,
        accounting_software: c.software, address: `${c.state}, India`, date_of_establishment: `${2006 + i}-04-01`,
        primary_contact_name: c.contact, primary_contact_email: `${firstName.toLowerCase()}@${slug}.example`,
        primary_contact_phone: `+91 9${String(8100000000 + i * 37112233).slice(0, 9)}`, created_at: at(created, 11),
      });

      // Progressive-onboarding profile; the lead stays sparse so the readiness checklist has gaps to show.
      const sparse = c.status === "lead";
      await ins(conn, "company_tax_details", {
        client_id: clientId, pan_number: c.pan, pan_status: c.pan ? "registered" : "applied",
        gstin: c.gstin, gstin_status: c.gstin ? "registered" : "not_registered", professional_tax_status: sparse ? null : "registered",
      });
      if (!sparse) {
        const ownerType = c.type === "llp" || c.type === "partnership" ? "partner" : c.type === "proprietorship" ? "proprietor" : "director";
        const owners = c.type === "proprietorship" ? [100] : [60, 40];
        for (const [n, share] of owners.entries()) {
          await ins(conn, "company_stakeholders", {
            client_id: clientId, stakeholder_type: ownerType,
            full_name: n === 0 ? c.contact : `${["Sunil", "Manoj", "Rekha", "Ajay", "Meena"][i % 5]} ${c.contact.split(" ")[1] ?? c.trade.split(" ")[0]}`,
            designation: ownerType === "director" ? (n === 0 ? "Managing Director" : "Director") : null,
            ownership_percentage: share, is_primary: n === 0,
          });
        }
        await ins(conn, "company_financial_profile", {
          client_id: clientId, financial_year_start_month: 4,
          annual_turnover: (6 + i * 4) * 1_000_000, monthly_transaction_volume: 250 + i * 90,
          employee_count: 10 + i * 6, monthly_invoice_count: 50 + i * 20,
          current_accounting_software: c.software === "journl" ? "JournL" : "Spreadsheets",
        });
      }

      if (c.status !== "active") {
        const proposal = c.status === "onboarding";
        const caseId = await ins(conn, "onboarding_cases", {
          client_id: clientId, stage: proposal ? "proposal_sent" : "registered",
          monthly_transaction_volume: proposal ? 820 : null, complexity: proposal ? "medium" : null, assessed_by: proposal ? ops : null,
          suggested_package_id: proposal ? packages.growth.id : null, suggested_monthly_fee: proposal ? 48000 : null,
          notes: proposal ? "Two branches, books on spreadsheets today. Needs GST plus payroll for ~40 staff." : null,
        });
        if (proposal) {
          await ins(conn, "onboarding_service_requirements", {
            case_id: caseId, bookkeeping: true, gst_filing: true, income_tax_filing: true, payroll: true, audit_support: false, notes: "Two branches; payroll for ~40 staff.",
          });
        }
        continue;
      }

      // ── Engagement and team ──
      const p = packages[c.pkg!];
      const fee = c.fee ?? p.fee;
      const start = dateIn(period(c.since!), 1);
      const engagementId = await ins(conn, "engagements", {
        client_id: clientId, package_id: p.id, monthly_fee: c.fee ?? null, status: "active",
        start_date: ymd(start), renewal_date: ymd(addDays(dateIn(period(c.since! + 12), 1), -1)), created_at: at(addDays(start, -5), 15),
      });
      for (const s of p.services) await ins(conn, "engagement_services", { engagement_id: engagementId, service_id: s });

      const bookkeeper = c.bookkeeper!;
      const reviewer = c.reviewer!;
      const team: [number, string][] = [[bookkeeper, "bookkeeper"], [reviewer, "finance_manager"]];
      if (c.pkg === "growth") team.push([sneha, "cfo"]);
      for (const [userId, role] of team) {
        await ins(conn, "assignments", { client_id: clientId, user_id: userId, team_role: role, valid_from: ymd(start), source_group_id: role === "cfo" ? null : (c.group ?? null) });
      }
      await onEngagementActivated(actor, clientId, conn); // the client's primary Workspace space, synced with the team

      // ABC Traders gets client portal logins: an owner (can approve) and a member. Password: 12345678.
      let clientDecider: number | null = null;
      if (i === 0) {
        const owner = await ins(conn, "users", { email: "owner@abctraders.in", full_name: "Anil Thomas", portal_role: "client_owner", phone: "+91 94470 12345", password_hash: clientHash, status: "active" });
        const member = await ins(conn, "users", { email: "accounts@abctraders.in", full_name: "Deepa Varghese", portal_role: "client_member", phone: "+91 94470 67890", password_hash: clientHash, status: "active" });
        await ins(conn, "client_users", { client_id: clientId, user_id: owner, role: "owner", can_approve: true });
        await ins(conn, "client_users", { client_id: clientId, user_id: member, role: "member", can_approve: false });
        clientDecider = owner;
      }

      // ── Monthly work, from the engagement's first month to now ──
      const habit = habits.get(bookkeeper)!;
      for (let m = c.since!; m <= 0; m++) {
        const per = period(m);
        const isCurrent = m === 0;
        // Last month: most clients closed; one or two still have work with the reviewer.
        const lastMonthPending = m === -1 && (i === 1 || i === 4);
        let allApproved = true;

        for (const idx of PACKAGE_ITEMS[c.pkg!]) {
          const t = TEMPLATE_ITEMS[idx]!;
          const due = dateIn(t.nextMonth ? period(m + 1) : per, t.dueDay);

          // Status this month.
          let status: "todo" | "in_progress" | "submitted" | "returned" | "approved" = "approved";
          if (isCurrent) {
            const r = rand();
            const elapsed = due <= TODAY;
            status = !elapsed
              ? r < 0.15 ? "submitted" : r < 0.55 ? "in_progress" : "todo"
              : r < 0.72 * habit.pace ? "approved" : r < 0.84 ? "submitted" : r < 0.88 ? "returned" : r < 0.95 ? "in_progress" : "todo";
          } else if (lastMonthPending && idx >= 8) {
            status = "submitted";
          }
          if (status !== "approved") allApproved = false;

          // When it was (first) submitted: usually a few days early, sometimes late.
          const late = rand() < habit.late;
          let submitted = notAfterToday(addDays(due, late ? between(1, 4) : -between(0, 3)));
          const wasReturned = (status === "approved" && rand() < habit.returned) || status === "returned";
          const decisions: { decision: "approved" | "returned"; on: Date; n: number; comment: string }[] = [];
          if (status === "approved" || status === "returned") {
            const firstReview = notAfterToday(addDays(submitted, between(0, 2)));
            if (wasReturned) {
              decisions.push({ decision: "returned", on: firstReview, n: 1, comment: pick(RETURN_COMMENTS) });
              if (status === "approved") {
                submitted = notAfterToday(addDays(firstReview, between(1, 2)));
                decisions.push({ decision: "approved", on: notAfterToday(addDays(submitted, between(0, 1))), n: 2, comment: "Thanks, all fixed." });
              }
            } else {
              decisions.push({ decision: "approved", on: firstReview, n: 1, comment: "Checked against the source documents." });
            }
          } else if (status === "submitted" && isCurrent) {
            submitted = notAfterToday(addDays(TODAY, -between(0, 3)));
          }

          const started = status !== "todo";
          const done = status === "approved" || status === "submitted";
          const taskId = await ins(conn, "tasks", {
            client_id: clientId, engagement_id: engagementId, template_item_id: templateItemIds[idx]!, creation_source: "template",
            period: per, title: t.title,
            checklist: JSON.stringify(t.checklist.map((text, n) => ({ text, done: done || (started && n === 0) }))),
            created_by: ops, assignee_id: bookkeeper, reviewer_id: reviewer, status, due_date: ymd(due), client_visible: t.visible,
            submitted_at: status === "approved" || status === "submitted" || status === "returned" ? at(submitted, 16) : null,
            created_at: at(dateIn(per, 1), 9),
          });

          // Time: the bookkeeper's work in the days before submitting; the reviewer's on each review.
          if (started) {
            const sessions = between(1, 2);
            for (let s = 0; s < sessions; s++) {
              await ins(conn, "work_logs", { task_id: taskId, user_id: bookkeeper, minutes: between(3, 9) * 15, note: `${t.title}`, logged_on: ymd(notAfterToday(addDays(submitted, -s - between(0, 2)))) });
            }
          }
          for (const d of decisions) {
            await ins(conn, "task_reviews", { task_id: taskId, reviewer_id: reviewer, decision: d.decision, comments: d.comment, submission_number: d.n, created_at: at(d.on, 14) });
            await ins(conn, "work_logs", { task_id: taskId, user_id: reviewer, minutes: between(1, 2) * 15, note: "Review", logged_on: ymd(d.on) });
          }
        }

        // Month-end: past months closed once everything was approved; this month still open.
        if (!isCurrent) {
          const closed = allApproved;
          const closedOn = notAfterToday(dateIn(period(m + 1), between(9, 13)));
          await ins(conn, "period_closings", {
            client_id: clientId, period: per, status: closed ? "closed" : "open", closed_by: closed ? reviewer : null, closed_at: closed ? at(closedOn, 17) : null,
          });
        }

        // ── Billing: an invoice each month; paid within a couple of weeks, except a late payer's last two ──
        const gstAmount = Math.round(fee * 0.18 * 100) / 100;
        const issued = dateIn(per, 1);
        const dueDate = addDays(issued, 30); // 30-day terms
        const unpaid = isCurrent || (c.latePayer && m === -1);
        const invoiceId = await ins(conn, "service_invoices", {
          engagement_id: engagementId, invoice_number: `ACC-${per.replace("-", "")}-${++invoiceSeq}`, period: per,
          amount: fee, gst_rate: 18, gst_amount: gstAmount, total: fee + gstAmount, due_date: ymd(dueDate),
          status: unpaid ? (dueDate < TODAY ? "overdue" : "issued") : "paid", created_at: at(issued, 10),
        });
        if (!unpaid) {
          const paidOn = notAfterToday(addDays(dueDate, c.latePayer ? between(6, 14) : -between(0, 8)));
          await ins(conn, "service_payments", {
            invoice_id: invoiceId, amount: fee + gstAmount, paid_date: ymd(paidOn), method: i % 2 ? "upi" : "bank_transfer", reference: `NEFT-${++paymentSeq}`, recorded_by: ops,
          });
        }
      }

      // Last month's reports and approvals for clients that have a finished month.
      if (c.since! <= -1) {
        const deliverables = { clientId, name: c.trade, period: period(-1), publishedOn: ymd(notAfterToday(dateIn(cur, 5))), preparer: bookkeeper, approver: reviewer, clientDecider, seed: i };
        await addReports(conn, deliverables);
        await addApprovals(conn, deliverables);
      }

      // Documents: an open request for this month and last month's bank statement.
      await ins(conn, "document_requests", {
        client_id: clientId, requested_by: bookkeeper, description: "Bank statements for all current accounts", due_date: ymd(dateIn(cur, 5)), period: cur, status: i % 3 === 0 ? "fulfilled" : "open",
      });
      if (c.since! <= -1) {
        await ins(conn, "documents", {
          client_id: clientId, uploaded_by: bookkeeper, category: "bank_statement", period: period(-1),
          file_path: `documents/demo/${clientId}-statement.pdf`, file_name: `${c.trade.replace(/\s+/g, "-")}-statement-${period(-1)}.pdf`,
          mime_type: "application/pdf", status: "reviewed",
        });
      }
    }

    // ── Accountant payouts from logged time: two months ago paid, last month approved ──
    for (const [offset, status] of [[-2, "paid"], [-1, "approved"]] as const) {
      const per = period(offset);
      const rows = await query<{ user_id: number; minutes: number }>(
        `SELECT user_id, SUM(minutes) AS minutes FROM work_logs WHERE DATE_FORMAT(logged_on, '%Y-%m') = ? GROUP BY user_id`,
        [per],
        conn,
      );
      for (const r of rows) {
        const rate = rates.get(r.user_id);
        if (!rate) continue;
        const minutes = Number(r.minutes);
        await ins(conn, "accountant_payouts", {
          user_id: r.user_id, period: per, minutes, hourly_rate: rate, amount: Math.round((minutes / 60) * rate * 100) / 100, status,
          approved_by: admin, paid_date: status === "paid" ? ymd(dateIn(period(offset + 1), 7)) : null, method: "bank_transfer",
          reference: status === "paid" ? `PAYOUT-${per}-${r.user_id}` : null,
        });
      }
    }

    // ── Internal Workspace space ──
    const spaceId = await ins(conn, "project_spaces", {
      space_key: "ACC", name: "Accountanz Workspace", description: "The team's own projects and improvements.", template: "kanban", kind: "internal", client_id: null, next_item_number: 4, created_by: admin,
    });
    for (const u of [admin, ops, meera, priya]) await ins(conn, "project_space_members", { space_id: spaceId, user_id: u, role: u === admin ? "admin" : "member", added_by: admin });
    const statusIds: number[] = [];
    for (const [idx, name] of ["To do", "In progress", "Review", "Done"].entries()) {
      statusIds.push(await ins(conn, "project_statuses", { space_id: spaceId, name, category: idx === 3 ? "done" : idx === 0 ? "todo" : "in_progress", position: idx }));
    }
    const items: [string, number, number, string][] = [
      ["Standardise the month-end checklist across clients", 3, meera, "high"],
      ["Write the GST reconciliation playbook", 1, priya, "medium"],
      ["Set up quarterly client review calls", 0, ops, "low"],
    ];
    for (const [n, [title, s, assignee, priority]] of items.entries()) {
      await ins(conn, "project_items", { space_id: spaceId, number: n + 1, type: "task", title, status_id: statusIds[s]!, assignee_id: assignee, reporter_id: admin, priority });
    }

    // ── Knowledge base ──
    const kb = (title: string, category: string, summary: string, body: string) => ins(conn, "knowledge_articles", { title, category, summary, body, updated_by: admin });
    await kb("Submitting a task for review", "Task workflow", "What a bookkeeper must check before hitting Submit for review.", "Every checklist item on the task must be ticked, supporting documents attached, and time logged.");
    await kb("Month-end close: the standard order", "Month-end", "The order we work through a client's month, and who signs off on each step.", "1. All tasks for the period approved.\n2. Reports prepared and approved.\n3. Finance manager closes the period.");
    await kb("Rejecting a client document", "Documents", "Always give a reason the client can act on.", "When a document is unusable, reject it with a short note telling the client exactly what to resend.");
    await kb("Working in the client's JournL", "JournL", "Clients invite you to their JournL; you work there with your own login.", "Ask the client owner to invite you from JournL. Record your work and time on the task in Accountanz.");

    await conn.query(`UPDATE audit_logs a JOIN users u ON u.id = a.actor_id SET a.actor_email = u.email WHERE a.actor_email IS NULL`);
    await ins(conn, "audit_logs", { actor_id: admin, actor_email: "admin@accountanz.in", actor_role: "super_admin", action: "Workspace seeded", entity_type: "AppSetting", entity_id: "1", details: "Demo data loaded" });
  });

  logger.info("Seed complete: every table was wiped and demo data loaded. Sign in as admin@accountanz.in with SEED_PASSWORD.");
  await pool.end();
}

main().catch(async (err) => {
  logger.error(err, "Seed failed");
  await pool.end();
  process.exit(1);
});
