# ADR-0079 — Content quality: re-enable ingestion, fix GameSpot parsing, persist source photos, richer input

Date: 2026-11-28. Status: Accepted (owner orders 2026-11-28 07:51–08:07:
the posts are small / old / photo-less / every-10-minutes, the format
is not the plan; the 09:00 review decisions recorded in the
content-quality fix spec: freshness cutoff 48h, daily cap 6/day, P1
latency 30–90 min, P1 gap 30 min, substance ≥3 claims, enable
xbox_wire / ign_games / eurogamer_news, VOID the 40 stale pending
rows, AI images stay OFF for news, og:image cap 8).

## Context

Live evidence 2026-11-28 08:00–08:40 Tehran (worker `1.49.0 /
93237c5f / schema 13 / preview`, `/health/ready` ok; mode `paused`
since 07:59 by the owner):

- Ingestion has been dead since Nov 22 08:00 UTC — not a crash, a
  gate. `SOURCE_INGESTION_ENABLED` and `EDITORIAL_ENABLED` are
  `"false"` in the deployed preview config and were never `"true"` in
  any committed `wrangler.jsonc` (one commit each, `0dc624f`,
  2026-10-09). The Nov 21–22 polls ran under a non-committed live
  value that a later deploy wiped. The pipeline published a dead queue
  for 6 days: 15 published / 40 pending, all 55 drafts
  auto_approved, created Nov 21–22, every story exactly ONE claim,
  `body_excerpt` 89–122 chars.
- `gamespot_news`: 5 consecutive failures, `last_error =
response_malformed`, `last_success_at` NULL — never succeeded once.
  The live feed is valid, current RSS (lastBuildDate Nov 28 04:27
  UTC, full article bodies with images in `content:encoded`).
- Photos: `media_assets` has 0 rows. Three stacked gaps — the feeds
  carry no image (Gematsu: no enclosure/media fields, no `<img>` in
  descriptions), the `og:image` fallback never ran live (PR #29
  landed after the last poll) and is capped at 2/feed/poll, and a
  resolved image has no write path (normalize validates `imageUrl`
  into provenance; the ingest store never reads it).
- Substance: extraction input is the title + a ~100-char excerpt
  (the feeds' own brevity — Gematsu truncates its RSS descriptions),
  and the 512-char excerpt cap would cut a GameSpot-type full body
  to a stub. The model produces exactly one claim per story.

## Decision

### 1. Re-enable ingestion — commit the ON state (PR-A, §3.1)

`wrangler.jsonc` `env.preview`: `SOURCE_INGESTION_ENABLED`
`"false"` → `"true"`, `EDITORIAL_ENABLED` `"false"` → `"true"`.
This is the durable fix: a dashboard toggle is wiped by the next
deploy, which is exactly how ingestion died. The local defaults stay
`"false"`. A config test pins the committed preview values so a
future edit cannot silently re-disable the feed. Sources
`xbox_wire`, `ign_games`, `eurogamer_news` are enabled via audited
D1 `sources.enabled` flips after deploy (RSS, same connector as the
working sources; no migration). `gamespot_news` stays enabled.

### 2. GameSpot — the scanner rejected a long article body (PR-A, §3.2)

Reproduced against the CURRENT live feed, saved verbatim as
`tests/fixtures/gamespot-news-2026-11-28.xml` (218,692 bytes,
30 items, lastBuildDate Nov 28 05:21 UTC): `parseFeedDocument`
returned `!ok`. Root cause, proven by bisecting the document: ONE
`content:encoded` CDATA body is 86,704 chars, over the scanner's
`maxTextNodeChars` bound of 65,536 — and the scanner failed the
WHOLE document for it (`text_too_long`). The feed is 218 KB, far
under the 2 MB `maxFeedBytes` cap; the size was never the problem.

Fix (bounded, no new dependencies): an over-long text node —
plain or CDATA — is TRUNCATED at the bound instead of failing the
document, with a surrogate-safe cut (a high surrogate at the cut
backs off one unit). The emitted event never exceeds the bound, so
the memory posture is unchanged; the reader and the normalizer
truncate every field far below this bound anyway (title 512,
excerpt 4000), so nothing downstream ever sees the cut. The
`text_too_long` failure reason is deleted with the failure (no
other consumer). A well-formed feed with one long article is not a
malformed feed, and one long item must never kill the other 29.

The fixture is the regression test: the saved live feed parses
(30 items, every item with an image, the long body truncated at
exactly 65,536 chars).

### 3. Feed-reader image fallback: first `<img>` in `content:encoded` (PR-A, §3.2b)

The reader also takes the first `<img src>` inside `content:encoded`
(RSS) or `content` (Atom) as a fallback — after `enclosure` /
`media:content` / `media:thumbnail`, with the same `isHttpImageUrl`
validation. The candidate is collected during the scan and applied
only in `finishItem` when no media image was selected, so the media
fields keep strict priority regardless of document order. The scan
moves past non-https/over-long `src` values to the next `<img>`
(bounded at 10 candidates per body). GameSpot needs no fallback
today (all 30 items carry `media:content`); the fallback covers
feeds with encoded bodies but no media fields.

### 4. Photos — persist what the feed gives (PR-A, §3.4)

(a) At source-item commit, an inserted item with a resolved image
mints one `media_assets` row — type `photo`, rights
`attribution_required`, attribution = the image host, status
`validated`. The shape mirrors the scheduler's own send-time
`insertUrlAsset` call (`resolveOneEditorialPhotoAsset`), which is
the shape `resolveEditorialPhoto` already accepts (publishable
rights + `validated` status), so no new read path is needed. The
write rides the ingest commit's classification (inserted items
only, in a second batch after the item batch — a duplicate item's
attempted row does not exist, so it must never mint an orphan row
pointing at a fresh id), deduped atomically with `WHERE NOT EXISTS`
on the canonical URL or the row id (no UNIQUE index on the column,
ADR-0068 — zero DDL). A media failure propagates: the items are
already committed, so a retry absorbs them as duplicates and
re-attempts only the media rows — a silently dropped photo row
would hide a broken photo path. Both commit paths
(`commitPollResults`, `commitOwnedPollResults`) mint the row;
`poll-handler` carries the image through (`imageUrl` +
`mediaAssetId` + `imageAttribution` on `IngestItemRow`, all
optional so existing callers are unaffected).

