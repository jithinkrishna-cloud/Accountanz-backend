import { journlGet, type ReadResult } from "./journl.gateway.js";
import { istDate } from "./journl-data.service.js";

/**
 * Read-only JournL views for the bookkeeper workspace. Each view belongs to one Accountanz module (the grant it
 * needs) and reads one JournL GET endpoint, mapped from JournL's source (no published partner API). Rows are
 * flattened to plain columns so the frontend renders them with one table component.
 */

export type ColumnKind = "text" | "money" | "date" | "mono";
export interface Column {
  key: string;
  label: string;
  kind?: ColumnKind;
}
export interface ViewQuery {
  from: string;
  to: string;
  page: number;
  pageSize: number;
  search?: string;
  ledgerId?: number;
}
export interface ViewRows {
  rows: Record<string, unknown>[];
  total: number;
  /** Optional per-row drill-down into another view (e.g. a bank account's statement). */
  drill?: { view: string; label: string; param: "ledgerId"; rowKey: string };
}
export interface JournlView {
  key: string;
  module: string;
  label: string;
  /** Whether the date range applies (lists of masters ignore it). */
  usesPeriod: boolean;
  columns: Column[];
  load: (token: string, q: ViewQuery) => Promise<ReadResult<ViewRows>>;
}

type Num = number | string | null | undefined;
const num = (v: Num) => (v == null || v === "" ? 0 : Number(v) || 0);
type Paged = { total?: Num; result?: Record<string, unknown>[] };

const mapOk = <A, B>(r: ReadResult<A>, f: (a: A) => B): ReadResult<B> => (r.kind === "ok" ? { kind: "ok", data: f(r.data) } : r);

/** Lists JournL returns whole (not paged): page them here. */
const pageLocally = (rows: Record<string, unknown>[], q: ViewQuery) => ({ rows: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: rows.length });

const range = (q: ViewQuery) => ({ startDate: q.from, endDate: q.to, allBranches: true });

// ── Vouchers: one JournL list, filtered by voucher type ──
const VOUCHER_COLUMNS: Column[] = [
  { key: "date", label: "Date", kind: "date" },
  { key: "number", label: "Voucher", kind: "mono" },
  { key: "party", label: "Party / account" },
  { key: "invoice", label: "Invoice / ref", kind: "mono" },
  { key: "tax", label: "Tax", kind: "money" },
  { key: "amount", label: "Amount", kind: "money" },
];

function voucherView(key: string, module: string, label: string, primaryVoucherTypeId: number): JournlView {
  return {
    key,
    module,
    label,
    usesPeriod: true,
    columns: VOUCHER_COLUMNS,
    load: async (token, q) =>
      mapOk(
        await journlGet<Paged>(token, "transaction/all-voucher", {
          ...range(q),
          primaryVoucherTypeId,
          page: q.page,
          limit: q.pageSize,
          searchQuery: q.search,
          sortBy: "voucherDate",
          sortOrder: "DESC",
        }),
        (d) => ({
          total: num(d.total),
          rows: (d.result ?? []).map((v) => ({
            id: v.id,
            date: istDate(v.voucherDate ?? v.invoiceDate),
            number: v.voucherNo ?? null,
            party: v.accountName ?? v.billName ?? null,
            invoice: v.invoiceNo ?? v.supplierBill_no ?? v.refNo ?? null,
            tax: Math.abs(num(v.taxAmount as Num)),
            amount: Math.abs(num((v.totalAmount ?? v.amount) as Num)),
          })),
        }),
      ),
  };
}

// ── Parties: customers and vendors are ledgers in JournL ──
const PARTY_COLUMNS: Column[] = [
  { key: "code", label: "Code", kind: "mono" },
  { key: "name", label: "Name" },
  { key: "gstin", label: "GSTIN", kind: "mono" },
  { key: "state", label: "State" },
  { key: "credit_days", label: "Credit days" },
  { key: "balance", label: "Closing balance", kind: "money" },
];

function partyView(key: string, module: string, label: string, path: string): JournlView {
  return {
    key,
    module,
    label,
    usesPeriod: false,
    columns: PARTY_COLUMNS,
    load: async (token, q) =>
      mapOk(await journlGet<Paged>(token, path, { page: q.page, limit: q.pageSize, sortBy: "name", sortOrder: "ASC" }), (d) => ({
        total: num(d.total),
        rows: (d.result ?? []).map((p) => ({
          id: p.id,
          code: p.code ?? null,
          name: p.name ?? null,
          gstin: p.gstNumber || null,
          state: p.stateName ?? p.state ?? null,
          credit_days: p.creditDays ?? null,
          balance: num(p.closingBalance as Num),
        })),
      })),
  };
}

