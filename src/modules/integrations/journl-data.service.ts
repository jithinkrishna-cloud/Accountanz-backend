import { env } from "../../config/env.js";
import { queryOne } from "../../database/connection.js";
import { AppError } from "../../utils/app-error.js";
import { decryptSecret } from "../../utils/crypto.js";
import { journlGet, type ReadResult } from "./journl.gateway.js";
import { SUSPENSE_CHECK_FAILED, suspenseField, type SuspenseField } from "../journl-corrections/suspense-status.js";

/**
 * Read-only view of a client's JournL books, fetched live with the session the owner created by signing in
 * with JournL. Nothing is stored or written back: every call is a GET (see journlGet).
 */

type Num = number | string | null | undefined;
const num = (v: Num) => (v == null || v === "" ? 0 : Number(v) || 0);

/** JournL dates come back as ISO timestamps in UTC; the books are kept in India time. */
export const istDate = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

export interface Section<T> {
  data: T | null;
  error: string | null;
}

export interface JournlOverview {
  period: { from: string; to: string };
  session_expires_at: string;
  company: Section<{ id: string; name: string; code: string | null; email: string | null; phone: string | null; gstin: string | null; address: string | null; state: string | null; books_start: string | null }>;
  branches: Section<{ id: number; code: string | null; name: string }[]>;
  profit_loss: Section<{ total_income: number; total_expense: number; net_profit: number; groups: { nature: string; name: string; amount: number }[] }>;
  /** `suspense` is set whenever the client id is known: null = nothing to flag; `{ error }` = couldn't check (render as a warning). */
  trial_balance: Section<{ id: number; name: string; debit: number; credit: number; ledgers: { name: string; debit: number; credit: number }[] }[]> & { suspense: SuspenseField };
  vouchers: Section<{ total: number; rows: { id: number; number: string | null; date: string | null; type: string | null; account: string | null; description: string | null; amount: number }[] }>;
}

const section = <R, T>(r: PromiseSettledResult<ReadResult<R>>, map: (data: R) => T): Section<T> => {
  if (r.status === "rejected") return { data: null, error: "Couldn't read this from JournL" };
  const v = r.value;
  if (v.kind === "expired") return { data: null, error: "The JournL session has expired" };
  if (v.kind === "failed") return { data: null, error: v.reason };
  try {
    return { data: map(v.data), error: null };
  } catch {
    return { data: null, error: "JournL sent this in a shape Accountanz doesn't recognise" };
  }
};

/** Trial balance amounts: debit is negative in JournL. Split into Dr/Cr columns. */
const drCr = (closeDebit: Num, closeCredit: Num, closing: Num) => {
  const d = Math.abs(num(closeDebit));
  const c = Math.abs(num(closeCredit));
  if (d || c) return { debit: d, credit: c };
  const v = num(closing);
  return v < 0 ? { debit: -v, credit: 0 } : { debit: 0, credit: v };
};

interface TbNode { id?: number; name?: string; ledgerName?: string; closeDebit?: Num; closeCredit?: Num; closingBalance?: Num; children?: TbNode[] }
const ledgersOf = (node: TbNode): { name: string; debit: number; credit: number }[] =>
  (node.children ?? []).flatMap((c) =>
    c.children?.length ? ledgersOf(c) : [{ name: c.ledgerName ?? c.name ?? "—", ...drCr(c.closeDebit, c.closeCredit, c.closingBalance) }],
  ).filter((l) => l.debit || l.credit);

/** A live JournL session for a connection: the decrypted owner token, the JournL company and when it expires. */
export async function openJournlSession(connectionId: number) {
  const conn = await queryOne<{ external_org_id: string | null; status: string; access_token_enc: string | null; token_expires_at: string | null }>(
    `SELECT external_org_id, status, access_token_enc, token_expires_at FROM integration_connections WHERE id = ? AND provider = 'journl'`,
    [connectionId],
  );
  if (!conn) throw AppError.notFound("Connection");
  if (conn.status !== "connected" || !conn.external_org_id) throw AppError.conflict("This client hasn't connected JournL");
  if (!conn.access_token_enc || !conn.token_expires_at || !env.JOURNL_TOKEN_KEY) {
    throw AppError.conflict("Accountanz has no JournL session for this client. Ask the owner to sign in with JournL again.");
  }
  if (new Date(conn.token_expires_at).getTime() <= Date.now()) {
    throw AppError.conflict("The JournL session has expired (JournL sessions last 8 hours). Ask the owner to sign in with JournL again.");
  }
  try {
    return { token: decryptSecret(conn.access_token_enc, env.JOURNL_TOKEN_KEY), companyId: conn.external_org_id, expiresAt: new Date(conn.token_expires_at) };
  } catch {
    throw AppError.conflict("The stored JournL session can't be read. Ask the owner to sign in with JournL again.");
  }
}

