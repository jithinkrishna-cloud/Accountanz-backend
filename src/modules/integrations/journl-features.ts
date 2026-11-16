/**
 * JournL's user-permission features: the ids JournL returns as permissionData at login. Copied from JournL's source
 * (Bizpole-Books-Client src/constants/FeatureIds.ts, newest copy incl. PAYMENT_MODE = 42); JournL has no API that
 * lists them. Keep in step with that file.
 *
 * Each feature is its own grantable permission (a row in journl_modules, keyed `f_*`, journl_module_id = its id).
 * Areas group them for display and are the pages of the staff JournL workspace.
 */
export const JOURNL_AREAS = [
  { key: "sales", label: "Sales" },
  { key: "purchases", label: "Purchases" },
  { key: "expenses", label: "Expenses" },
  { key: "customers", label: "Customers" },
  { key: "vendors", label: "Vendors" },
  { key: "accounting", label: "Accounting & Ledgers" },
  { key: "inventory", label: "Inventory" },
  { key: "gst", label: "GST & Tax" },
  { key: "financial_reports", label: "Financial Reports" },
  { key: "settings", label: "Settings / Administration" },
] as const;
export type JournlAreaKey = (typeof JOURNL_AREAS)[number]["key"];
export const AREA_LABEL: Record<string, string> = Object.fromEntries(JOURNL_AREAS.map((a) => [a.key, a.label]));

export interface JournlFeatureDef {
  /** journl_modules.module_key */
  key: string;
  /** JournL FeatureIds value */
  id: number;
  name: string;
  area: JournlAreaKey;
  /** Settings features can't be granted to accountants. */
  restricted?: boolean;
}

export const JOURNL_FEATURE_LIST: JournlFeatureDef[] = [
  { key: "f_sales", id: 14, name: "Sales", area: "sales" },
  { key: "f_sales_return", id: 15, name: "Sales Return", area: "sales" },
  { key: "f_receipt", id: 12, name: "Receipt", area: "sales" },
  { key: "f_estimate", id: 18, name: "Estimate", area: "sales" },
  { key: "f_salesmen", id: 10, name: "Salesmen", area: "sales" },
  { key: "f_purchase", id: 16, name: "Purchase", area: "purchases" },
  { key: "f_purchase_return", id: 17, name: "Purchase Return", area: "purchases" },
  { key: "f_payment", id: 11, name: "Payment", area: "purchases" },
  { key: "f_expense_booking", id: 20, name: "Expense Booking", area: "expenses" },
  { key: "f_customers", id: 3, name: "Customers", area: "customers" },
  { key: "f_customer_frequency", id: 25, name: "Customer Frequency", area: "customers" },
  { key: "f_suppliers", id: 4, name: "Suppliers", area: "vendors" },
  { key: "f_ledger_groups", id: 1, name: "Ledger Groups", area: "accounting" },
  { key: "f_general_ledgers", id: 2, name: "General Ledgers", area: "accounting" },
  { key: "f_journal", id: 13, name: "Journal", area: "accounting" },
  { key: "f_ledger_statement", id: 26, name: "Ledger Statement", area: "accounting" },
  { key: "f_chart_of_accounts", id: 31, name: "Chart of Accounts", area: "accounting" },
  { key: "f_voucher_types", id: 9, name: "Voucher Types", area: "accounting" },
  { key: "f_payment_modes", id: 42, name: "Payment Modes", area: "accounting" },
  { key: "f_revoke_bin", id: 41, name: "Revoke Bin", area: "accounting" },
  { key: "f_stock_items", id: 8, name: "Stock Items", area: "inventory" },
  { key: "f_units", id: 5, name: "Units", area: "inventory" },
  { key: "f_stock_groups", id: 6, name: "Stock Groups", area: "inventory" },
  { key: "f_stock_categories", id: 7, name: "Stock Categories", area: "inventory" },
  { key: "f_stock_journal", id: 19, name: "Stock Journal", area: "inventory" },
  { key: "f_closing_stock", id: 28, name: "Closing Stock", area: "inventory" },
  { key: "f_stock_item_statement", id: 29, name: "Stock Item Statement", area: "inventory" },
  { key: "f_gstr1", id: 39, name: "GSTR-1", area: "gst" },
  { key: "f_gstr2b", id: 40, name: "GSTR-2B", area: "gst" },
  { key: "f_trial_balance", id: 21, name: "Trial Balance", area: "financial_reports" },
  { key: "f_profit_loss", id: 22, name: "Profit & Loss", area: "financial_reports" },
  { key: "f_balance_sheet", id: 23, name: "Balance Sheet", area: "financial_reports" },
  { key: "f_cash_flow", id: 30, name: "Cash Flow Statement", area: "financial_reports" },
  { key: "f_day_book", id: 24, name: "Day Book", area: "financial_reports" },
  { key: "f_register_reports", id: 27, name: "Register Reports", area: "financial_reports" },
  { key: "f_group_summary", id: 38, name: "Group Summary", area: "financial_reports" },
  { key: "f_payable_ageing", id: 36, name: "Payable Ageing", area: "financial_reports" },
  { key: "f_receivable_ageing", id: 37, name: "Receivable Ageing", area: "financial_reports" },
  { key: "f_users", id: 32, name: "Users", area: "settings", restricted: true },
  { key: "f_branches", id: 33, name: "Branches", area: "settings", restricted: true },
  { key: "f_audit_log", id: 34, name: "Audit Log", area: "settings", restricted: true },
  { key: "f_invoice_templates", id: 35, name: "Invoice Templates", area: "settings", restricted: true },
];

const BY_ID = new Map(JOURNL_FEATURE_LIST.map((f) => [f.id, f]));

export interface JournlFeature {
  id: number;
  name: string;
  /** False when JournL's FeatureIds has no such id (a mapping to check), so it isn't shown as if it were known. */
  known: boolean;
}

/** "14,15" → named features, in the mapping's order. */
export function featuresFor(idsCsv: string | null): JournlFeature[] {
  if (!idsCsv) return [];
  return idsCsv
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
    .map((id) => {
      const f = BY_ID.get(id);
      return f ? { id, name: f.name, known: true } : { id, name: `JournL feature #${id}`, known: false };
    });
}
