# ADR-0073 — AI-admin capabilities inside Pixel: Soul rewrite for owner-sent posts

Date: 2026-11-28. Status: Accepted (owner order 2026-11-27 23:39 Tehran:
«قابلیت های ai admin در بات جدید یعنی pixel هست! پیکسل قابلیت هاشو داره
الان یا نه! چک و درست بکن!» — the capabilities belong in Pixel, not in the
old @Ai_admin_IVBot, whose audit was stopped on that correction).

## Context

The owner sends a post to @Pixel_IVbot and expects Pixel to rewrite it in
the Soul voice, fix it (formatting, RTL, links, facts), preview it, and
publish it to @pixellores. What Pixel had on 2026-11-27 (verified in code
and live D1):

- An inbound pipeline (slice 4) that was built but NEVER live-tested: the
  whole owner-send surface was inert live — `ADMIN_POST_ENABLED` and
  `ADMIN_POST_LIVE_PUBLISH_ENABLED` were absent from `env.preview.vars`
  (top-level `vars` are not inherited by environments), so the webhook
  injected `adminPost` / `inbound` as `undefined` and owner messages got a
  `not_a_command` noop. Live D1 confirmed zero rows in every
  `admin_post_*` table, zero `inbound_approvals`, zero `published_posts`.
- An inbound rewriter (`src/application/inbound/ai-rewriter.ts`) that was
  Workers-AI-first with a Gemini fallback, driven by a STATIC hardcoded
  prompt that never read the D1 Soul. That violates ADR-0070 (Soul belongs
  only to Gemini; Workers AI do raw extraction only) and was gated OFF
  (`AI_ENABLED=false`), so it always deferred to the cleaned text.
- An approval preview with Approve / Reject only — no Edit — and an edit
  of the source message while a preview was pending did nothing
  (`processEdit` looked up `published_posts` only).
- Auto / safe-auto published DIRECTLY, with no preview.
- Inbound formatting had no digit folding, no bold/blockquote structure,
  and the render form #4 (approved 2026-11-22, msg 16) existed only in the
  editorial pipeline, not in the inbound path.
- `GEMINI_API_KEY` IS set on pixel-preview (verified 2026-11-27 via
  `wrangler secret list`), so the Soul rewrite can work live with no
  owner-side action.

## Decision

1. **Soul rewrite for inbound, Gemini ONLY.** The inbound pipeline's
   rewriter is replaced by a Soul adapter over the ADR-0070 rewrite
   service (`src/application/ai/rewrite-service.ts`), which calls ONLY
   the Gemini port (allowlist 3.5-flash-lite → 3.1-flash-lite →
   3.8-flash) over the shared ladder / budget / breaker / deadline
   plumbing. The Gemini attempt loop is extracted into one shared
   generic helper used by both the news-draft method and the new
   `rewriteInboundPost` method — no second ladder, no duplicated
   budget/breaker logic. The old Workers-AI inbound rewriter
   (`src/application/inbound/ai-rewriter.ts`) and its dedicated test are
   RETIRED; the breaker/failover tests that used it as a harness are
   re-pointed at the rewrite service (breaker) and the ladder builder
   (failover — the rewrite service is Gemini-only by design and cannot
   exercise the Workers AI failover leg).
2. **The inbound rewrite does NOT depend on `AI_GEMINI_REWRITE_ENABLED`.**
   That flag is the PIPELINE-draft stage gate; flipping it would make
   the cron bridge REQUIRE rewrites for pipeline drafts and re-stall the
   channel (the bridge-livelock fix depends on it staying off). The
   inbound method gates on `AI_ENABLED && AI_GEMINI_ENABLED && key &&
eligibility` only. The inbound prompt is versioned separately
   (`pixel-inbound-soul-rewrite-v1`) and encodes Soul v1 statically, the
   same way the news prompt does — if D1's Soul ever moves to v2, both
   prompts must be bumped.
