import { z } from "zod";
import type { JournalLine } from "./correction.types.js";

/** Largest amount accepted: ₹1,00,00,00,00,000 (one lakh crore), well inside safe integers in paise. */
const MAX_PAISE = 10_000_000_000_000;

/** Rupees (string or number, ≤ 2 decimals, no sign, no exponent) → integer paise, exactly (no float arithmetic). */
export function rupeesToPaise(v: string | number): number | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(paise) && paise <= MAX_PAISE ? paise : null;
}

/** Integer paise → "2,64,141.50" (Indian grouping), exactly. */
export function formatRupees(paise: number): string {
  const abs = Math.abs(paise);
  const whole = new Intl.NumberFormat("en-IN").format(BigInt(Math.floor(abs / 100)));
  return `${paise < 0 ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

const amountPaise = (opts: { positive: boolean }) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    if (typeof v === "number" && v < 0) {
      ctx.addIssue({ code: "custom", message: "Amount can't be negative" });
      return z.NEVER;
    }
    if (typeof v === "string" && v.trim().startsWith("-")) {
      ctx.addIssue({ code: "custom", message: "Amount can't be negative" });
      return z.NEVER;
    }
    const p = rupeesToPaise(v);
    if (p === null) {
      ctx.addIssue({ code: "custom", message: "Enter an amount in rupees with at most 2 decimals" });
      return z.NEVER;
    }
    if (opts.positive && p <= 0) {
      ctx.addIssue({ code: "custom", message: "Amount must be more than zero" });
      return z.NEVER;
    }
    return p;
  });

/** A JournL ledger id: a positive integer or a string of digits (no coercion of booleans, hex or exponents). */
const ledgerId = z
  .union([z.number(), z.string().regex(/^\d+$/)], { message: "Choose a ledger" })
  .transform((v) => Number(v))
  .pipe(z.number().int("Choose a ledger").positive("Choose a ledger").max(Number.MAX_SAFE_INTEGER, "Choose a ledger"));
const side = z.enum(["dr", "cr"], { message: "Choose Dr or Cr" });
const reason = (max: number) => z.string({ message: "A reason is required" }).trim().min(1, "A reason is required").max(max, `Keep the reason under ${max} characters`);

/** Problems with a journal's lines (exact, in paise). Empty when the lines are valid. */
export function journalLineProblems(lines: Pick<JournalLine, "ledger_id" | "side" | "amount_paise">[]): string[] {
  const problems: string[] = [];
  const dr = lines.filter((l) => l.side === "dr");
  const cr = lines.filter((l) => l.side === "cr");
  if (dr.length === 0) problems.push("Add at least one debit line");
  if (cr.length === 0) problems.push("Add at least one credit line");
  if (lines.some((l) => !Number.isSafeInteger(l.amount_paise) || l.amount_paise <= 0)) problems.push("Every amount must be more than zero");
  const crIds = new Set(cr.map((l) => l.ledger_id));
  if (dr.some((l) => crIds.has(l.ledger_id))) problems.push("A ledger can't be on both the debit and the credit side");
  const sumDr = dr.reduce((s, l) => s + l.amount_paise, 0);
  const sumCr = cr.reduce((s, l) => s + l.amount_paise, 0);
  if (dr.length && cr.length && sumDr !== sumCr) problems.push(`Debits ₹${formatRupees(sumDr)} and credits ₹${formatRupees(sumCr)} must be equal`);
  return problems;
}

export const journalLineSchema = z
  .object({
    ledger_id: ledgerId,
    ledger_name: z.string().trim().max(200).optional(),
    side,
    amount: amountPaise({ positive: true }),
  })
  .transform((l): JournalLine => ({ ledger_id: l.ledger_id, ledger_name: l.ledger_name ?? "", side: l.side, amount_paise: l.amount }));

export const journalCorrectionSchema = z
  .object({
    voucher_date: z.iso.date("Use a valid date"),
    lines: z.array(journalLineSchema, { message: "Add the journal lines" }).min(2, "Add at least one debit and one credit line").max(100, "Use at most 100 lines"),
    reason: reason(1000),
  })
  .superRefine((j, ctx) => {
    for (const message of journalLineProblems(j.lines)) ctx.addIssue({ code: "custom", path: ["lines"], message });
  });
export type JournalCorrectionInput = z.infer<typeof journalCorrectionSchema>;

export const openingCorrectionSchema = z
  .object({
    ledger_id: ledgerId,
    ledger_name: z.string().trim().max(200).optional(),
    amount: amountPaise({ positive: false }),
    side,
    reason: reason(1000),
  })
  .transform((o) => ({ ledger_id: o.ledger_id, ledger_name: o.ledger_name ?? "", amount_paise: o.amount, side: o.side, reason: o.reason }));
export type OpeningCorrectionInput = z.infer<typeof openingCorrectionSchema>;

/** Unresolved-difference adjustment: amount and side are computed, never typed. Reason leaves room for the fixed prefix. */
export const suspenseCorrectionSchema = z.object({
  ledger_id: ledgerId,
  reason: reason(900),
});
export type SuspenseCorrectionInput = z.infer<typeof suspenseCorrectionSchema>;