(b) `OG_IMAGE_MAX_PER_FEED` 2 → 8 per feed per poll (newer-first,
fail-soft, inside the ingestion budget). Verified against real
Gematsu article HTML fetched with the worker UA
(`PixelEditorialAgent/1.4`): Gematsu returns HTTP 200 (does NOT
block the worker UA) and the page carries a valid `og:image`
(`Sea-of-Sorrow-Date_11-27-26.jpg`); `extractOgImage` returns it,
skipping the `og:image:width` / `og:image:height` siblings (same
prefix, non-URL content). The first live run must still be watched
(request counts, failures, `media_assets` rows appearing).

(c) AI images stay OFF for news — no flag change
(`AI_IMAGE_ENABLED` remains `"false"`). A generated image on a
NEWS post depicts something that didn't happen.

### 5. Richer input — excerpt cap 512 → 4000 (PR-A, §3.7b)

`excerptMaxChars` (source-registry.ts) rises 512 → 4000. The pick:
4000 is exactly `EDITORIAL_EXCERPT_MAX_CHARS`, the editorial
pipeline's evidence cap (`buildTraceableExcerpt` in mapper.ts), so
a GameSpot-type full body reaches the model instead of a 512-char
stub, and nothing above the cap is ever stored — storing the full
encoded body (up to ~87 KB per item) would be cut by
`buildTraceableExcerpt` anyway and would bloat `source_items` for
zero model input. The AI snippet cap (8000) is untouched.
Consequence, stated plainly: this helps GameSpot-type feeds whose
full body IS in the feed. Gematsu-type feeds (short descriptions,
full body only on the article page) stay thin until an article-body
fetch per item is built — deferred behind the PR-B substance gate
(≥3 claims → `requires_review`), which is the point: nothing thin
auto-publishes.

### 6. Freshness gate — 48h source age + past-date rule (PR-B, §3.3)

`isDraftStale({ sourcePublishedAtMs, claimDatePhrases, nowMs,
maxAgeMs })` is a pure function in
`src/domain/publishing/draft-freshness.ts` (`FRESHNESS_MAX_AGE_MS`
= 48h). Two rules, either one stales the draft:

