/**
 * Work durations as people write them: "1w 2d 4h 30m". A working day is 8 hours and a week 5 days, the usual
 * project-tracking convention. Stored as whole minutes.
 */
const UNIT_MINUTES = { w: 5 * 8 * 60, d: 8 * 60, h: 60, m: 1 } as const;

/** 750 → "1d 4h 30m"; 0 or null → null. */
export function formatMinutes(total: number | null | undefined): string | null {
  if (!total || total <= 0) return null;
  let rest = Math.round(total);
  const parts: string[] = [];
  for (const [unit, size] of Object.entries(UNIT_MINUTES)) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${unit}`);
      rest -= n * size;
    }
  }
  return parts.join(" ");
}
