/**
 * The freshness gate (ADR-0079 §3.3) — ONE shared pure domain function,
 * two call sites (the bridge's gate path, the scheduler's send-time scan).
 *
 * A draft is stale when EITHER rule fires:
 *  1. SOURCE AGE: its source item's `published_at` is more than `maxAgeMs`
 *     before the check instant. An UNKNOWN published_at (null — the feed
 *     carried no date) is stale too: undated news cannot prove freshness,
 *     and the gate fails closed toward NOT publishing it.
 *  2. PAST DATE: any day-precision date phrase in the draft's claims
 *     resolves to a date before today (same calendar). "Tomorrow,
 *     November 19" on November 28 is stale — the event it announces
 *     already passed. A month+year-only phrase (no day) is too coarse to
 *     call past and never fires; a year-less phrase resolves in the
 *     current year of its own calendar.
 *
 * The disposition is TERMINAL, never a deferral: a stale draft is retired
 * (bridge) or dead-lettered (scheduler) — a deferral would re-evaluate
 * forever, the livelock family of #38/#41/#43.
 */

import {
  compareCalendarDays,
  extractDatePhrases,
  gregorianToday,
  jalaliToday,
  type ClaimDatePhrase,
} from './date-phrases';

/** The owner-confirmed freshness cutoff: gaming news older than 48h is not news. */
export const FRESHNESS_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export type DraftStaleReason = 'stale_source_age' | 'stale_past_date';

export type DraftFreshnessResult =
  | { readonly stale: false; readonly reason: 'fresh' }
  | { readonly stale: true; readonly reason: DraftStaleReason };

/**
 * The shared gate. `sourcePublishedAtMs` is the PRIMARY reference item's
 * `published_at` (the story's anchor source — the same item the bridge's
 * lane rule reads first); `claimDatePhrases` are the draft's extracted
 * date phrases (see `extractClaimDatePhrases`).
 */
export function isDraftStale(input: {
  readonly sourcePublishedAtMs: number | null;
  readonly claimDatePhrases: readonly ClaimDatePhrase[];
  readonly nowMs: number;
  readonly maxAgeMs: number;
}): DraftFreshnessResult {
  const { sourcePublishedAtMs, claimDatePhrases, nowMs, maxAgeMs } = input;
  // Rule 1 — source age (null = undated = cannot prove fresh).
  if (sourcePublishedAtMs === null || nowMs - sourcePublishedAtMs > maxAgeMs) {
    return { stale: true, reason: 'stale_source_age' };
  }
  // Rule 2 — past date in the claims (day-precision phrases only).
  const gregorian = gregorianToday(nowMs);
  const jalali = jalaliToday(nowMs);
  for (const phrase of claimDatePhrases) {
    if (phrase.day === null) continue;
    const today = phrase.calendar === 'jalali' ? jalali : gregorian;
    const resolved = {
      year: phrase.year ?? today.year,
      month: phrase.month,
      day: phrase.day,
    };
    if (compareCalendarDays(resolved, today) < 0) {
      return { stale: true, reason: 'stale_past_date' };
    }
  }
  return { stale: false, reason: 'fresh' };
}

/** Extract the draft's date phrases from its claim texts (deduped). */
export function extractClaimDatePhrases(claimTexts: readonly string[]): readonly ClaimDatePhrase[] {
  const seen = new Set<string>();
  const phrases: ClaimDatePhrase[] = [];
  for (const text of claimTexts) {
    for (const phrase of extractDatePhrases(text)) {
      const key = `${phrase.calendar}|${phrase.year ?? ''}|${phrase.month}|${phrase.day ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push(phrase);
    }
  }
  return phrases;
}

/**
 * Defensively read a stored draft document's claim date phrases. ANY
 * structural problem yields no phrases (the age rule still applies; the
 * auto gate refuses an unparseable document anyway) — the freshness
 * check never crashes a scan.
 */
export function readDraftClaimDatePhrases(documentJson: string): readonly ClaimDatePhrase[] {
  try {
    const parsed: unknown = JSON.parse(documentJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    const claims = (parsed as Record<string, unknown>)['modelClaims'];
    if (!Array.isArray(claims)) return [];
    const texts: string[] = [];
    for (const claim of claims) {
      if (claim !== null && typeof claim === 'object' && !Array.isArray(claim)) {
        const text = (claim as Record<string, unknown>)['text'];
        if (typeof text === 'string') texts.push(text);
      }
    }
    return extractClaimDatePhrases(texts);
  } catch {
    return [];
  }
}