export async function getJournlOverview(connectionId: number, period: { from: string; to: string }, clientId?: number | null): Promise<JournlOverview> {
  const { token, companyId, expiresAt } = await openJournlSession(connectionId);
  const companyRes = await journlGet<Record<string, unknown>>(token, `companyMaster/${encodeURIComponent(companyId)}`);
  if (companyRes.kind === "expired") throw AppError.conflict("The JournL session has expired. Ask the owner to sign in with JournL again.");
  const booksStart = companyRes.kind === "ok" ? istDate(companyRes.data.startDate) : null;

  const range = { startDate: period.from, endDate: period.to, allBranches: true };
  const [branches, pl, tb, vouchers] = await Promise.allSettled([
    journlGet<{ id: number; code?: string; name: string; isDeleted?: number }[]>(token, "company-branch/all"),
    journlGet<{ data: { nature: string; groups: { name: string; totalAmount?: Num }[] }[]; totals: { totalIncome: Num; totalExpense: Num; netProfitLoss: Num } }>(token, "defaultAccountingGroups/profit-loss", range),
    journlGet<TbNode[]>(token, "defaultAccountingGroups/trial-balance", { ...range, companyStartDate: booksStart ?? period.from }),
    journlGet<{ total: Num; result: Record<string, unknown>[] }>(token, "transaction/all-voucher", { ...range, page: 1, limit: 25, sortBy: "voucherDate", sortOrder: "DESC" }),
  ]);

  const tbSection = section(tb, (groups) =>
    groups.map((g) => ({ id: g.id ?? 0, name: g.name ?? "—", ...drCr(g.closeDebit, g.closeCredit, g.closingBalance), ledgers: ledgersOf(g) })),
  );
  // Suspense is read from the raw tree (it keeps ledgerId); only when the trial balance itself was read.
  const rawTb = tb.status === "fulfilled" && tb.value.kind === "ok" && Array.isArray(tb.value.data) ? tb.value.data : null;
  const suspense: SuspenseField = rawTb ? (clientId != null ? await suspenseField(clientId, rawTb) : { error: SUSPENSE_CHECK_FAILED }) : null;

  return {
    period,
    session_expires_at: expiresAt.toISOString(),
    company: section({ status: "fulfilled", value: companyRes }, (c) => ({
      id: companyId,
      name: String(c.name ?? ""),
      code: (c.code as string) ?? null,
      email: (c.email as string) ?? null,
      phone: (c.phoneNumber as string) ?? null,
      gstin: (c.gstNumber as string) || null,
      address: (c.address as string) ?? null,
      state: (c.stateName as string) ?? null,
      books_start: booksStart,
    })),
    branches: section(branches, (rows) => rows.filter((b) => !b.isDeleted).map((b) => ({ id: b.id, code: b.code ?? null, name: b.name }))),
    profit_loss: section(pl, (d) => ({
      total_income: num(d.totals?.totalIncome),
      total_expense: Math.abs(num(d.totals?.totalExpense)),
      net_profit: num(d.totals?.netProfitLoss),
      groups: (d.data ?? []).flatMap((n) => (n.groups ?? []).map((g) => ({ nature: n.nature, name: g.name, amount: num(g.totalAmount) }))),
    })),
    trial_balance: { ...tbSection, suspense },
    vouchers: section(vouchers, (d) => ({
      total: num(d.total),
      rows: (d.result ?? []).map((v) => ({
        id: Number(v.id),
        number: (v.voucherNo as string) ?? null,
        date: istDate(v.voucherDate ?? v.invoiceDate),
        type: ((v.voucherTypeName ?? v.voucherType) as string) ?? null,
        account: (v.accountName as string) ?? null,
        description: (v.description as string) ?? null,
        // JournL signs a voucher by the party side (sales are negative); show the voucher value.
        amount: Math.abs(num((v.totalAmount ?? v.amount) as Num)),
      })),
    })),
  };
}
