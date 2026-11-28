# ADR-0080 — Figures block: significance rule (derivation deleted, prompt v4)

Date: 2026-11-28. Status: Accepted (owner decision 2026-11-28 08:07:
the figures block exists ONLY for headline stats; ordinary posts
carry no figures block).

SUPERSEDES ADR-0071 §4's derivation fallback and PR #42's date-merge
as live behaviour. The merge stays in history; the derivation it
repaired is gone.

## Context

The figures block was DERIVED mechanically:
`document.figures ?? deriveFiguresFromClaims(...)` pulled numbers
out of the claims — release dates, platform numbers (PS5 ← «۵»),
prices, bundle/item counts, episode numbers, title fragments
(Spider-Man 2 ← «۲»). PR #42's date-merge repaired one symptom of
that derivation (dates clustering into figures). The owner's
verdict at the 09:00 review: a number belongs in the block only
when it IS the story. Everything else is body text, not a figure.

## Decision

### 1. The derivation is DELETED

`deriveFiguresFromClaims` is deleted with its helpers
(`NUMBER_TOKEN`, `FIGURE_UNIT_WORDS`, `FIGURE_SCALE`,
`FIGURE_LABEL_STOP_WORDS`, `stripWordPunctuation`,
`cleanLabelWords`, `compactFigureValue`, `FIGURE_MONTH_WORDS`,
`FIGURE_RELEASE_MARKERS`, `FIGURE_RELEASE_MARKER_WINDOW`,
`FIGURE_RELEASE_DATE_LABEL`, `FigureEntry`) and its tests —
INCLUDING PR #42's date-merge tests, which tested the derivation's
repair, not a feature. The month-word lists survive: they moved to
`src/domain/publishing/date-phrases.ts`, where the freshness gate
(ADR-0079 §3.3) reuses them. The render reads
`document.figures` only.

### 2. The significance gate

`RenderFigure` gains optional `significance?: 'headline' |
'context'`. The render shows ONLY figures marked `'headline'`:
unmarked or `'context'` figures are dropped, and old documents
without the field are not-significant. Consequence, stated
plainly: until prompt-v4 figures land, NO post has a figures
block — the owner's decision for ordinary posts. `readStructuredFigures`
still enforces the old shape rules (at most one `main`, label ≤120,
value ≤40) and now rejects an unknown `significance` value as a
malformed render failure.

### 3. Prompt v4 + mapper (included, not deferred)

`AI_PROMPT_VERSION` bumps `pixel-news-draft-v3` →
`pixel-news-draft-v4`. The prompt asks for four optional fields —
`figures`, `quote`, `verdict`, `gameName` — with the rule: write
them ONLY when the evidence really has them; when absent, omit the
key entirely — never invent, never guess.

Rule 6 is the figure instruction, carrying the significance
criterion VERBATIM:

> a figure earns the block iff it is a headline stat — remove the number and there is no story left.

plus the earn list (sales results, pre-order counts, launch
records, player-count records/milestones, chart records, a record
review score that IS the story) and the does-not-earn list
(release dates, platform numbers, prices, bundle/item counts,
episode/season numbers, title fragments, counts inside a list,
dates in any form). `value` as in the evidence (number + unit,
e.g. `$3.79B`); `main: true` for at most one figure.

Rule 7: `quote` / `verdict` / `gameName` are never invented — a
quote only verbatim from the evidence with its attribution as in
the evidence; a verdict only one closing sentence when the evidence
has an explicit evaluation; `gameName` Latin as written in the
evidence, no translation, no guess; omit when absent or ambiguous.

The schema (`aiSemanticDraftSchema`, still `.strict()`) gains the
four optional fields: `figures` (max 8, mirroring
`EDITORIAL_POST_MAX_FIGURES`; label 1–120, value 1–40,
`significance` enum, `main` boolean), `quote` (strict object,
text 1–600, attribution 1–120 optional), `verdict` (1–300),
`gameName` (1–120). Bounds mirror the render's defensive readers.
A v2-shaped output (with `categoryEmoji` / `trustLabel`) still
fails as `invalid_output`. The mapper (`buildDraftDocument`) writes
each field through ONLY when the semantic draft actually gave it;
absent stays absent — never derived, never backfilled. The parsed
draft flows straight from `parseAiSemanticDraftJson` in
`draft-service.ts`; no conversion layer needed updating.

### 4. What does NOT change (§3.8 iii–vi)

- Quote/verdict never invented: absent = no block (the render
  already does this).
- No mechanical alias derivation is reintroduced. The pre-existing
  `readLatinGameAlias` fallback in the render is untouched — §3.8
  (iv) notes there is no Latin name line until the mapper writes
  `gameName`, which is acceptable.
- Photo mandatory per ADR-0071, enforced by §3.4 (ADR-0079).
- No body stripping.

## Consequences

- The figures block is absent from every post until the model marks
  a headline-significant stat. Ordinary posts are cleaner by design.
- Old documents (no `significance` field) render without a figures
  block. Nothing is backfilled.
- The prompt-v4 fields ride the same strict schema discipline as
  v3: an unknown field or an oversized figure still fails the parse.
- The GTA fixture in the render tests carries
  `significance: 'headline'` on both figures (byte-for-byte text
  and entities otherwise unchanged).

## Tests

- Render significance tests (4 cases replacing the 7 deleted
  derivation cases): no figures + numbered claims → NO block
  (values appear nowhere); headline-marked figures → block renders
  (main bold + mono); context-marked or unmarked → NO block; mixed
  headline+context → only headline renders. Malformed
  `significance: 'viral'` → `malformed_document`.
- Prompt v4 pin test: version v4, asks for the four fields, the
  VERBATIM significance sentence, earn/does-not-earn markers, and
  the "never invented" rule 7.
- Schema round-trip tests: v4 shape with all four fields parses
  (values verbatim); absent fields stay absent; unknown significance
  or oversized label rejected; v2 shape still rejected.
- Mapper tests: the four fields written through when the model
  gives them, absent when it does not (never invented).