- **Source age:** `nowMs - publishedAt > 48h` → `stale_source_age`.
  A `null` `published_at` is stale (fail-closed: undated news cannot
  prove it is fresh). Exactly 48h is fresh; a future `published_at`
  is fresh.
- **Past date:** a day-precision date phrase from the draft's own
  claims that names a day before today (in the phrase's own
  calendar) → `stale_past_date`. Month+year phrases (day null) never
  fire; a year-less phrase resolves in the current year of its own
  calendar. The month-word lists are PR #42 / ADR-0077's lists,
  moved from the figures-derivation merger into
  `src/domain/publishing/date-phrases.ts` (Gregorian Persian
  transliteration, Jalali, English both cases; `مه` May vs `مهر`
  Jalali 7 kept distinct) — the word lists, NOT the figure
  derivation.

Bridge: the check runs BEFORE the auto gate, after the ADR-0070
rewrite seam, once per draft, reusing the reference row the lane
rule also reads (one `findStoryReferenceItems` call). On stale:
a `quality_rejections` row first (`id` `qr:stale:<draftId>`,
fingerprint `stale:<content_hash>`, reason = the stale reason,
`sourceItemId` = the primary reference id), then the fenced
`UPDATE drafts SET status = 'rejected' WHERE id = ? AND status =
'ready'` — the fence rejecting means `rejected` + a warn, never a
silent pass. `drafts.status` IS CHECK-constrained (migration 0001:
`generating, ready, validated, approval_required, auto_approved,
approved, rejected, superseded, failed`), so `'rejected'` is the
fitting terminal value and no migration-0014 ride is needed; the
bridge only scans `ready`, so a retired draft never re-enqueues.
A reference lookup failure retires NOTHING (the draft is skipped
this pass — a read failure must never retire news); no reference
items means the check is skipped. Report gains `retiredStale`.

Scheduler: an already-enqueued stale row dead-letters
(`markClaimedDeadLetter` with `errorCode: 'stale'`, the existing
terminal path, plus a best-effort `recordQualityRejection` in the
same shape; a rejection-write failure is logged, never resurrects
the row). In decision-only mode the same row is observed as
`decision_only` / `stale` with ZERO writes. A story with no
reference items is absent from the per-scan source map, so
freshness skips it; a map-build failure fails the scan closed
with zero sends.

The 40 stale pending rows are voided ONCE, owner-approved,
audited D1 maintenance (terminal `cancelled` status;
`drafts`/`source_items` untouched — the backlog is discarded AS
NEWS and kept as data).

### 7. Fairness slot + P1 tiebreak (PR-B, §3.5)

`orderDueRowsForTick` sorts by priority DESC first (the store's
`listDuePublications` order still governs which rows enter the
scan window; this reorders WITHIN the window only), then — ONLY
when both rows are P1 — by source priority DESC, then `run_after`
ASC, then id. Source priority is `sources.priority` (0–100); it
is NEVER copied into the send priority class. `applyFairnessSlot`
(cap 1/tick) then promotes the highest-priority due row from a
DIFFERENT provider than the first row to the FRONT of the
processing order. The tick sends at most one row in steady state
(the gap floor defers the rest once the first sends), so promotion
is the only mechanism that gives the different provider the tick's
send; the displaced rows defer on the gap, and the promoted
provider's queue drains one row per send-tick, so the inversion is
bounded by that queue's depth. A P0 first row is never displaced.

PRECEDENCE (§3.5a vs §3.5c — the two rules would otherwise fight):
the slot rescues a LOWER-class row only. When the best
different-provider row is the SAME class as the first row, the
tiebreak already orders it fairly (by source priority) and it
rotates in on a later tick by the gap — it cannot starve, so no
promotion fires and the tiebreak's order stands. Only a row the
priority order would starve behind a higher class (the §4 case: a
P2 from provider B behind nine P1s from provider A) is promoted.
Without this scoping the slot would defeat the tiebreak wherever
the top two rows differ in provider, and the tiebreak would never
change an outcome. The decision-only path gets the tiebreak order
but no fairness promotion (nothing is selected for sending there,
so there is no slot to fill).

### 8. Cadence + cap (PR-B, §3.6)

- P1 latency 5–20 → **30–90 min** (`P1_LATENCY_MIN/MAX_MS` in
  `publication-schedule.ts`; the `scheduler-policy.ts` mirror band
  moves with it — the unit suite cross-validates the two, so a
  change in one without the mirror fails every P1 with
  `jitter_out_of_bounds`).
