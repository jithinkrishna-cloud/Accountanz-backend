import { logger } from "../../utils/logger.js";
import { listPostedSuspenseAdjustments } from "./correction.repository.js";
import { correctionRef } from "./correction.types.js";
import { ledgerClosingOf, type TbNode } from "./journl-books.js";

export interface SuspenseLedgerBalance {
  ledger_id: number;
  ledger: string;
  unresolved_paise: number;
  side: "dr" | "cr";
}

export interface SuspenseStatus {
  /** |signed sum| of the non-zero Suspense ledgers (0 when they net out; the field is still non-null then). */
  unresolved_paise: number;
  side: "dr" | "cr";
  /** Names of the non-zero ledgers joined with ", ". */
  ledger: string;
  /** Refs of posted adjustments whose ledger is in `ledgers`. */
  corrections: { ref: string; approved_by: string }[];
  ledgers: SuspenseLedgerBalance[];
}

/**
 * `trial_balance.suspense` in the overview: a SuspenseStatus, `null` (no posted adjustment, or Suspense is clear),
 * or `{ error }` when the lookup failed. The error shape is deliberate: null would present the trial balance as
 * resolved, so the UI must render `{ error }` as a warning ("can't confirm whether Suspense holds an unresolved amount").
 */
export type SuspenseField = SuspenseStatus | { error: string } | null;
export const SUSPENSE_CHECK_FAILED = "Couldn't check Suspense adjustments";

/**
 * Every distinct Suspense ledger targeted by a posted unresolved-difference adjustment is checked against the raw
 * JournL trial-balance tree (Dr negative, Cr positive). A ledger absent from the tree has no balance (JournL omits
 * zero rows), so counts as 0. Non-null whenever any ledger is non-zero, even if the signed sum nets to 0.
 */
export async function suspenseStatus(clientId: number, trialBalanceGroups: TbNode[]): Promise<SuspenseStatus | null> {
  const posted = await listPostedSuspenseAdjustments(clientId);
  const byLedger = new Map<number, { name: string; closing: number }>();
  for (const p of posted) {
    if (byLedger.has(p.payload.ledger_id)) continue;
    byLedger.set(p.payload.ledger_id, { name: p.payload.ledger_name, closing: ledgerClosingOf(trialBalanceGroups, p.payload.ledger_id, p.payload.ledger_name) });
  }
  const live = [...byLedger].filter(([, v]) => v.closing !== 0);
  if (!live.length) return null;
  const sum = live.reduce((t, [, v]) => t + v.closing, 0);
  const liveIds = new Set(live.map(([id]) => id));
  return {
    unresolved_paise: Math.abs(sum),
    side: sum > 0 ? "cr" : "dr",
    ledger: live.map(([, v]) => v.name).join(", "),
    corrections: posted.filter((p) => liveIds.has(p.payload.ledger_id)).map((p) => ({ ref: correctionRef(p.id), approved_by: p.approved_by_name })),
    ledgers: live.map(([id, v]) => ({ ledger_id: id, ledger: v.name, unresolved_paise: Math.abs(v.closing), side: v.closing < 0 ? "dr" : "cr" })),
  };
}

/** suspenseStatus that never throws: a failure becomes `{ error }` (logged without bodies). */
export async function suspenseField(clientId: number, groups: TbNode[]): Promise<SuspenseField> {
  try {
    return await suspenseStatus(clientId, groups);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Suspense adjustment lookup failed");
    return { error: SUSPENSE_CHECK_FAILED };
  }
}
