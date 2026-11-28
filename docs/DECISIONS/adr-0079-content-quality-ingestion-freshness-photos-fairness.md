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
- Honest gaps carried forward: §2.7 (the 07:28 stall) stays OPEN
  pending worker logs; OD-024 stays OPEN (migration 0014, its own
  PR); the 55-draft backlog is retired as news (voided, data kept),
  the channel restarts from the fresh feed.

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
- Full `npm run check` + `npm run test:db` green (the
  `round181-boundary-corrections` flake is re-run in isolation per
  §4 of the spec if it trips).