- P1 gap floor 8 → **30 min** (`P1_GAP_MIN_MS` in `anti-robot.ts`);
  the ceiling rises 15 → **45 min** so the band stays ordered —
  `resolveSendGapMs` validates a P1 candidate's jitter against this
  band, and an inverted band would fail every P1 gap resolution.
- Daily cap: `MIN_DAILY_CAP` 12 → **6** (DEFAULT 15, MAX 18
  unchanged). The store's read path silently falls back to the 15
  default for an out-of-range stored cap, so widening the bound is
  what makes the owner's 6/day cap actually bind. The live write
  goes through `setDailyCap` (setting + audit, actor 126679582;
  takes effect next Tehran day by design).
- `recordPublication` is wired at ALL THREE send terminals (text,
  editorial album, claimed album), after `markClaimedPublished`
  returns `written`. Best-effort: a counter-write failure is
  logged, never un-sends. Deliberately NOT called on the
  evidence-heal path — a healed row was sent by a crashed
  generation and the heal cannot tell whether that generation
  already counted it, so counting there could double-count one
  post. P0 increments ONLY the bypass counter, never the cap.

OPEN, recorded honestly: the daily cap is consulted only by
`checkPublishGate`, which only the admin panel calls — neither the
bridge, the scheduler, nor the cron entry consults it on the send
path (the cron reads only the MODE for the send gate). This PR
wires the counter and the cap value, and the gate refuses at the
cap WHEN ASKED (`evaluatePublishGate` / `checkPublishGate`); wiring
the cap CHECK into the scheduler send path is a separate, unscoped
decision for the owner, not silently assumed here. Likewise
`ADMIN_PANEL_CAP_PRESETS` is still `[12, 15, 18]` — the panel
cannot express 6 (panel code is out of scope for this PR; a preset
change rides the panel work).

### 9. Substance gate — ≥3 claims (PR-B, §3.7a)

