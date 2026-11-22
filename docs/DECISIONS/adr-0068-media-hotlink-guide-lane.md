# ADR-0068: source-article photos by hotlink (no R2) + guide lane + bridge category cap

- Status: Accepted
- Date: 2026-11-22
- Round: quality fixes #3 + #5 (schema 11 — ZERO DDL, no migration)
- Owner decisions: 2026-11-22 ~07:46 — «عکس منبع اوکیه، راهنما هم خوبه» (source-article photos OK; guides are good, keep them)
- Note: ADR-0066 is digit folding + Soul v1 in prompt (PR #27) and ADR-0067 is the Gemini direct fallback (PR #28); this ADR takes 0068. (It was first written as 0067 in this PR; renumbered 2026-11-22 before merge when the collision with PR #28 was found.)

## Context

The 2026-11-22 draft review found media missing at three levels and the
queue flooded by one game:

1. The feed reader never read a photo field; `media_assets` and
   `media_usages` hold 0 rows; the publish path only sends text.
   Soul §4 requires a photo/video on every post. R2 is NOT used for
   Pixel (owner decision 2026-11-21) and stays unused.
2. 24 of 51 ready drafts are GTA 6, 16 of them step-by-step VGC guides
   (`/guide/` URLs). Ingestion never separated guides from news, and
   the bridge enqueues every gate-eligible draft with no lane and no
   cap — the scheduler's anti-robot category cap (arp1) only defers
   them at send time, after the outbox is already flooded.
3. The near-dup check is dead: every story's `working_headline` is
   NULL (the only write is `workingHeadline: null` in the draft
   handler), so the scan skips every candidate and `story_merges`
   holds 0 rows. The two GTA $3.79B drafts (VGC vs Gematsu) were
   never compared.

## Decision

### 1. Media by hotlink — Telegram fetches the image from the source URL

- The feed reader extracts the image URL: RSS `enclosure` /
  `media:content` / `media:thumbnail` (first wins), Atom
  `link rel="enclosure"`. When the feed carries none, the RSS
  connector resolves `og:image` from the article page — at most 2
  per feed per poll, freshest-first, 256 KiB cap, 5 s timeout,
  fail-soft. A budget denial stops og:image resolution for that
  poll only; the feed items still commit. The feed reader itself
  never fetches (its documented contract).
- The image URL rides the durable provenance: `raw_json.imageUrl`
  on `source_items` (bounded 2048, https only). No new column, no
  migration.
- The publish path resolves the photo at send time, BEFORE the
  send-started marker: draft → story → first reference source item
  → `raw_json.imageUrl` → `media_assets` by canonical URL. When no
  asset row exists, the scheduler inserts a URL asset row
  (`status 'validated'`, `rights_status 'attribution_required'`,
  attribution = the image host, `r2_key`/`telegram_file_id` NULL)
  and then applies the send-time rights gate
  (`isPublishableRightsStatus`, unchanged). A missing or
  non-publishable row fails closed to the text send.
- Rights echo: the source article's own photo, used under the
  owner's explicit authorization, is recorded as
  `attribution_required` with the source host in the `attribution`
  column (D1 only — no source line is rendered in posts, per the
  owner's 2026-11-22 footer decision). This is the durable echo the
  d65d811 P1-3 gate reads at the moment of use.
- `sendPhotoRich` accepts a bounded https URL as the `photo`
  reference (the Bot API fetches it) in addition to a file_id; the
  URL bound is 2048 chars, the file_id bound is unchanged. A
  successful URL send saves the returned largest-variant file_id
  via `markUploaded` (best-effort, after the published terminal)
  and records the `media_usages` row — later sends reuse the
  file_id through the existing `resolveAssetReuse` rule.
- Caption fit: the rendered text becomes the photo caption only
  when the `caption` envelope validates (≤ 1024 UTF-16 units,
  enforced by `createRichTextEnvelope`); otherwise the post goes
  out as text. The photo path never truncates content.
- The scheduler's `mediaAssets` seam is widened to
  `findAssetsByUrls | insertUrlAsset | markUploaded` and may now
  exist without the album `mediaTransport` seam (photo path only);
  the album seam still requires the ledger (pair rule unchanged in
  that direction). A scheduler built without either seam keeps the
  old text-only behavior.

### 2. Guide lane — guides kept, as a separate occasional format

- A post is a guide iff its source item's canonical URL path
  contains `/guide/` (`classifyPostLane`, pure, in
  `src/domain/publishing/guide-lane.ts`).
- The bridge enqueues at most ONE guide per pass
  (`MAX_GUIDES_PER_BRIDGE_PASS = 1`) at P2 priority
  (`GUIDE_PUBLISH_PRIORITY_SCORE = 60`, the P2 band 40–74),
  so guides ride the queue without crowding news. Guides are
  never dropped. Further guide drafts stay `ready` for later
  passes.

### 3. Category cap enforced in bridge selection

- Before approving a draft, the bridge runs the existing
  `enforceCategoryShare` (arp1, exact integer math, at most 2 of
  any rolling six) over the published history (via
  `listRecentPublishedHistory` + `mapContentTypeToMixCategory`)
  PLUS the categories already approved in this pass. An
  over-cap draft stays `ready` (counted `deferredCategoryCap`,
  not rejected). `eventDriven` is false — the bridge has no
  story-layer provider (same conservative default as the
  scheduler's context provider).
- A draft whose content type does not map to a mix category skips
  the cap check (the scheduler remains the enforcement backstop
  at send time).
- The same-game 90-minute cooldown stays scheduler-side, where it
  already is; the bridge has no game keys.

### 4. Near-dup: populate `working_headline` (the dead-check fix)

- The draft handler now writes the source item's title (already
  bounded ≤ 512 at ingestion) as the story's `working_headline`
  instead of NULL, so the nd1 scan compares English title against
  English title. No threshold change: nd1 stays versioned policy.
- Live-verified 2026-11-22: `story_merges` has 0 rows and 0 stories
  carry a non-null headline — the check never ran. Note: populating
  the headline alone would NOT have merged the $3.79B pair — the
  VGC and Gematsu titles share only 6/28 tokens (Jaccard ≈ 0.21,
  below the 0.60 title floor) and even with perfect entity overlap
  the combined score caps at ≈ 0.45 (below the 0.60 review band).
  Merging that shape needs a policy-level change (e.g.
  number-anchored matching), which is NOT made here.

## Consequences

- Photos appear on published posts whose source item carries an
  image URL and whose rendered text fits a caption; everything else
  is unchanged text. No R2, no new tables, no migration.
- The bridge pass may approve fewer than 5 drafts when the cap or
  the guide lane defers the rest; deferred drafts stay `ready`.
- The near-dup scan starts comparing real titles for the first
  time; pairs as dissimilar as the $3.79B titles stay distinct
  under nd1 by design.
- New report counts on the bridge: `deferredGuideLane`,
  `deferredCategoryCap` (logged by the cron).
