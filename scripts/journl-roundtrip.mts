/**
 * One-off JournL dev check, run by hand: does PUT /companyLedgerMaster/:id with the ledger's own data leave it unchanged?
 *
 * Writes it makes (and nothing else):
 *   1. POST /companyLedgerMaster  — creates "ACZ round-trip test (delete me)" ONLY if no ledger with that exact name exists.
 *   2. PUT  /companyLedgerMaster/:id — once, with the ledger exactly as read. No retry; a timeout prints UNKNOWN and stops.
 * The test ledger is left in place; delete it in JournL by hand (its id is printed).
 *
 * Run from backend/:  npx tsx scripts/journl-roundtrip.mts
 * Uses Accountanz's stored owner session for integration connection 1 (ABC Traders, JournL company 218).
 * Never prints the token. Refuses to run unless JOURNL_API_URL's host is testapi.bizpolebooks.com.
 */
import { env } from "../src/config/env.ts";
import { openJournlSession } from "../src/modules/integrations/journl-data.service.ts";
import { journlGet } from "../src/modules/integrations/journl.gateway.ts";

const CONNECTION_ID = 1;
const ALLOWED_HOST = "testapi.bizpolebooks.com";
const NAME = "ACZ round-trip test (delete me)";
const CODE = "ACZRT01";
const INDIRECT_EXPENSES = 15; // seeded JournL group id (constants/accountingIds.js)
const BRANCH_ID = 1;
const TIMEOUT_MS = 20_000;
/** Fields the server is expected to change on any save; reported separately, never hidden. */
const BOOKKEEPING = new Set(["updatedAt", "updatedBy"]);

type Ledger = Record<string, unknown> & { id: number; openingBillEntry?: unknown[] };

const line = (s = "") => console.log(s);
const fail = (msg: string): never => {
  line(`STOP: ${msg}`);
  process.exit(1);
};

if (!env.JOURNL_API_URL) fail("JOURNL_API_URL is not set.");
const base = new URL(env.JOURNL_API_URL!);
if (base.host !== ALLOWED_HOST) fail(`JOURNL_API_URL host is ${base.host}, not ${ALLOWED_HOST}. Refusing to write.`);

const { token, companyId } = await openJournlSession(CONNECTION_ID);
const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
const userId = claims.id ?? claims.userId;
if (userId == null) fail("Could not read the JournL user id from the session (needed as createdBy/updatedBy).");

async function write(method: "POST" | "PUT", path: string, body: unknown) {
  const url = new URL(path.replace(/^\//, ""), base.href.endsWith("/") ? base.href : `${base.href}/`);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual", // never follow: a redirect could turn the write into a GET or resend it elsewhere
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      line(`UNKNOWN: ${method} ${url.pathname} answered with a redirect (HTTP ${res.status}). Not following. Check JournL by hand.`);
      process.exit(2);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text: json ? null : text.slice(0, 300) };
  } catch (err) {
    line(`UNKNOWN: ${method} ${url.pathname} did not complete (${(err as Error).name}). Not retrying. Check JournL by hand.`);
    process.exit(2);
  }
}

async function readLedger(id: number): Promise<Ledger> {
  const r = await journlGet<Ledger>(token, `companyLedgerMaster/id/${id}`);
  if (r.kind !== "ok") fail(`GET ledger ${id} failed: ${r.kind === "failed" ? r.reason : "session expired"}`);
  return (r as { kind: "ok"; data: Ledger }).data;
}

line(`JournL dev round-trip check · company ${companyId} · host ${base.host}`);

// 1. Find or create the throwaway ledger.
const found = await journlGet<Ledger[] | { data?: Ledger[] }>(token, "companyLedgerMaster/search", { searchText: NAME });
const rows = found.kind === "ok" ? (Array.isArray(found.data) ? found.data : (found.data?.data ?? [])) : [];
const same = rows.filter((l) => l.name === NAME);
if (same.length > 1) fail(`${same.length} ledgers named "${NAME}" exist; delete the extras in JournL first.`);

let ledgerId: number;
if (same.length === 1) {
  ledgerId = Number(same[0]!.id);
  line(`Reusing existing ledger id ${ledgerId} (no creation write).`);
} else {
  const created = await write("POST", "/companyLedgerMaster", {
    code: CODE,
    name: NAME,
    groupId: INDIRECT_EXPENSES,
    primaryGroupId: INDIRECT_EXPENSES,
    openingBalance: 0,
    transactionType: "payable",
    enableBillWise: 0,
    companyId,
    branchId: BRANCH_ID,
    createdBy: userId,
  });
  const id = (created.json as { data?: { id?: number } } | null)?.data?.id;
  if (created.status !== 201 || !id) fail(`Create failed: HTTP ${created.status} ${JSON.stringify(created.json ?? created.text)}`);
  ledgerId = Number(id);
  line(`WRITE 1: created ledger id ${ledgerId} ("${NAME}", Indirect Expenses, opening 0, not bill-wise).`);
}

// 2. Read, check it is safe to use.
const before = await readLedger(ledgerId);
if (Number(before.groupId) !== INDIRECT_EXPENSES) fail(`Ledger ${ledgerId} is in group ${before.groupId}, not Indirect Expenses.`);
if (Number(before.enableBillWise)) fail(`Ledger ${ledgerId} is bill-wise; refusing.`);
if ((before.openingBillEntry ?? []).length) fail(`Ledger ${ledgerId} has opening bills; refusing.`);

line();
line("BEFORE (raw GET data):");
line(JSON.stringify(before, null, 2));

// 3. PUT it back unchanged, once.
const put = await write("PUT", `/companyLedgerMaster/${ledgerId}`, {
  ...before,
  openingBillEntry: before.openingBillEntry ?? [],
  branchId: BRANCH_ID,
  updatedBy: userId,
});
line();
line(`WRITE 2: PUT /companyLedgerMaster/${ledgerId} → HTTP ${put.status}`);
line(`PUT response: ${JSON.stringify(put.json ?? put.text)}`);
if (put.status < 200 || put.status >= 300) fail("PUT was rejected; nothing to compare. Report this output.");

// 4. Read again and compare every field.
const after = await readLedger(ledgerId);
line();
line("AFTER (raw GET data):");
line(JSON.stringify(after, null, 2));

const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
const changed: string[] = [];
const expected: string[] = [];
line();
line("FIELD COMPARISON:");
for (const k of keys) {
  const a = JSON.stringify(before[k]);
  const b = JSON.stringify(after[k]);
  const same = a === b;
  line(`  ${same ? "same   " : BOOKKEEPING.has(k) ? "changed*" : "CHANGED"}  ${k}: ${a}${same ? "" : ` → ${b}`}`);
  if (!same) (BOOKKEEPING.has(k) ? expected : changed).push(k);
}
line();
if (expected.length) line(`* bookkeeping fields that changed (expected on any save): ${expected.join(", ")}`);
line(
  changed.length
    ? `RESULT: FAIL — PUT unchanged → fields changed: ${changed.join(", ")}`
    : `RESULT: PASS — PUT unchanged → all ${keys.length - expected.length} data fields identical`,
);
line(`Test ledger id ${ledgerId} left in JournL company ${companyId}; delete it by hand.`);
process.exit(0);
