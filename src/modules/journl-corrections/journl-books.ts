import { AppError } from "../../utils/app-error.js";
import { istDate } from "../integrations/journl-data.service.js";
import { journlGet, type ReadResult } from "../integrations/journl.gateway.js";

/**
 * Read-only helpers over a client's JournL books for corrections. Every call is a GET through `journlGet`.
 * Money leaves this file in paise (integers); JournL rupee numbers are converted once with `toPaise`.
 * Response bodies are never logged or stored here.
 */

export const SESSION_EXPIRED = "The JournL session has expired. Ask the owner to sign in with JournL again.";
/** Seeded "Suspense A/c" accounting group id; stable across JournL companies (Task 1, outcome A). */
export const DEFAULT_SUSPENSE_GROUP_ID = 9;
export const NOT_SUSPENSE = "Choose a ledger in a Suspense group. Create one in JournL first if there is none.";

type Num = number | string | null | undefined;

/** JournL rupees (number or numeric string) to integer paise. Never sum rupee floats; sum the result of this. */
export function toPaise(v: Num): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  // A present but unreadable amount must not silently become 0 (it would skew the difference and the Suspense amount).
  if (!Number.isFinite(n)) throw new AppError("UNAVAILABLE", "JournL sent an amount Accountanz can't read");
  return Math.round(n * 100) || 0; // `|| 0` turns -0 into 0
}

/** Unwraps a read: expired session → 409 with the refresh wording; failure → 503 with the gateway's reason. */
function unwrap<T>(r: ReadResult<T>): T {
  if (r.kind === "expired") throw AppError.conflict(SESSION_EXPIRED);
  if (r.kind === "failed") throw new AppError("UNAVAILABLE", r.reason);
  return r.data;
}

/** JournL's ledger-not-found answer ("Company Ledger Master not found"). Other 404s (company, route) are real failures. */
const isLedgerNotFound = (r: ReadResult<unknown>) => r.kind === "failed" && /ledger[^.]*not found/i.test(r.reason);
/** Search endpoints answer 404 "No records found" for an empty result. */
const isNoRecords = (r: ReadResult<unknown>) => r.kind === "failed" && /no records/i.test(r.reason);

/** The ledger row as JournL returns it (all other columns are kept, Task 8 PUTs the whole object back). */
export interface JournlLedger extends Record<string, unknown> {
  id: number;
  name: string;
  groupId: number | null;
  primaryGroupId: number | null;
  groupName?: string | null;
  openingBalance: Num;
  transactionType: string | null;
  enableBillWise: number | null;
  branchId: number | null;
  isDeleted?: number | null;
  openingBillEntry?: unknown[] | null;
}

export interface JournlGroup {
  id: number;
  name: string;
  isDeleted?: number | null;
}

/** GET companyLedgerMaster/id/:id. `null` when JournL has no such (live) ledger in this company. */
export async function getLedger(token: string, id: number): Promise<JournlLedger | null> {
  const r = await journlGet<JournlLedger | null>(token, `companyLedgerMaster/id/${encodeURIComponent(String(id))}`);
  if (isLedgerNotFound(r)) return null;
  const row = unwrap(r);
  if (!row || typeof row !== "object" || row.isDeleted || Number(row.id) !== id) return null;
  return row;
}

export interface LedgerHit {
  id: number;
  name: string;
  group_id: number | null;
  group_name: string | null;
}

/** GET companyLedgerMaster/search?searchText=… (accepts a bare array or a paged `{ result }` body). */
export async function searchLedgers(token: string, q: string): Promise<LedgerHit[]> {
  const r = await journlGet<Record<string, unknown>[] | { result?: Record<string, unknown>[] }>(token, "companyLedgerMaster/search", { searchText: q });
  if (isNoRecords(r)) return [];
  const data = unwrap(r);
  const rows = Array.isArray(data) ? data : (data?.result ?? []);
  return rows
    .filter((l) => !l.isDeleted && typeof l.id === "number")
    .map((l) => ({
      id: l.id as number,
      name: String(l.name ?? ""),
      group_id: l.groupId == null ? null : Number(l.groupId),
      group_name: (l.groupName as string) ?? null,
    }));
}

