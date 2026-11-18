/**
 * Sample JournL (Bizpole Books) response shapes, verified on 2026-11-18 against the dev API
 * (testapi.bizpolebooks.com, company 218) and the Bizpole-Books-Server source. Names, ids,
 * contact fields are anonymised. Each value is what `journlGet` returns as `data` (the gateway
 * unwraps `{ success, message, data }`); the raw envelope is noted per fixture.
 * Task 3 should re-type these with its own interfaces.
 */

/** GET /companyLedgerMaster/id/:id  -> { success, message, data } (standard `{success,message,data}` envelope; PUT must always send the full current openingBillEntry list mapped to billEntryId/name/billDate/dueDate/amount/entryType, see plan Task 1 findings) */
export const ledgerById = {
  id: 30, companyId: 218, code: "JEL003I", name: "Sample Supplier",
  primaryGroupId: 3, groupId: 29, serviceId: 5, taxId: null, taxType: "unknown",
  gstNumber: "", panNumber: "",
  openingBalance: 50000, // always a positive number; side is in transactionType
  transactionType: "payable" as "payable" | "receivable", // payable = Cr opening, receivable = Dr opening
  enableBillWise: 0 as number | null, creditDays: null, creditAmount: null,
  address1: "", address2: "", country: null, state: null, pincode: "", contactPerson: "", email: "",
  accountHolder: "", accountNumber: "", bankName: "", bankBranch: "", bankIFSC: "", bankSwiftCode: "",
  isDefault: 0, branchId: 1, salesManId: null, msmeNo: null,
  createdAt: "2026-05-07T10:49:39.000Z", createdBy: 307, updatedAt: null, updatedBy: null,
  isDeleted: 0, hsnCode: null,
  // GET-only extras joined in by the controller (not accepted by PUT):
  serviceTypeName: "Goods and Service", taxRate: null, taxName: null, groupName: "Sundry Creditors",
  countryName: null, stateName: null, salesManName: null,
  openingBillEntry: [] as { id: number; billNo: string; entryDate: string; dueDate: string; amount: number; settledAmount: string }[],
};

/** GET /company-voucher-types/primary-voucher-id/3 -> data: row[] (own row + rows whose primaryVoucherId = 3) */
export const voucherTypesForJournal = [
  {
    id: 3, name: "Journal", methodOfNumbering: 0, primaryVoucherId: null, startingNumber: 1,
    numberWidth: null, yearlyRestarting: 0, prefix: "", suffix: "", dateEditable: 0, branchId: 1,
    createdAt: "2026-05-06T06:52:05.000Z", createdBy: 1, updatedAt: null, updatedBy: null,
    isDeleted: 0, isPrimary: 1,
  },
];

/** GET /company-branch/all -> data: row[] (note: row has no primary flag) */
export const branchesAll = [
  { id: 7, code: "BRN006K", name: "Branch A", createdBy: 307, updatedBy: null, createdAt: "2026-08-19T08:51:26.000Z", updatedAt: null, isDeleted: 0 },
  { id: 3, code: "BRN002K", name: "Branch B", createdBy: 307, updatedBy: null, createdAt: "2026-05-07T00:00:00.000Z", updatedAt: null, isDeleted: 0 },
  { id: 1, code: "BR001", name: "Head Office", createdBy: 1, updatedBy: null, createdAt: "2026-05-06T06:52:05.000Z", updatedAt: null, isDeleted: 0 },
];

/**
 * POST /transaction/journal (addJournalVoucher) success: HTTP 201 { success: true, message: "Voucher added successfully", data: <voucherId:number> }
 * i.e. the new voucher id is the bare number in `data`. NOT observed live (writes not run); from voucherJournalController.js:282-286.
 */
export const createJournalOk = { success: true, message: "Voucher added successfully", data: 123 };

/** addJournalVoucher failures: 400 { success:false, message } (bad voucherType/validation) or 500 { success:false, message:"Failed to complete transaction", error }. voucherJournalController.js:89,290 */
export const createJournalFail = { success: false, message: "Failed to complete transaction", error: "sample error text" };

/** PUT /companyLedgerMaster/:id success, HTTP 200. NOT observed live; from companyLedgerMasterController.js (updateCompanyLedgerMaster). `data` echoes req.body plus id, code (stored) and updatedAt. */
export const ledgerUpdateOk = {
  success: true,
  message: "Company Ledger Master updated successfully",
  data: { id: "30", code: "JEL003I", updatedAt: "2026-11-18T09:00:00.000Z" /* ...plus every field sent in the body */ },
};

/** GET /transaction/all-voucher?searchQuery=36&allBranches=true -> HTTP body is the paged object itself under `data` after unwrapping */
export const allVoucherSearch = {
  total: 2, page: 1, limit: 5, totalPages: 1, debitTotalAmount: 20, creditTotalAmount: 0, balance: -20,
  result: [
    {
      id: 102, voucherNo: "36", voucherType: "Sales", voucherTypeId: 4, invoiceNo: "37",
      invoiceDate: "2026-10-21T00:00:00.000Z", accountId: 62, description: "", amount: -10, totalAmount: -10,
      isDeleted: 0, branchId: 1, voucherDate: "2026-10-21T00:00:00.000Z", primaryVoucherTypeId: "4",
      accountName: "Sample Party", voucherTypeName: "Sales",
      particulars: [{ isDr: 1, amount: 10, particularsName: "Sample Party" }],
    },
  ],
};

/**
 * Ledger rows for one primary group: GET /companyLedgerMaster/accounting-groups-ledger?id=<primaryGroupId>
 * (the `id` query param is REQUIRED, it is a primaryGroupId; 404 {message:"No records found"} if empty).
 * HTTP body is { data: rows } (no `success` key; journlGet treats that as ok). Rows = company_ledger_master columns + totalAmountSum.
 */
export const accountingGroupsLedger = [
  { ...{ id: 27, companyId: 218, code: "SUP001C", name: "Sample Creditor", primaryGroupId: 22, groupId: 22, openingBalance: 0, transactionType: "payable", branchId: 1, isDeleted: 0 }, totalAmountSum: 2070 },
];

/** GET /ledgerGroup/all -> data: group[] (used to find Suspense; id 9, default 1, parentId 0, nature Liabilities) */
export const ledgerGroupsAll = [
  { id: 9, primaryId: 9, parentId: 0, code: "Suspense A/c", name: "Suspense A/c", nature: "Liabilities", default: 1, branchId: 1, createdAt: "2026-05-06T06:52:05.000Z", createdBy: 1, updatedAt: null, updatedBy: null, isDeleted: 0 },
  { id: 22, primaryId: 22, parentId: 3, code: "Sundry Creditors", name: "Sundry Creditors", nature: "Liabilities", default: 1, branchId: 1, createdAt: "2026-05-06T06:52:05.000Z", createdBy: 1, updatedAt: null, updatedBy: null, isDeleted: 0 },
];
