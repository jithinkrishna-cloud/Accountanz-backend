/**
 * JournL's user-permission features, by id: the ids JournL returns as permissionData at login and that
 * journl_modules.journl_module_id lists. Copied from JournL's source (Bizpole-Books-Client
 * src/constants/FeatureIds.ts, newest copy incl. PAYMENT_MODE = 42); JournL has no API that lists them.
 * Names are written for clients and staff, not JournL's constant names. Keep in step with that file.
 */
export const JOURNL_FEATURES: Record<number, string> = {
  // Masters
  1: "Ledger Groups",
  2: "General Ledgers",
  3: "Customers",
  4: "Suppliers",
  5: "Units",
  6: "Stock Groups",
  7: "Stock Categories",
  8: "Stock Items",
  9: "Voucher Types",
  10: "Salesmen",
  42: "Payment Modes",
  // Vouchers
  11: "Payment",
  12: "Receipt",
  13: "Journal",
  14: "Sales",
  15: "Sales Return",
  16: "Purchase",
  17: "Purchase Return",
  18: "Estimate",
  19: "Stock Journal",
  20: "Expense Booking",
  41: "Revoke Bin",
  // Reports
  21: "Trial Balance",
  22: "Profit & Loss",
  23: "Balance Sheet",
  24: "Day Book",
  25: "Customer Frequency",
  26: "Ledger Statement",
  27: "Register Reports",
  28: "Closing Stock",
  29: "Stock Item Statement",
  30: "Cash Flow Statement",
  36: "Payable Ageing",
  37: "Receivable Ageing",
  38: "Group Summary",
  39: "GSTR-1",
  40: "GSTR-2B",
  // Settings
  31: "Chart of Accounts",
  32: "Users",
  33: "Branches",
  34: "Audit Log",
  35: "Invoice Templates",
};

export interface JournlFeature {
  id: number;
  name: string;
  /** False when JournL's FeatureIds has no such id (a mapping to check), so it isn't shown as if it were known. */
  known: boolean;
}

/** "14,15,12,18" → named features, in the mapping's order. */
export function featuresFor(idsCsv: string | null): JournlFeature[] {
  if (!idsCsv) return [];
  return idsCsv
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
    .map((id) => (JOURNL_FEATURES[id] ? { id, name: JOURNL_FEATURES[id], known: true } : { id, name: `JournL feature #${id}`, known: false }));
}