// ── GST returns ──
const GST_COLUMNS: Column[] = [
  { key: "date", label: "Invoice date" },
  { key: "invoice", label: "Invoice", kind: "mono" },
  { key: "party", label: "Party" },
  { key: "gstin", label: "GSTIN", kind: "mono" },
  { key: "type", label: "Type" },
  { key: "taxable", label: "Taxable", kind: "money" },
  { key: "igst", label: "IGST", kind: "money" },
  { key: "cgst", label: "CGST", kind: "money" },
  { key: "sgst", label: "SGST", kind: "money" },
  { key: "value", label: "Invoice value", kind: "money" },
];

function gstView(key: string, label: string, path: string): JournlView {
  return {
    key,
    module: "gst",
    label,
    usesPeriod: true,
    columns: GST_COLUMNS,
    load: async (token, q) =>
      mapOk(await journlGet<Paged>(token, path, { ...range(q), page: q.page, limit: q.pageSize }), (d) => ({
        total: num(d.total),
        rows: (d.result ?? []).map((r, i) => ({
          id: `${r.InvoiceNo ?? i}-${i}`,
          date: r.InvoiceDate ?? null,
          invoice: r.InvoiceNo ?? null,
          party: r.PartyName ?? null,
          gstin: r.GSTIN_UIN || null,
          type: r.TransactionType ?? null,
          taxable: num(r.TaxableValue as Num),
          igst: num(r.IntegratedTaxAmount as Num),
          cgst: num(r.CentralTaxAmount as Num),
          sgst: num(r.StateUTTaxAmount as Num),
          value: num(r.InvoiceValue as Num),
        })),
      })),
  };
}

