/**
 * Claim date phrases — the month-word lists + the mechanical date-phrase
 * extractor (ADR-0079 §3.3b).
 *
 * The month words are PR #42's date-cluster lists (ADR-0077), moved here
 * from the figures-derivation merger: Gregorian months in Persian
 * transliteration, Jalali months, and English month names. The lists are
 * the ONLY thing reused — the figure derivation they repaired is deleted
 * (§3.8i, ADR-0080), and this module never derives figures.
 *
 * A date phrase is a day-precision span (`21 ژانویه 2027`, `November 19`,
 * `۷ آذر ۱۴۰۴`) or a month+year span (`November 2026`, day null). The
 * freshness gate only treats DAY-precision phrases as past-date evidence:
 * a month-only phrase refers to the whole month, never to a past date.
 */

export type DatePhraseCalendar = 'gregorian' | 'jalali';

/** One extracted date phrase (day null = month+year only, too coarse). */
export interface ClaimDatePhrase {
  readonly calendar: DatePhraseCalendar;
  readonly year: number | null;
  readonly month: number;
  readonly day: number | null;
  readonly text: string;
}

/**
 * Month word → (calendar, month number). Gregorian transliteration first,
 * then Jalali, then English in both cases (the merger matched words
 * case-insensitively by listing both; the map keeps that exact coverage).
 */
export const MONTH_WORDS: ReadonlyMap<string, { calendar: DatePhraseCalendar; month: number }> =
  new Map([
    // Gregorian, Persian transliteration.
    ['ژانویه', { calendar: 'gregorian', month: 1 }],
    ['فوریه', { calendar: 'gregorian', month: 2 }],
    ['مارس', { calendar: 'gregorian', month: 3 }],
    ['آوریل', { calendar: 'gregorian', month: 4 }],
    ['مه', { calendar: 'gregorian', month: 5 }],
    ['ژوئن', { calendar: 'gregorian', month: 6 }],
    ['ژوئیه', { calendar: 'gregorian', month: 7 }],
    ['اوت', { calendar: 'gregorian', month: 8 }],
    ['سپتامبر', { calendar: 'gregorian', month: 9 }],
    ['اکتبر', { calendar: 'gregorian', month: 10 }],
    ['نوامبر', { calendar: 'gregorian', month: 11 }],
    ['دسامبر', { calendar: 'gregorian', month: 12 }],
    // Jalali.
    ['فروردین', { calendar: 'jalali', month: 1 }],
    ['اردیبهشت', { calendar: 'jalali', month: 2 }],
    ['خرداد', { calendar: 'jalali', month: 3 }],
    ['تیر', { calendar: 'jalali', month: 4 }],
    ['مرداد', { calendar: 'jalali', month: 5 }],
    ['شهریور', { calendar: 'jalali', month: 6 }],
    ['مهر', { calendar: 'jalali', month: 7 }],
    ['آبان', { calendar: 'jalali', month: 8 }],
    ['آذر', { calendar: 'jalali', month: 9 }],
    ['دی', { calendar: 'jalali', month: 10 }],
    ['بهمن', { calendar: 'jalali', month: 11 }],
    ['اسفند', { calendar: 'jalali', month: 12 }],
    // English.
    ['January', { calendar: 'gregorian', month: 1 }],
    ['February', { calendar: 'gregorian', month: 2 }],
    ['March', { calendar: 'gregorian', month: 3 }],
    ['April', { calendar: 'gregorian', month: 4 }],
    ['May', { calendar: 'gregorian', month: 5 }],
    ['June', { calendar: 'gregorian', month: 6 }],
    ['July', { calendar: 'gregorian', month: 7 }],
    ['August', { calendar: 'gregorian', month: 8 }],
    ['September', { calendar: 'gregorian', month: 9 }],
    ['October', { calendar: 'gregorian', month: 10 }],
    ['November', { calendar: 'gregorian', month: 11 }],
    ['December', { calendar: 'gregorian', month: 12 }],
    ['january', { calendar: 'gregorian', month: 1 }],
    ['february', { calendar: 'gregorian', month: 2 }],
    ['march', { calendar: 'gregorian', month: 3 }],
    ['april', { calendar: 'gregorian', month: 4 }],
    ['may', { calendar: 'gregorian', month: 5 }],
    ['june', { calendar: 'gregorian', month: 6 }],
    ['july', { calendar: 'gregorian', month: 7 }],
    ['august', { calendar: 'gregorian', month: 8 }],
    ['september', { calendar: 'gregorian', month: 9 }],
    ['october', { calendar: 'gregorian', month: 10 }],
    ['november', { calendar: 'gregorian', month: 11 }],
    ['december', { calendar: 'gregorian', month: 12 }],
  ]);

