# ADR-0071: the editorial post render, v3 form (owner-approved msg-16 shape)

- Status: Accepted
- Date: 2026-11-22
- Round: quality fix #4 — the render form (schema 11 — ZERO DDL, no migration)
- Owner decisions: 2026-11-22 ~11:55–12:08 — the v2 example (msg 15) superseded by the v3 example (msg 16, approved overall ~12:06 «همین فرم درکل خوبه!»), plus the live bold+mono finding, the quote-attribution refinement, and the optional-link refinement
- Note: ADR-0069 is the z.ai backup-account failover (PR #30, merged 2026-11-27); the Gemini-admin ADR took ADR-0070 (PR #31, merged 2026-11-27) — this ADR takes 0071, the next free number.

## Context

The v2 render (ADR-0050 + OD-011) composed headline → summary → claim
bullets → unverified note → footer. The owner corrected the form twice
live (msg 14/15, then msg 16): the v2 form repeated every figure four
times (title + body + quote + bullets), printed Persian digits, labeled
the verdict «حرف آخر:», and rendered the trust label and the ⏺
separator from Soul v1. The v3 example (msg 16, same GTA VI draft, same
Gematsu photo) is the approved target form:

- bold emoji title, Latin game name on its own line (italic, optional
  inline game-page link), body without figures, a REAL quote in a
  blockquote, ONE dedicated figures block (main figure bold+mono), an
  unlabeled verdict sentence, the house footer blockquote.

Two live findings constrain the implementation:

1. Nested `<b><code>$3.79B</code></b>` (bold exactly over the mono span)
   did NOT survive: Telegram's parser flattened it to a code-only
   entity (confirmed in the sendPhoto reply). The main figure therefore
   uses bold spanning the WHOLE figures line with the code span inside
   it — a nesting the official docs forbid (styles "except pre and
   code") and which NEEDS live verification on the first real post
   after deploy, since there is no dry-run for entity parsing.
2. The quote attribution («— Sam Houser») must sit on its OWN line
   INSIDE the same blockquote — never on the quote's line, never
   outside/below the blockquote element.

## Decision

The render (`src/domain/admin-post/editorial-post-render.ts`, the single
choke point — scheduler, auto-gate, correction render, admin preview all
flow through it) now composes the v3 blocks in canonical order
(title, body, quote, figures, verdict, footer), joined by a blank line:

1. **Title** — bold `{categoryEmoji} {headline}`; the emoji comes from
   `document.soulForm` (absent on prompt-v1 drafts = no emoji). The
   trust label is NEVER rendered (owner order): it stays STORED
   (shape still validated, like `sourceReport`) but is unrendered.
   The ⏺ separator is gone (the render never emitted it; none is
   introduced). The Latin game name rides its OWN line, italic — from
   the stored `document.gameName` when present, else the LONGEST
   Latin-script alias in the stored entity-mentions report (a
   display-only fallback, never a lookup or an identity claim).
2. **Body** — `summaryFa` as stored. The render never restates a figure
   in the body: figures live ONLY in the figures block. (The body
   itself carries no figures only when the MODEL writes it that way —
   prompt v3 follow-up; a legacy summary that still embeds figures
   renders them folded, plain, once — the render never strips authored
   prose, which would mangle sentences.)
3. **Quote** — the stored `document.quote` only (verbatim text +
   attribution, prompt v3): `«text»` with the attribution on its own
   line inside the same blockquote; quotes longer than 240 units ride
   `expandable_blockquote`. Absent = no quote block — a quote is never
   derived or invented (it cannot be: the excerpt is the article text,
   and extracting a quote + attribution from it would be a guess).
4. **Figures** — ONE line per key figure, `label: value`, values mono;
   the MAIN figure's whole line is bold with the mono value strictly
   inside it. Figures come from the stored `document.figures` when
   present (model-authored, prompt v3 — the quality path), else are
   DERIVED mechanically from the model claims: one line per number
   phrase (claim order, first = main), value = the number folded to
   Latin with a compact unit symbol (میلیارد→B, میلیون→M, هزار→K,
   دلار→$ prefix; other unit words kept verbatim), label = the up-to-3
   words before the number (cleaned of punctuation and trailing
   copulas), falling back to the claim minus all its number phrases.
   Derivation is best-effort formatting of the model's own words, not
   a semantic parse — odd claims yield odd labels, and the structured
   field overrides it. Numberless claims render nowhere (their facts
   belong in the body, per the v3 division of labour).
5. **Verdict** — the stored `document.verdict` sentence, with NO label.
   Absent = no verdict line — the sentence is never invented.
6. **Footer** — the byte-pinned `👾 @pixellores` blockquote, unchanged.

Across the whole post:

- **Latin digits ONLY** — Persian/Arabic-Indic digits fold to Latin at
  render time (the ADR-0066 1:1 map, so entity offsets are preserved);
  the stored document is never rewritten.
- **RTL** — every Latin span is bidi-isolated (LRI U+2066 … PDI
  U+2069): whole-Latin spans get one wrapping pair, Latin runs inside
  Persian text get per-run isolation (the inbound persian-format
  pattern, plus a leading `$`). The footer stays byte-pinned.
- **No repetition BY THE RENDER** — each figure it emits appears exactly
  once, in the figures block.
- **No unverified line, ever** — gone, period, not conditional. The
  claim `status` field is therefore no longer a render contract:
  `readClaims` accepts an entry on its TEXT alone. The internal gate
  stays the fact-guard report: the auto-gate still requires it present
  - total + zero non-benign findings (its step-1 comment is updated;
    the gate no longer relies on the render to refuse a laundered
    status).
- **Full palette, where it fits** — bold, italic, mono, blockquote /
  expandable_blockquote, inline `text_link` (game-page link only,
  OPTIONAL — never required; absent = a plain italic name), with
  spoiler reserved for leaks only and underline/strikethrough unused
  by the render (no stored field calls for them; the palette is
  available to later prompt-side fields, not forced into this form).
- **Photo mandatory, caption trimmed, album of up to 4** — the
  scheduler's `resolveEditorialPhoto` now resolves up to
  `EDITORIAL_ALBUM_MAX_PHOTOS = 4` distinct source photos (story
  reference items, source order, deduped by URL; a URL that fails its
  own resolution is skipped fail-soft and only kills the plan when NO
  URL resolves). One usable photo keeps the single-photo path
  (ADR-0068); two or more send as ONE media group via the channel
  transport's optional `sendMediaGroupRich` (wired in `cron.ts` from
  `botApi.sendMediaGroupRich`; the caption rides the FIRST photo
  only, the house invariant the client enforces) — without that seam
  the album degrades to the single-photo plan with the FIRST photo,
  never a failure. The caption comes from
  `renderEditorialPostCaption` (same v3 form, kind `'caption'`,
  deterministically trimmed to 1024 units: title + footer mandatory,
  middle blocks kept figures > body > quote > verdict, body
  word-trimmable with '…', `trimmed` reported and logged). An
  over-long caption NO LONGER degrades to text — the photo is kept;
  the text fallback happens ONLY when no photo exists. The TEXT render
  keeps its no-truncation contract (typed `text_too_large`). The
  ledger hash stays the FULL-text hash on ordinal 0 ONLY (the other
  ordinals carry null): the correction engine re-renders the stored
  document and compares against it, so a caption hash would refuse
  every correction on a photo post. Per-ordinal delivery records +
  usage bindings land like the durable-album path (ADR-0060): the
  response shape gate runs before any ledger write, a URL send's
  returned file_id is saved best-effort, the usage binding lands
  after the delivery proof and before the terminal, and a P0 album
  pins its FIRST message. The evidence check is shape-aware (the
  d65d811 P1-2 proof, applied to the editorial album): a multi-record
  ledger heals only on the EXACT ordinal set {0..N-1} over the
  re-derived album size N with the usages bound (the unbound family
  reconciles its binding, then heals); a partial witness parks
  `album_evidence_incomplete`, a swapped binding parks
  `album_usage_mismatch` — never a heal on a guess, never a re-send.
  The re-derivation is READ-ONLY (no URL-asset inserts at heal time)
  and deterministic, so a drift between the send-time album and now
  (a late-arriving source item, a revoked rights echo) parks
  conservatively. The durable-album document path (`media: 'album'`,
  its identity scaffold, `mediaTransport`) is untouched — the
  editorial album rides the channel transport like `sendPhotoRich`,
  not the media seam; no album document is ever forged at send time.
  No migration: schema 11 untouched, ZERO DDL.
- **Envelope relaxation (ADR-0071 exception)** — a formatting style
  may STRICTLY contain an inline `code` entity (the figures main-line
  shape). Equal-range style+code stays REJECTED (the live msg-16
  flattening), code still never contains anything, `pre` stays fully
  isolated. This deliberately deviates from the official nesting rule
  on the owner's explicit instruction + live evidence; if the first
  real post shows Telegram rejecting or flattening the shape, the
  render falls back to code-only for the main figure (a one-line
  change: drop the line bold).
- **No source line, no trust label, no ⏺** — as in OD-011 / the
  2026-11-22 orders; the fields stay stored, unrendered.

## Consequences

- Every stored draft re-renders in the v3 form (same choke point, so
  the bridge, the scheduler, the auto-gate, the correction engine and
  the admin preview all move together). The 20 held drafts re-render
  too — they need human review before posting anyway (no re-evaluation
  path exists for stored reports).
- The `document.figures` / `document.quote` / `document.verdict` /
  `document.gameName` / `document.gamePageUrl` fields are CONSUMED by
  the render but PRODUCED by nobody yet: prompt v3 + the mapper must
  start writing them (follow-up — the render degrades gracefully
  without them: derived figures, no quote, no verdict, alias game
  name, plain italic name). Until prompt v3 ships, new posts have the
  v3 skeleton with mechanically-derived figures and no quote/verdict.
- The bold+mono main figure needs live verification on the first real
  post after deploy (no dry-run for entity parsing exists). If it
  fails, fall back to code-only (see above).
- The multi-photo album (owner requirement 2026-11-22 ~12:08: up to 4
  photos as one media group, caption on the first photo, single-photo
  → text fallbacks) IS in this PR — see the photo bullet above. The
  bound is 4, not the Bot API's 10: the owner ordered max 4 source
  photos per editorial post. The remaining follow-ups are prompt v3
  (above) and the live verifications below.

## Tests

- `tests/unit/editorial-post-render.test.ts` (25 tests): the GTA v3
  document reproduces the msg-16 form byte-for-byte (text + entities,
  incl. the own-line attribution and the bold⊃code main figure);
  no-repetition (each figure once), Latin-only digits, no trust
  label / ⏺ / unverified line / «حرف آخر:» / source line, derived
  figures (incl. a two-number claim), the mentions-alias game name,
  the optional link (present / absent / invalid), the long-quote
  expandable switch, the loosened claim-status contract, the caption
  trim (fits untrimmed / long body trimmed / verdict+quote dropped
  before the body, figures kept), determinism, the 4096-unit typed
  failure.
- `tests/unit/rich-text-envelope.test.ts`: strict style-contains-code
  now legal; equal-range style+code, code-containing-style and all
  `pre` overlaps still rejected.
- `tests/unit/auto-gate.test.ts`: a `confirmed` claim status no longer
  refuses the gate — the clean fact-guard report decides
  (`eligible_auto`).
- `tests/integration/admin-post-editorial-bridge.test.ts`: the pipeline
  fixture now expects the v3 text (🔵 title + summary + footer; the
  numberless claim renders nowhere).
- `tests/integration/publication-94-photo-send.test.ts`: an over-long
  caption now TRIMS and keeps the photo instead of falling back to
  text; the editorial album (9 tests): a 2-photo media group with the
  caption on the first photo only, per-ordinal delivery records +
  usages, URL file_ids saved; the 4-photo cap with 5 source images;
  single-photo when only one item carries an image; dedupe of a
  repeated URL; fail-soft skip of a rights-blocked URL; degrade to a
  single photo without the media-group seam; the shape gate parks
  uncertain with zero ledger writes on a wrong reply; the evidence
  check heals a complete album proof (reconciling the missing usage
  binding) and parks a partial proof `album_evidence_incomplete`.
- `tests/integration/publication-86/93-correction-render/sweep.test.ts`:
  unchanged, green — the correction engine re-renders through the
  same choke point and the full-text hash still anchors priors.
- Full gate: `npm run check` + `npm run test:db` green (see the PR).
