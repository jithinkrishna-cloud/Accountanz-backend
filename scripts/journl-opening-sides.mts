/**
 * One-off JournL dev check, run by hand: does a non-zero opening balance, on the Dr side and then the Cr side, save and
 * post exactly as Task 8 will send it? Uses ONLY the throwaway ledger 63 "ACZ round-trip test (delete me)".
 *
 * Writes it makes (and nothing else), each one PUT /companyLedgerMaster/63, sent once, never retried:
 *   SAVE 1: opening ₹500 Dr   (transactionType "receivable")
 *   SAVE 2: opening ₹500 Cr   (transactionType "payable")
 *   SAVE 3: reset to ₹0       (transactionType "payable", as the ledger started)
 * After each save: GET the ledger (printed raw), compare every field against what was expected, and read the ledger's
 * closing balance from the trial balance (JournL convention: Dr negative, Cr positive).
 * Stops at the first surprise and leaves the ledger as it is (reset it by hand). A save that times out or redirects
 * prints UNKNOWN and stops: nothing is re-sent.
 *
 * Run from backend/:  npx tsx scripts/journl-opening-sides.mts
 * Refuses to run unless JOURNL_API_URL's host is testapi.bizpolebooks.com. Never prints the token.
 */
import { env } from "../src/config/env.ts";
import { openJournlSession } from "../src/modules/integrations/journl-data.service.ts";
import { journlGet } from "../src/modules/integrations/journl.gateway.ts";

const CONNECTION_ID = 1;
const ALLOWED_HOST = "testapi.bizpolebooks.com";
const LEDGER_ID = 63;
const NAME = "ACZ round-trip test (delete me)";
const BRANCH_ID = 1;
const TIMEOUT_MS = 20_000;
const TB_RANGE = { startDate: "2026-04-01", endDate: "2026-11-18", companyStartDate: "2026-03-29" };
const BOOKKEEPING = new Set(["updatedAt", "updatedBy"]);

type Ledger = Record<string, unknown> & { id: number; openingBillEntry?: unknown[] };
interface Step {
  label: string;
  openingBalance: number;
  transactionType: "receivable" | "payable";
  /** Expected trial-balance closing for the ledger: Dr negative, Cr positive, 0 = no balance. */
  expectedClosing: number;
}
const STEPS: Step[] = [
  { label: "SAVE 1: opening ₹500 Dr", openingBalance: 500, transactionType: "receivable", expectedClosing: -500 },
  { label: "SAVE 2: opening ₹500 Cr", openingBalance: 500, transactionType: "payable", expectedClosing: 500 },
  { label: "SAVE 3: reset to ₹0", openingBalance: 0, transactionType: "payable", expectedClosing: 0 },
];

const line = (s = "") => console.log(s);
const stop = (msg: string, code = 1): never => {
  line(`STOP: ${msg}`);
  line(`Ledger ${LEDGER_ID} is left as it is now; reset it by hand if needed.`);
  process.exit(code);
};

if (!env.JOURNL_API_URL) stop("JOURNL_API_URL is not set.");
const base = new URL(env.JOURNL_API_URL!);
if (base.host !== ALLOWED_HOST) stop(`JOURNL_API_URL host is ${base.host}, not ${ALLOWED_HOST}. Refusing to write.`);

const { token, companyId } = await openJournlSession(CONNECTION_ID);
const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
const userId = claims.id ?? claims.userId;
if (userId == null) stop("Could not read the JournL user id from the session.");

async function put(body: unknown) {
  const url = new URL(`companyLedgerMaster/${LEDGER_ID}`, base.href.endsWith("/") ? base.href : `${base.href}/`);
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      stop(`UNKNOWN: PUT answered with a redirect (HTTP ${res.status}); not followed, not re-sent. Check the ledger in JournL.`, 2);
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
    return stop(`UNKNOWN: PUT did not complete (${(err as Error).name}); not re-sent. Check the ledger in JournL.`, 2);
  }
}

async function readLedger(): Promise<Ledger> {
  const r = await journlGet<Ledger>(token, `companyLedgerMaster/id/${LEDGER_ID}`);
  if (r.kind !== "ok") stop(`GET ledger failed: ${r.kind === "failed" ? r.reason : "session expired"}`);
  return (r as { kind: "ok"; data: Ledger }).data;
}