/** Persian/Arabic-Indic digits → Latin (the fact-guard's folded lens). */
export function foldDigitsToLatinText(text: string): string {
  return text.replace(/[۰-۹٠-٩]/g, (digit) => {
    const code = digit.charCodeAt(0);
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
    return String(code - 0x0660);
  });
}

const DAY_PATTERN = '([0-9]{1,2})';
const YEAR_PATTERN = '([0-9]{4})';

/**
 * Extract the date phrases in one text. Three shapes, in document order:
 * day + month word + optional year (`21 ژانویه 2027`, `۷ آذر ۱۴۰۴`),
 * month word + day + optional year (`November 19`, `November 19, 2026`),
 * month word + year (`November 2026` — day null). A day outside 1–31 or
 * a year outside 1000–2999 is not a phrase (never a guessed date).
 * Overlapping matches are skipped (the earliest start wins).
 */
export function extractDatePhrases(text: string): readonly ClaimDatePhrase[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const folded = foldDigitsToLatinText(text);
  const phrases: { phrase: ClaimDatePhrase; start: number }[] = [];
  const taken: { start: number; end: number }[] = [];
  const overlaps = (start: number, end: number): boolean =>
    taken.some((span) => start < span.end && end > span.start);
  const push = (phrase: ClaimDatePhrase, start: number, end: number): void => {
    if (overlaps(start, end)) return;
    taken.push({ start, end });
    phrases.push({ phrase, start });
  };
  // The month-word alternation, longest first so `ژوئیه` wins over `ژوئن`
  // on a shared prefix (and `September` over `Sep` — no abbreviations
  // are listed, but the order keeps the match deterministic).
  const monthWords = [...MONTH_WORDS.keys()].sort((a, b) => b.length - a.length);
  const monthPattern = monthWords
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const dayMonthYear = new RegExp(
    `${DAY_PATTERN}\\s+(${monthPattern})(?:\\s+${YEAR_PATTERN})?`,
    'g',
  );
  const monthDayYear = new RegExp(
    // The (?![0-9]) after the day keeps a 4-digit year from parsing as
    // a day: `November 2026` is month+year, never "November 20".
    `(${monthPattern})\\s+${DAY_PATTERN}(?![0-9])(?:\\s*,\\s*${YEAR_PATTERN})?`,
    'g',
  );
  const monthYear = new RegExp(`(${monthPattern})\\s+${YEAR_PATTERN}`, 'g');
  for (const match of folded.matchAll(dayMonthYear)) {
    const monthWord = match[2]!;
    const resolved = MONTH_WORDS.get(monthWord);
    if (resolved === undefined) continue;
    const day = Number(match[1]);
    if (day < 1 || day > 31) continue;
    const year = match[3] !== undefined ? Number(match[3]) : null;
    if (year !== null && (year < 1000 || year > 2999)) continue;
    push(
      { calendar: resolved.calendar, year, month: resolved.month, day, text: match[0] },
      match.index,
      match.index + match[0].length,
    );
  }
  for (const match of folded.matchAll(monthDayYear)) {
    const monthWord = match[1]!;
    const resolved = MONTH_WORDS.get(monthWord);
    if (resolved === undefined) continue;
    const day = Number(match[2]);
    if (day < 1 || day > 31) continue;
    const year = match[3] !== undefined ? Number(match[3]) : null;
    if (year !== null && (year < 1000 || year > 2999)) continue;
    push(
      { calendar: resolved.calendar, year, month: resolved.month, day, text: match[0] },
      match.index,
      match.index + match[0].length,
    );
  }
  for (const match of folded.matchAll(monthYear)) {
    const monthWord = match[1]!;
    const resolved = MONTH_WORDS.get(monthWord);
    if (resolved === undefined) continue;
    const year = Number(match[2]);
    if (year < 1000 || year > 2999) continue;
    push(
      { calendar: resolved.calendar, year, month: resolved.month, day: null, text: match[0] },
      match.index,
      match.index + match[0].length,
    );
  }
  return phrases.sort((a, b) => a.start - b.start).map((entry) => entry.phrase);
}

/** A calendar date as (year, month, day) — compared lexicographically. */
export interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function intlDay(nowMs: number, calendar: string): CalendarDay {
  const parts = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(nowMs));
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    if (part.type === 'month') month = Number(part.value);
    if (part.type === 'day') day = Number(part.value);
  }
  return { year, month, day };
}

/** Today's Gregorian (year, month, day) for an epoch-ms instant. */
export function gregorianToday(nowMs: number): CalendarDay {
  return intlDay(nowMs, 'gregory');
}

/** Today's Jalali (year, month, day) for an epoch-ms instant. */
export function jalaliToday(nowMs: number): CalendarDay {
  return intlDay(nowMs, 'persian');
}

/** Lexicographic day comparison: negative iff `a` is before `b`. */
export function compareCalendarDays(a: CalendarDay, b: CalendarDay): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}