`AUTO_GATE_MIN_CLAIMS = 3` in `auto-gate.ts`: a draft with fewer
than 3 claims is `requires_review` / `insufficient_claims` — thin
drafts go to human review, never auto-publish. The rule sits LAST
in gate order (after document re-read, report basis, totality, and
per-claim grounding), so the verdict names the FIRST failing rule:
a thin draft without a report is still `refused`
(`report_absent`), a thin draft with an ungrounded claim still
reports `fact_guard_findings`, and only a thin draft that is
otherwise fully grounded reports `insufficient_claims` (its
per-claim entries carry no findings — the COUNT is the reason —
and the report's limitation labels ride verbatim).
`AUTO_GATE_VERSION` stays `'ag1'`. `recordGateEvaluationQuietly`
for `requires_review` now passes `verdict.reason` instead of the
hardcoded `'fact_guard_findings'`, so the progress table records
the real reason (`insufficient_claims` included).

Consequence for the existing suites: every chain that expected a
1-claim draft to be `eligible_auto` now builds 3-claim documents
(e2e-94, cap-pool, 96-guide-lane, slice09). The livelock suite's
real 1-claim live bytes are the deliberate exception: those drafts
re-evaluate cleanly under the folded lens and then go to human
review on substance — the suite pins the re-evaluation layer, not
bridging.

### 10. Figures — see ADR-0080

The figures rule (§3.8) lives in its own ADR: derivation deleted,
significance gate (`'headline'` only), prompt v4 + mapper writing
`figures` / `quote` / `verdict` / `gameName`. ADR-0080 SUPERSEDES
ADR-0071 §4's derivation fallback and PR #42's date-merge as live
behaviour (the merge stays in history; the derivation it repaired
is gone).

## Consequences

- PR-A ships first (`fix/content-ingestion-photos`); PR-B
  (`fix/content-quality-gates`) ships after PR-A is live and
  ingestion is verified advancing. PR-B covers the rest of this
  ADR's scope as decided at the 09:00 review: the freshness gate
  (48h + past-date rule, `isDraftStale`, stale-draft retirement and
  dead-lettering, the 40 stale pending rows voided once),
  the fairness slot (1/tick, P1 tiebreak by source priority), the
  cadence + cap (P1 latency 30–90 min, P1 gap 30 min, daily cap
  6/day, `recordPublication` wired), the substance gate (≥3 claims),
  and the figures rule (ADR-0080).
- No migration in PR-A (flag flips are config; the `media_assets`
  write uses the existing table). Schema stays 13, app stays
  1.49.0.
- Live verification (PR-A): `/version` shows the new merge commit +
  schema 13, `/health/ready` ok, STABLE across 2+ reads 2 min
  apart; then `source_state.last_success_at` advancing past the
  deploy AND new `source_items` rows AND `media_assets` rows for
  the fresh items. Mode stays PAUSED.
- Live verification (PR-B, gates WITHOUT sending): a stale draft
  retires (`quality_rejections` row + draft leaves `ready`); the cap
  counter path is wired (`recordPublication` call sites + a
  `budgets.daily_posts` row observed on a send); the daily cap is
  set to 6 via `setDailyCap` (audited, actor 126679582) and the 40
  stale pending rows are voided once (audited, terminal
  `cancelled`). Mode stays PAUSED until the §3.9 resume checklist
  (items 1–5) passes and the mode flips paused → auto via
  `setPublishMode` (same audited pattern).
- Honest gaps carried forward: §2.7 (the 07:28 stall) stays OPEN
  pending worker logs; OD-024 stays OPEN (migration 0014, its own
  PR); the 55-draft backlog is retired as news (voided, data kept),
  the channel restarts from the fresh feed; the cap CHECK is not
  consulted on the scheduler send path (see §8 — an owner decision,
  not a silent assumption); `ADMIN_PANEL_CAP_PRESETS` cannot express
  6 yet (panel work).

## Tests

- GameSpot fixture test (saved live feed parses: 30 items, all
  with images, long body truncated at the bound).
- safe-xml truncation tests (over-long CDATA / plain text truncate,
  surrogate-safe cut, short text byte-identical).
- Feed-reader encoded-`<img>` tests (first img wins, media keeps
  priority even when later in the item, non-https skipped, Atom
  content too).
- RSS og:image tests (cap 8/feed/poll; `extractOgImage` against
  verbatim live Gematsu meta lines, width/height siblings skipped).
- Normalization excerpt tests (long body → 4000-char excerpt;
  600-char body kept whole).
- Ingest media-assets integration tests over REAL D1 (both commit
  paths mint the row; imageless item mints none; duplicate
  re-commit mints no second row and no orphan).
- Preview-flags config test (preview ON, local defaults OFF).
- Freshness unit tests (17): the 48h boundary (47h59m fresh,
  48h01m stale, exactly-48h fresh), future/`null` published_at,
  past/future/today dates in Gregorian + Jalali, month+year-only
  never fires, year-less resolution, `مه` vs `مهر`, extraction +
  dedup + defensive document reading.
- Auto-gate substance tests (5): 1- and 2-claim clean drafts →
  `requires_review` / `insufficient_claims`; 3-claim clean →
  `eligible_auto`; thin + no report → still `refused` /
  `report_absent`; thin + ungrounded claim → still
  `fact_guard_findings`.
- Cadence unit tests (90): P1 latency 30–90 min pins (schedule,
  anti-robot 30–45 min gap band, scheduler-policy mirror band).
- Cap tests: `isValidDailyCap` admits 6/15/18, rejects 5/19;
  `setDailyCap(6)` applies from the next Tehran day and
  `checkPublishGate` refuses at the cap (`cap_reached`, P0
  bypasses); a successful scheduler send increments
  `budgets.daily_posts` in today's Tehran bucket.
- Bridge + scheduler integration tests over REAL D1: stale draft
  retires (bridge) / dead-letters (scheduler) with the
  `quality_rejections` row; decision-only mode observes stale with
  zero writes; the §4 fairness case (9 P1s provider A + 1 P2
  provider B sends the P2); the P1 tiebreak (higher source priority
  sends first, P1-only sets unchanged).
- Suites updated for the substance gate: e2e-94, cap-pool,
  96-guide-lane and slice09 chains now build 3-claim documents;
  the livelock suite's real 1-claim live bytes now prove
  re-evaluation + human review on substance (not bridging);
  slice09's advance loop covers the new 30–90 min latency + 30-min
  gap (150 min over 10 rounds).
- Full `npm run check` + `npm run test:db` green (the
  `round181-boundary-corrections` flake is re-run in isolation per
  §4 of the spec if it trips).
