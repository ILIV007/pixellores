# ADR-0077 — Editorial render: merge date clusters into one figure

Date: 2026-11-28. Status: Accepted (owner order 2026-11-27 23:23 +
2026-11-28 00:22: everything OK by Sat 2026-11-28 09:00; the
post-quality watch found the defect live on msg 18 and hand-fixed it in
place at 03:58).

## Context

Live msg 18 (Temtem: Swarm, https://t.me/pixellores/18, 03:15:47
Tehran) rendered its release date as TWO figure lines:

```
Swarm در تاریخ: 21
ژانویه: 2027
```

The stored claim is «نسخه نینتندو سوییچ بازی Temtem: Swarm در تاریخ
۲۱ ژانویه ۲۰۲۷ منتشر خواهد شد.» — one date, two number tokens.
`deriveFiguresFromClaims` (ADR-0071) emits one figure per number
phrase, so the day and the year became two figures with mechanically
split labels. The watch hand-fixed the published caption to one merged
line «تاریخ عرضه: 21 ژانویه 2027» (editMessageText, verified live
03:58–03:59) — but every future date post would render the same split.
The defect is systematic, not per-post.

## Decision

A date is ONE figure:

- Consecutive number phrases in ONE claim separated ONLY by month
  words (a fixed list: Gregorian months in Persian transliteration,
  Jalali months, English month names) merge into one figure whose value
  is the claim's own date text in claim order («21 ژانویه 2027»).
  Phrases carrying units never merge — a unit-carrying phrase is a
  measurement, not a date part.
- A merged cluster followed within 4 words by a release marker
  (منتشر / عرضه / انتشار — fixed list) is the release date and takes
  the fixed house label «تاریخ عرضه» (the headline's own phrasing).
  Any other merged cluster keeps its mechanical label (up-to-3 words
  before the cluster, cleaned, same fallback as before).
- Single-number dates are untouched: month+year («ژانویه: 2027») and
  year-only are already one figure; the release-date relabel applies
  ONLY to merged clusters, never to single numbers.

What does NOT change: the figure cap (8), the first-figure-is-main
rule, the dedup, the unit compaction ($/B/M/K), digit folding, the
structured `document.figures` override, the gate, the fact-guard, the
bridge/cap/scheduler. The render stays a pure deterministic projection
of the stored document.

## Consequences

- The Temtem draft re-renders as ONE figure: «تاریخ عرضه:
  21 ژانویه 2027» (bold label + mono value) — the same shape as the
  hand-fixed live caption of msg 18. No re-edit of msg 18 is needed or
  done.
- Future date posts (day+month+year, in any of the three month lists)
  render one figure. Event dates keep their mechanical label.
- Honest limit: the release-date label is a bounded mechanical rule,
  not a semantic parse — a date followed by a release marker that
  belongs to a DIFFERENT clause in the same claim would be mislabeled.
  The 4-word window bounds that risk to the verb that directly follows
  the date in natural Persian order.

## Tests

- Unit: `tests/unit/editorial-post-render.test.ts` — 5 new cases: the
  exact live Temtem claim (merged line, bold+mono entities, no split
  lines, no Persian digits); a non-release event date (merged,
  mechanical label, never «تاریخ عرضه»); month+year (one figure,
  unchanged); year-only (one figure, mechanical label, no relabel);
  date + sales in one claim (merged date main + separate $3.79B
  figure, each once).
- Full gate + test:db unchanged otherwise.

No migration, schema stays 13, app stays 1.49.0 (code-only fix).

## Live verification (owed)

After deploy: /version = the new tip, /health/ready ok, schema 13; a
newly published date post must show ONE figure line with the full date
(or a local render of a stored date draft with the live code). The 30
pending publications are the live proving ground — the next date post
that lands must not need a hand-fix.
