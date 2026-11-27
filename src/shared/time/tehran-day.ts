/**
 * Budget-day helper (Phase 4 — ADR-0038 §6).
 *
 * The budget day is the CALENDAR DATE in Asia/Tehran. Iran has had NO
 * daylight saving time since 2022, so the civil offset is the FIXED
 * UTC+03:30 — computed arithmetically (no Intl dependency, no DST table,
 * unit-tested at day boundaries including Tehran midnight).
 */

/** Tehran fixed offset in minutes (UTC+03:30, no DST since 2022). */
export const TEHRAN_OFFSET_MINUTES = 3 * 60 + 30;

/** 'YYYY-MM-DD' for an epoch-ms timestamp in Asia/Tehran. */
export function tehranBudgetDay(nowMs: number): string {
  const shifted = new Date(nowMs + TEHRAN_OFFSET_MINUTES * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Milliseconds until the NEXT Tehran midnight (ADR-0070 §5): the
 * retry-after for a quota_denied rewrite — the budget resets at the
 * Tehran-day boundary, so no same-day retry can succeed. Always in
 * (0, 24h]: at exactly midnight the next boundary is a full day away.
 */
export function msUntilNextTehranMidnight(nowMs: number): number {
  const dayMs = 24 * 60 * 60 * 1000;
  const shiftedMs = nowMs + TEHRAN_OFFSET_MINUTES * 60 * 1000;
  const intoDayMs = ((shiftedMs % dayMs) + dayMs) % dayMs;
  const remaining = dayMs - intoDayMs;
  return remaining > 0 ? remaining : dayMs;
}