3. **Form #4 is the inbound render.** The model returns JSON `{"text"}`
   where `**…**` marks bold spans (headline + main figure) and `> …`
   lines mark blockquotes (quote attribution). A deterministic converter
   turns markers into Telegram entities (bold / blockquote), fail-closed:
   unbalanced or empty markers are stripped, never sent as literal
   `**`, never turned into invalid entities. Persian/Arabic digits fold
   to Latin in the formatter (all paths, rewritten or fallback). The
   footer `👾 @pixellores` is rendered by the formatter, never by the
   model; a model-emitted footer line is dropped.
4. **Entities survive both presentations.** The marker entities are
   carried on the formatted parts. The rich path sends them as entities;
   the classic path renders them as `<b>` / `<blockquote>` HTML. The
   rich decision gains `contentHasEntities`: a rewritten post with
   structure goes rich (the entity-faithful path) even when the source
   message carried no entities. Chunking is entity-aware (entities clamp
   to page boundaries; the page-number prefix shifts offsets; the footer
   never carries entities).
5. **Always-preview.** `processNewInbound` routes through the approval
   preview in every mode except paused (auto / safe-auto no longer
   publish directly). The preview buttons are [✏️ Edit] [✅ Publish]
   [❌ Reject]. **Approve and Send-now are ONE button (Publish).**
   The preview IS the approval: approving publishes immediately.
   There is no held-approved queue for owner posts — a separate hold
   step would strand the post (the preview's token is single-use and
   the service cannot re-show the preview later). If the owner wants a
   distinct hold step, that is a follow-up, not part of this ADR.
6. **Edit = native Telegram message edit.** Tapping ✏️ Edit answers
   with the instruction to edit the original message. Editing the
   source message while a preview is pending re-processes the edited
   text WITHOUT an AI rewrite (the owner's correction is authoritative;
   still cleaned / formatted / preservation-checked against itself),
   updates the approval's stored content + fingerprint, and re-shows
   the preview with fresh tokens. The 24h expiry is NOT extended by an
   edit. The old preview message is left standing: its Publish button
   still publishes the CURRENT stored content (fingerprint-verified),
   only its displayed text is stale.
7. **Flags flipped in `env.preview.vars` only.** `ADMIN_POST_ENABLED`,
   `ADMIN_POST_LIVE_PUBLISH_ENABLED`, `AI_ENABLED`, `AI_GEMINI_ENABLED`
   go `false` → `true`; `APP_VERSION` 1.48.0 → 1.49.0. NOT flipped:
   `AI_GEMINI_REWRITE_ENABLED` (see §2), `AI_IMAGE_ENABLED`,
   `AI_FAILOVER_ENABLED`.
8. **No channel-history memory.** The inbound rewrite input is the
   owner's cleaned text + category only. Soul v1 (statically encoded in
   the prompt) carries the voice; no past-post / story retrieval exists.
   Recorded as an open decision in `docs/OPEN_DECISIONS.md` — if the
   owner wants the rewrite to echo recent channel posts, that is a new
   retrieval feature, not a prompt tweak.
9. **No external fact verification for inbound posts.** The
   preservation guard keeps every supplied fact verbatim (numbers,
   dates, names, URLs, quotes) and the rewrite prompt forbids inventing
   facts. There is no source excerpt attached to an owner-sent post, so
   nothing verifies a claim against an external source. Stated plainly,
   not built.

## Consequences

- The owner-send flow becomes live for the first time: send → Soul
  rewrite → preview (Edit / Publish / Reject) → publish in form #4.
  Live verification needs the owner to send a post to @Pixel_IVbot
  (bots cannot message bots); a precise live-test script ships with the
  PR report.
- The Gemini budget (40/day, effective 34) now also serves inbound
  rewrites; a denied inbound rewrite falls back to the cleaned text
  (never blocks the preview).
- The bridge stall fix is untouched: `AI_GEMINI_REWRITE_ENABLED`
  stays off, so pipeline drafts keep flowing through the bridge fix.
- The admin-post `/post` flow is unchanged (it has its own capture /
  preview / approve surface); the inbound flow is the "just send it"
  path.