/** Books start date (YYYY-MM-DD, India time) from GET companyMaster/:companyId. */
export async function booksStart(token: string, companyId: string): Promise<string> {
  const data = unwrap(await journlGet<Record<string, unknown>>(token, `companyMaster/${encodeURIComponent(companyId)}`));
  const start = istDate(data?.startDate);
  if (!start) throw new AppError("UNAVAILABLE", "JournL didn't return the start date of this client's books");
  return start;
}

export interface TbNode {
  id?: number;
  name?: string;
  ledgerId?: number;
  ledgerName?: string;
  closingBalance?: Num;
  children?: TbNode[];
}

/** Trial balance from the start of the books to `asOf`, all branches. Signed: Dr negative, Cr positive. */
export async function trialBalance(token: string, asOf: string, start: string): Promise<TbNode[]> {
  const data = unwrap(
    await journlGet<TbNode[]>(token, "defaultAccountingGroups/trial-balance", { startDate: start, endDate: asOf, companyStartDate: start, allBranches: true }),
  );
  if (!Array.isArray(data)) throw new AppError("UNAVAILABLE", "JournL sent the trial balance in a shape Accountanz doesn't recognise");
  return data;
}

/** Σ closingBalance over the top-level groups, in paise. 0 = balanced; > 0 = credits exceed debits. */
export const tbDifferenceOf = (nodes: TbNode[]): number => nodes.reduce((s, g) => s + toPaise(g.closingBalance), 0);

/**
 * A ledger's signed closing balance (paise) from the trial-balance tree. Leaves carrying `ledgerId` (the live shape)
 * match by that id only. Leaves without it but with `ledgerName` fall back to `id`, and then `name` (when given) must
 * match too, because group and ledger ids can collide. A ledger missing from the tree has a zero balance (JournL omits
 * zero rows).
 */
export function ledgerClosingOf(nodes: TbNode[], ledgerId: number, name?: string): number {
  const nameOk = (n: TbNode) => !name || (n.ledgerName ?? n.name ?? "").trim().toLowerCase() === name.trim().toLowerCase();
  const walk = (list: TbNode[]): number | null => {
    for (const n of list) {
      if (n.children?.length) {
        const found = walk(n.children);
        if (found !== null) return found;
        continue;
      }
      if (n.ledgerId != null) {
        if (Number(n.ledgerId) === ledgerId) return toPaise(n.closingBalance);
      } else if (n.ledgerName != null && Number(n.id) === ledgerId && nameOk(n)) {
        return toPaise(n.closingBalance);
      }
    }
    return null;
  };
  return walk(nodes) ?? 0;
}

export async function ledgerClosing(token: string, ledgerId: number, asOf: string, start: string, name?: string): Promise<number> {
  return ledgerClosingOf(await trialBalance(token, asOf, start), ledgerId, name);
}

export async function trialBalanceDifference(token: string, asOf: string, start: string): Promise<number> {
  return tbDifferenceOf(await trialBalance(token, asOf, start));
}

/** The company's Journal voucher type (GET company-voucher-types/primary-voucher-id/3). */
export async function journalVoucherType(token: string): Promise<{ voucherTypeId: number; primaryVoucherTypeId: 3 }> {
  const rows = unwrap(await journlGet<{ id: number; name?: string; isPrimary?: number; isDeleted?: number }[]>(token, "company-voucher-types/primary-voucher-id/3"));
  const live = (Array.isArray(rows) ? rows : []).filter((r) => typeof r.id === "number" && !r.isDeleted);
  const pick = live.find((r) => r.isPrimary === 1) ?? live.find((r) => /^journal$/i.test(r.name ?? ""));
  if (!pick) throw AppError.conflict("JournL has no Journal voucher type for this company");
  return { voucherTypeId: pick.id, primaryVoucherTypeId: 3 };
}

/** Live branches (GET company-branch/all). */
export async function branches(token: string): Promise<{ id: number; name: string }[]> {
  const rows = unwrap(await journlGet<{ id: number; name?: string; isDeleted?: number }[]>(token, "company-branch/all"));
  return (Array.isArray(rows) ? rows : []).filter((b) => typeof b.id === "number" && !b.isDeleted).map((b) => ({ id: b.id, name: String(b.name ?? `Branch ${b.id}`) }));
}

