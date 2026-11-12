import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./payout.repository.js";
import type { RunResult } from "./payout.types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getPayouts(period: string) {
  const [items, summary] = await Promise.all([repo.listPayouts(period), repo.payoutSummary(period)]);
  return { items, summary };
}

/**
 * Builds the period's payout run from logged work hours × each accountant's hourly rate.
 * New accountants get a draft; existing drafts are refreshed with the latest hours and rate;
 * approved or paid payouts are never changed. Accountants who aren't verified are skipped
 * (no money goes out before an admin has checked them) and listed in the result.
 */
export async function generateRun(actor: AuthUser, period: string): Promise<RunResult> {
  return withTransaction(async (conn) => {
    const logged = await repo.loggedMinutesByAccountant(period, conn);
    const existing = new Map((await repo.existingPayouts(period, conn)).map((p) => [p.user_id, p]));
    let created = 0;
    let refreshed = 0;
    const skippedUnverified: string[] = [];
    for (const l of logged) {
      if (l.verification_status !== "verified") {
        skippedUnverified.push(l.full_name);
        continue;
      }
      const rate = l.hourly_rate ?? 0;
      const amount = round2((l.minutes / 60) * rate);
      const current = existing.get(l.user_id);
      if (!current) {
        await repo.insertPayout({ userId: l.user_id, period, minutes: l.minutes, rate, amount }, conn);
        created++;
      } else if (current.status === "draft") {
        await repo.refreshDraft(current.id, l.minutes, rate, amount, conn);
        refreshed++;
      }
    }
    const payable = Number(await repo.payableTotal(period, conn));
    await recordAudit(
      actor,
      {
        action: "Payout run generated",
        entityType: "AccountantPayout",
        entityId: period,
        details: `${period}: ${created} new, ${refreshed} refreshed, ₹${payable.toFixed(2)} payable.${skippedUnverified.length ? ` Skipped (not verified): ${skippedUnverified.join(", ")}.` : ""}`,
      },
      conn,
    );
    return { period, created, refreshed, payable, skipped_unverified: skippedUnverified };
  });
}

export async function approve(actor: AuthUser, id: number) {
  await withTransaction(async (conn) => {
    const p = await repo.findPayout(id, conn);
    if (!p) throw AppError.notFound("Payout");
    if (p.status !== "draft") throw AppError.conflict("Only draft payouts can be approved");
    if (p.verification_status !== "verified") throw AppError.conflict(`${p.full_name} isn't verified yet. Verify them in Accountants before approving the payout.`);
    await repo.approvePayout(id, actor.id, conn);
    await recordAudit(actor, { action: "Payout approved", entityType: "AccountantPayout", entityId: id, details: `${p.email} · ${p.period} · ₹${p.amount.toFixed(2)}` }, conn);
  });
}

export async function markPaid(actor: AuthUser, id: number, reference: string | null) {
  await withTransaction(async (conn) => {
    const p = await repo.findPayout(id, conn);
    if (!p) throw AppError.notFound("Payout");
    if (p.status !== "approved") throw AppError.conflict("Approve the payout before marking it paid");
    await repo.markPaid(id, reference, conn);
    await recordAudit(actor, { action: "Payout paid", entityType: "AccountantPayout", entityId: id, details: `${p.email} · ${p.period} · ₹${p.amount.toFixed(2)}` }, conn);
  });
}