interface TbNode { ledgerId?: number; id?: number; ledgerName?: string; name?: string; closingBalance?: unknown; children?: TbNode[] }
async function closingInTrialBalance(): Promise<{ found: boolean; closing: number }> {
  const r = await journlGet<TbNode[]>(token, "defaultAccountingGroups/trial-balance", TB_RANGE);
  if (r.kind !== "ok") stop(`GET trial balance failed: ${r.kind === "failed" ? r.reason : "session expired"}`);
  const walk = (nodes: TbNode[]): TbNode | null => {
    for (const n of nodes) {
      if (Number(n.ledgerId) === LEDGER_ID || n.ledgerName === NAME) return n;
      const hit = walk(n.children ?? []);
      if (hit) return hit;
    }
    return null;
  };
  const node = walk((r as { kind: "ok"; data: TbNode[] }).data ?? []);
  return { found: !!node, closing: node ? Number(node.closingBalance ?? 0) : 0 };
}

function compare(expected: Ledger, actual: Ledger): string[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const surprises: string[] = [];
  for (const k of keys) {
    const a = JSON.stringify(expected[k]);
    const b = JSON.stringify(actual[k]);
    const numericEqual = typeof expected[k] === "number" && Number(actual[k]) === expected[k];
    const same = a === b || numericEqual;
    const mark = same ? "same    " : BOOKKEEPING.has(k) ? "changed*" : "CHANGED ";
    line(`  ${mark} ${k}: expected ${a}${same && a === b ? "" : `, got ${b}`}`);
    if (!same && !BOOKKEEPING.has(k)) surprises.push(k);
  }
  return surprises;
}

line(`JournL dev opening-balance side check · company ${companyId} · ledger ${LEDGER_ID} · host ${base.host}`);

// Pre-checks: only ever touch the throwaway ledger, and only from its known starting state.
let current = await readLedger();
if (current.name !== NAME) stop(`Ledger ${LEDGER_ID} is "${String(current.name)}", not the throwaway test ledger.`);
if (Number(current.enableBillWise)) stop("Ledger is bill-wise; refusing.");
if ((current.openingBillEntry ?? []).length) stop("Ledger has opening bills; refusing.");
if (Number(current.openingBalance) !== 0 || current.transactionType !== "payable") {
  stop(`Ledger does not start at ₹0 payable (it is ${String(current.openingBalance)} ${String(current.transactionType)}).`);
}
line();
line("START (raw GET data):");
line(JSON.stringify(current, null, 2));
const tb0 = await closingInTrialBalance();
line(`Trial balance closing for ledger ${LEDGER_ID} at start: ${tb0.found ? tb0.closing : "not listed (no balance)"}`);

for (const step of STEPS) {
  line();
  line("────────────────────────────────────────");
  const body = {
    ...current,
    openingBalance: step.openingBalance,
    transactionType: step.transactionType,
    openingBillEntry: current.openingBillEntry ?? [],
    branchId: BRANCH_ID,
    updatedBy: userId,
  };
  const res = await put(body);
  line(`${step.label} → PUT /companyLedgerMaster/${LEDGER_ID} → HTTP ${res.status}`);
  line(`PUT response: ${JSON.stringify(res.json ?? res.text)}`);
  if (res.status < 200 || res.status >= 300 || (res.json as { success?: boolean } | null)?.success !== true) {
    stop(`${step.label} was not accepted by JournL.`);
  }

  const after = await readLedger();
  line();
  line(`AFTER ${step.label} (raw GET data):`);
  line(JSON.stringify(after, null, 2));
  line(`transactionType actually stored: ${JSON.stringify(after.transactionType)} · openingBalance stored: ${JSON.stringify(after.openingBalance)}`);

  const expected: Ledger = { ...current, openingBalance: step.openingBalance, transactionType: step.transactionType };
  line();
  line("FIELD COMPARISON (expected = previous state with only openingBalance and transactionType changed):");
  const surprises = compare(expected, after);

  const tb = await closingInTrialBalance();
  const tbOk = step.expectedClosing === 0 ? !tb.found || tb.closing === 0 : tb.found && tb.closing === step.expectedClosing;
  line();
  line(
    `Trial balance closing for ledger ${LEDGER_ID}: ${tb.found ? tb.closing : "not listed (no balance)"} · expected ${step.expectedClosing} (Dr negative, Cr positive) → ${tbOk ? "as expected" : "UNEXPECTED"}`,
  );

  if (surprises.length || !tbOk) {
    stop(`${step.label}: ${[...surprises.map((k) => `field ${k}`), ...(tbOk ? [] : ["trial balance closing"])].join(", ")} not as expected.`);
  }
  line(`${step.label}: as expected.`);
  current = after;
}

line();
line("RESULT: PASS — ₹500 Dr, ₹500 Cr and reset to ₹0 all saved and posted exactly as expected; ledger back at ₹0 payable.");
line(`Test ledger id ${LEDGER_ID} left in JournL company ${companyId}; delete it by hand.`);
process.exit(0);