/** The branch holding the ledger's Opening Balance entry (the ledger row's `branchId`). */
export async function openingEntryBranch(token: string, ledgerId: number): Promise<number> {
  const ledger = await getLedger(token, ledgerId);
  if (!ledger) throw AppError.notFound("Ledger");
  const branch = Number(ledger.branchId);
  if (!Number.isInteger(branch) || branch <= 0) throw AppError.conflict("JournL didn't say which branch holds this ledger's opening balance");
  return branch;
}

const VOUCHER_PAGE = 100;
const VOUCHER_MAX_PAGES = 500;

/**
 * Every voucher whose `invoiceNo` is exactly `ref`, searched across all branches. JournL's search is a substring match
 * (ACZ-1 also hits ACZ-10, ACZ-100 and party names), so this pages through every hit and filters exactly. It never
 * answers "none" unless it saw every result: any failed or expired read, an unreadable page, or a page that ends
 * short of `total` throws. More than one id is an anomaly for the caller to handle.
 */
export async function findVoucherByRef(token: string, ref: string): Promise<{ id: string }[]> {
  const matches = new Set<string>();
  const seen = new Set<string>(); // distinct voucher ids seen, so repeated rows across pages can't fake completeness
  for (let page = 1; page <= VOUCHER_MAX_PAGES; page++) {
    const data = unwrap(
      await journlGet<{ total?: Num; result?: { id?: unknown; invoiceNo?: unknown }[] }>(token, "transaction/all-voucher", {
        searchQuery: ref,
        allBranches: true,
        // Fixed order so pages don't shift between requests. getAllVoucher allows sortBy vchNo/voucherDate/particulars/
        // amount/createdAt (not id) and always adds `v.id <direction>` as the tie-break.
        sortBy: "voucherDate",
        sortOrder: "ASC",
        page,
        limit: VOUCHER_PAGE,
      }),
    );
    const rows = Array.isArray(data?.result) ? data.result : null;
    const total = data?.total == null || data.total === "" ? NaN : Number(data.total);
    if (!rows || !Number.isInteger(total) || total < 0) throw new AppError("UNAVAILABLE", "JournL sent the voucher search in a shape Accountanz doesn't recognise");
    const before = seen.size;
    for (const v of rows) {
      if (v.id == null) throw new AppError("UNAVAILABLE", "JournL sent a voucher without an id");
      const id = String(v.id);
      seen.add(id);
      if (String(v.invoiceNo ?? "") === ref) matches.add(id);
    }
    if (seen.size >= total) return [...matches].map((id) => ({ id }));
    if (seen.size === before) throw new AppError("UNAVAILABLE", "JournL's voucher search ended before every result was read");
  }
  throw new AppError("UNAVAILABLE", "Too many JournL vouchers match this reference to check them all");
}

/** All accounting groups (GET ledgerGroup/all). */
export async function ledgerGroups(token: string): Promise<JournlGroup[]> {
  const rows = unwrap(await journlGet<JournlGroup[]>(token, "ledgerGroup/all"));
  return Array.isArray(rows) ? rows : [];
}

/**
 * Is `ledger` in the Suspense group `groupId`? The group must exist in this company, be live and be named like
 * Suspense (tenant check); the ledger's groupId or primaryGroupId must equal it. Ledger names are never matched.
 */
export function suspenseCheck(
  ledger: Pick<JournlLedger, "groupId" | "primaryGroupId">,
  groupId: number,
  groups: JournlGroup[],
): { ok: true } | { ok: false; reason: string } {
  const group = groups.find((g) => Number(g.id) === groupId);
  if (!group || group.isDeleted || !/suspense/i.test(group.name ?? "")) {
    return { ok: false, reason: `Group ${groupId} in JournL is not a Suspense group, so Accountanz can't tell which ledger is Suspense. Ask a super admin to set this client's Suspense group.` };
  }
  if (Number(ledger.groupId) !== groupId && Number(ledger.primaryGroupId) !== groupId) return { ok: false, reason: NOT_SUSPENSE };
  return { ok: true };
}