const VIEW_LIST: JournlView[] = [
  // Sales
  voucherView("sales_invoices", "sales", "Sales invoices", 4),
  voucherView("credit_notes", "sales", "Credit notes (sales returns)", 5),
  voucherView("receipts", "sales", "Receipts", 2),
  // Purchases
  voucherView("purchase_bills", "purchases", "Purchase bills", 6),
  voucherView("debit_notes", "purchases", "Debit notes (purchase returns)", 7),
  voucherView("payments", "purchases", "Payments", 1),
  // Expenses
  voucherView("expenses", "expenses", "Expense bookings", 10),
  // Accounting & ledgers
  voucherView("journals", "accounting", "Journal vouchers", 3),
  {
    key: "ledgers",
    module: "accounting",
    label: "General ledgers",
    usesPeriod: false,
    columns: [
      { key: "code", label: "Code", kind: "mono" },
      { key: "name", label: "Ledger" },
      { key: "group", label: "Group" },
      { key: "opening", label: "Opening balance", kind: "money" },
    ],
    load: async (token, q) =>
      mapOk(await journlGet<Paged>(token, "companyLedgerMaster/general-ledger", { page: q.page, limit: q.pageSize, sortBy: "name", sortOrder: "ASC" }), (d) => ({
        total: num(d.total),
        rows: (d.result ?? []).map((l) => ({ id: l.id, code: l.code ?? null, name: l.name ?? null, group: l.groupName ?? null, opening: num(l.openingBalance as Num) })),
        drill: { view: "ledger_statement", label: "Statement", param: "ledgerId", rowKey: "id" },
      })),
  },
  {
    key: "ledger_groups",
    module: "accounting",
    label: "Ledger groups",
    usesPeriod: false,
    columns: [
      { key: "code", label: "Code", kind: "mono" },
      { key: "name", label: "Group" },
      { key: "nature", label: "Nature" },
    ],
    load: async (token, q) =>
      mapOk(await journlGet<Record<string, unknown>[]>(token, "ledgerGroup/all"), (rows) =>
        pageLocally(
          (rows ?? []).filter((g) => !g.isDeleted).map((g) => ({ id: g.id, code: g.code ?? null, name: g.name ?? null, nature: g.nature ?? null })),
          q,
        ),
      ),
  },
  {
    key: "ledger_statement",
    module: "accounting",
    label: "Ledger statement",
    usesPeriod: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "number", label: "Voucher", kind: "mono" },
      { key: "type", label: "Type" },
      { key: "party", label: "Particulars" },
      { key: "amount", label: "Amount", kind: "money" },
      { key: "balance", label: "Balance", kind: "money" },
    ],
    load: async (token, q) => {
      if (!q.ledgerId) return { kind: "failed", reason: "Choose a ledger to see its statement" };
      return mapOk(
        await journlGet<{ result?: Record<string, unknown>[] }>(token, "reports/ledger-statement", { ledgerId: q.ledgerId, startDate: q.from, endDate: q.to, allBranches: true }),
        (d) =>
          pageLocally(
            (d.result ?? []).map((r, i) => ({
              id: `${r.id ?? i}`,
              date: istDate(r.voucherDate),
              number: r.voucherNumber ?? null,
              type: r.voucherTypeName ?? r.voucherType ?? null,
              party: r.partyName ?? r.ledgerName ?? null,
              amount: num(r.totalAmount as Num),
              balance: num(r.balance as Num),
            })),
            q,
          ),
      );
    },
  },
  // Customers & vendors
  partyView("customers", "customers", "Customers", "companyLedgerMaster/customer-ledger"),
  partyView("vendors", "vendors", "Vendors", "companyLedgerMaster/supplier-ledger"),
  // Banking
  {
    key: "bank_accounts",
    module: "banking",
    label: "Bank accounts",
    usesPeriod: false,
    columns: [
      { key: "name", label: "Ledger" },
      { key: "bank", label: "Bank" },
      { key: "account", label: "Account no.", kind: "mono" },
      { key: "ifsc", label: "IFSC", kind: "mono" },
      { key: "opening", label: "Opening balance", kind: "money" },
    ],
    load: async (token, q) =>
      mapOk(await journlGet<Record<string, unknown>[]>(token, "companyLedgerMaster/primary-group-id-list", { primaryId: 28 }), (rows) => ({
        ...pageLocally(
          (rows ?? []).map((b) => ({ id: b.id, name: b.name ?? null, bank: b.bankName ?? null, account: b.accountNumber ?? null, ifsc: b.bankIFSC ?? null, opening: num(b.openingBalance as Num) })),
          q,
        ),
        drill: { view: "bank_statement", label: "Transactions", param: "ledgerId", rowKey: "id" },
      })),
  },
  // Inventory
  {
    key: "stock_items",
    module: "inventory",
    label: "Stock items",
    usesPeriod: false,
    columns: [
      { key: "code", label: "Code", kind: "mono" },
      { key: "name", label: "Item" },
      { key: "hsn", label: "HSN", kind: "mono" },
      { key: "group", label: "Group" },
      { key: "unit", label: "Unit" },
      { key: "tax", label: "Tax %" },
      { key: "mrp", label: "MRP", kind: "money" },
    ],
    load: async (token, q) =>
      mapOk(await journlGet<Paged>(token, "companyStockItem", { page: q.page, limit: q.pageSize }), (d) => ({
        total: num(d.total),
        rows: (d.result ?? []).map((s) => ({
          id: s.id,
          code: s.code ?? null,
          name: s.name ?? null,
          hsn: s.hsnCode ?? null,
          group: s.stockGroupName ?? null,
          unit: s.baseUnitName ?? null,
          tax: s.taxPercentage ?? null,
          mrp: num(s.mrp as Num),
        })),
      })),
  },
  voucherView("stock_journals", "inventory", "Stock journals", 9),
  // GST & tax
  gstView("gstr1", "GSTR-1 (outward supplies)", "reports/gst-r1-report"),
  gstView("gstr2b", "GSTR-2B (inward supplies)", "reports/gst-r2b-report"),
];

// The bank statement is a ledger statement, but under the Banking grant.
const ledgerStatement = VIEW_LIST.find((v) => v.key === "ledger_statement")!;
VIEW_LIST.push({ ...ledgerStatement, key: "bank_statement", module: "banking", label: "Bank transactions" });

export const JOURNL_VIEWS: Record<string, JournlView> = Object.fromEntries(VIEW_LIST.map((v) => [v.key, v]));

/** The views shown as tabs for each module (drill-only views are reached from a row). */
export const MODULE_TABS: Record<string, string[]> = {
  sales: ["sales_invoices", "credit_notes", "receipts"],
  purchases: ["purchase_bills", "debit_notes", "payments"],
  expenses: ["expenses"],
  accounting: ["journals", "ledgers", "ledger_groups"],
  customers: ["customers"],
  vendors: ["vendors"],
  banking: ["bank_accounts"],
  inventory: ["stock_items", "stock_journals"],
  gst: ["gstr1", "gstr2b"],
  financial_reports: [],
};
