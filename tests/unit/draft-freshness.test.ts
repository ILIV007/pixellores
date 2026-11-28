import { describe, expect, it } from 'vitest';
import {
  extractDatePhrases,
  gregorianToday,
  jalaliToday,
} from '../../src/domain/publishing/date-phrases';
import {
  extractClaimDatePhrases,
  FRESHNESS_MAX_AGE_MS,
  isDraftStale,
  readDraftClaimDatePhrases,
} from '../../src/domain/publishing/draft-freshness';

/**
 * The freshness gate (ADR-0079 §3.3) — the shared pure domain function:
 * 48h source age + the mechanical past-date rule over the draft's claim
 * date phrases (PR #42's month-word lists, reused — not the figure
 * derivation, which §3.8 deletes).
 */

// 2026-11-28 09:00 UTC — a Saturday; Jalali 7 Azar 1405.
const NOV_28_09_00_UTC = Date.UTC(2026, 10, 28, 9, 0, 0);
const HOUR = 60 * 60 * 1000;

describe('isDraftStale — the 48h source-age rule', () => {
  it('47h59m old is fresh; 48h01m old is stale (the boundary)', () => {
    const fresh = isDraftStale({
      sourcePublishedAtMs: NOV_28_09_00_UTC - (48 * HOUR - 60_000),
      claimDatePhrases: [],
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(fresh).toEqual({ stale: false, reason: 'fresh' });
    const stale = isDraftStale({
      sourcePublishedAtMs: NOV_28_09_00_UTC - (48 * HOUR + 60_000),
      claimDatePhrases: [],
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(stale).toEqual({ stale: true, reason: 'stale_source_age' });
  });

  it('exactly 48h old is fresh (the cutoff is exclusive)', () => {
    const result = isDraftStale({
      sourcePublishedAtMs: NOV_28_09_00_UTC - 48 * HOUR,
      claimDatePhrases: [],
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result.stale).toBe(false);
  });

  it('a future published_at (clock skew) is fresh, never stale', () => {
    const result = isDraftStale({
      sourcePublishedAtMs: NOV_28_09_00_UTC + HOUR,
      claimDatePhrases: [],
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result.stale).toBe(false);
  });

  it('an undated source item (null published_at) is stale — fail-closed', () => {
    const result = isDraftStale({
      sourcePublishedAtMs: null,
      claimDatePhrases: [],
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result).toEqual({ stale: true, reason: 'stale_source_age' });
  });
});

describe('isDraftStale — the past-date rule', () => {
  const freshSource = NOV_28_09_00_UTC - HOUR;

  it('"tomorrow, November 19" evaluated November 28 is stale', () => {
    const phrases = extractClaimDatePhrases([
      'The game launches tomorrow, November 19, with a new trailer.',
    ]);
    expect(phrases).toHaveLength(1);
    const result = isDraftStale({
      sourcePublishedAtMs: freshSource,
      claimDatePhrases: phrases,
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result).toEqual({ stale: true, reason: 'stale_past_date' });
  });

  it('a future-date claim is fresh', () => {
    const phrases = extractClaimDatePhrases(['The game launches December 12, with a new trailer.']);
    const result = isDraftStale({
      sourcePublishedAtMs: freshSource,
      claimDatePhrases: phrases,
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result.stale).toBe(false);
  });

  it('a date phrase for TODAY is fresh (today is not past)', () => {
    const phrases = extractClaimDatePhrases(['The event is today, November 28.']);
    const result = isDraftStale({
      sourcePublishedAtMs: freshSource,
      claimDatePhrases: phrases,
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result.stale).toBe(false);
  });

  it('a dateless claim is fresh (only the age rule applies)', () => {
    const phrases = extractClaimDatePhrases(['The studio announced a new trailer.']);
    expect(phrases).toHaveLength(0);
    const result = isDraftStale({
      sourcePublishedAtMs: freshSource,
      claimDatePhrases: phrases,
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result.stale).toBe(false);
  });

  it('a past Jalali date is stale; a future Jalali date is fresh', () => {
    const past = extractClaimDatePhrases(['بازی ۷ آذر ۱۴۰۴ منتشر می‌شود.']);
    const pastResult = isDraftStale({
      sourcePublishedAtMs: freshSource,
      claimDatePhrases: past,
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(pastResult).toEqual({ stale: true, reason: 'stale_past_date' });
    const future = extractClaimDatePhrases(['بازی ۲۰ آذر ۱۴۰۵ منتشر می‌شود.']);
    const futureResult = isDraftStale({
      sourcePublishedAtMs: freshSource,
      claimDatePhrases: future,
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(futureResult.stale).toBe(false);
  });

  it('a month+year-only phrase never fires (too coarse to call past)', () => {
    const phrases = extractClaimDatePhrases(['The game launches in November 2026.']);
    expect(phrases).toHaveLength(1);
    expect(phrases[0]?.day).toBeNull();
    const result = isDraftStale({
      sourcePublishedAtMs: freshSource,
      claimDatePhrases: phrases,
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result.stale).toBe(false);
  });

  it('a year-less past date resolves in the current year', () => {
    // "November 19" with no year, evaluated November 28 → this year's Nov 19 → past.
    const phrases = extractClaimDatePhrases(['Available since November 19.']);
    expect(phrases[0]?.year).toBeNull();
    const result = isDraftStale({
      sourcePublishedAtMs: freshSource,
      claimDatePhrases: phrases,
      nowMs: NOV_28_09_00_UTC,
      maxAgeMs: FRESHNESS_MAX_AGE_MS,
    });
    expect(result).toEqual({ stale: true, reason: 'stale_past_date' });
  });
});

describe('extractDatePhrases — the month-word extraction', () => {
  it('finds day+month+year in Persian order with Persian digits', () => {
    const phrases = extractDatePhrases('بازی ۲۱ ژانویه ۲۰۲۷ منتشر می‌شود.');
    expect(phrases).toHaveLength(1);
    expect(phrases[0]).toMatchObject({
      calendar: 'gregorian',
      year: 2027,
      month: 1,
      day: 21,
    });
  });

  it('finds month+day+year in English order', () => {
    const phrases = extractDatePhrases('Launching November 19, 2026.');
    expect(phrases).toHaveLength(1);
    expect(phrases[0]).toMatchObject({
      calendar: 'gregorian',
      year: 2026,
      month: 11,
      day: 19,
    });
  });

  it('does not confuse مه (May) with مهر (Jalali month 7)', () => {
    const may = extractDatePhrases('۲۱ مه ۲۰۲۶');
    expect(may[0]).toMatchObject({ calendar: 'gregorian', month: 5 });
    const mehr = extractDatePhrases('۷ مهر ۱۴۰۴');
    expect(mehr[0]).toMatchObject({ calendar: 'jalali', month: 7 });
  });

  it('dedupes the same date across claims', () => {
    const phrases = extractClaimDatePhrases([
      'Launching November 19.',
      'Launching November 19 again.',
    ]);
    expect(phrases).toHaveLength(1);
  });

  it('reads claim date phrases defensively from stored document JSON', () => {
    const documentJson = JSON.stringify({
      modelClaims: [{ text: 'The game launches November 19.' }, { text: 'No date here.' }],
    });
    const phrases = readDraftClaimDatePhrases(documentJson);
    expect(phrases).toHaveLength(1);
    expect(readDraftClaimDatePhrases('not json')).toEqual([]);
    expect(readDraftClaimDatePhrases('{"modelClaims": "nope"}')).toEqual([]);
  });
});

describe('calendar helpers — the Intl-backed today', () => {
  it('2026-11-28 is Gregorian 2026/11/28 and Jalali 1405/9/7', () => {
    expect(gregorianToday(NOV_28_09_00_UTC)).toEqual({ year: 2026, month: 11, day: 28 });
    expect(jalaliToday(NOV_28_09_00_UTC)).toEqual({ year: 1405, month: 9, day: 7 });
  });
});
