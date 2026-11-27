# ADR-0072 — AI image generation for posts without a source photo (Workers AI in-house)

Date: 2026-11-27. Status: Accepted (owner-approved build plan
`pixel-nvidia-image-plan-2026-11-22.md`, 2026-11-22; this ADR records what
was actually built, including two corrections the plan's research got wrong).

## Context

Most posts carry a source photo (ADR-0068 hotlink). The posts that do not
go out as bare text, against the owner rule that every post has a photo.
There is no R2 (owner decision — never used) and no image storage: a
generated image must be built and sent in the same invocation, with the
returned `file_id` cached in `media_assets` after the first send (the
PR #29 pattern). The owner-approved plan (2026-11-22) chose in-house
Cloudflare Workers AI: `flux-1-schnell` primary, SDXL Lightning /
DreamShaper as zero-neuron backups, NVIDIA free tier explicitly excluded
for live publication (test/evaluation only per its terms).

## Decision

1. **In-house only, one model.** The ladder is a single model,
   `@cf/black-forest-labs/flux-1-schnell`, called as
   `env.AI.run(modelId, { prompt, steps: 4 })` — the exact shape the
   installed `@cloudflare/workers-types` types and the official model page
   pin (`{ image?: string }` base64 JPEG out). No NVIDIA, no new vendor,
   no new key, no R2.
2. **The plan's backups are dead — no backup model ships.** Both named
   backups were retired by Cloudflare on 2026-11-20 (two days BEFORE the
   plan was written; the plan's research was stale): SDXL Lightning and
   DreamShaper-8-LCM now return HTTP 410 / error 5028 (Cloudflare
   changelog 2026-11-05). Cloudflare's named replacement,
   `flux-2-klein-9b`, takes a multipart editing input through the binding
   (no verified plain text-to-image call shape), and the only other typed
   plain text-to-image models cost 45x the primary
   (`lucid-origin`: 636 neurons/tile + 12/step = 2,592 neurons per
   1024x1024 image at 4 steps; `phoenix-1.0`: 2,160). A backup that
   costs 45x and can only run ~3x/day inside the free allowance is not
   a backup. The service still iterates a versioned allowlist, so adding
   a verified backup later is a policy-version change, not a redesign.
   The `flux-2-klein-4b/9b` pair are the candidates to verify live.
3. **Neuron math corrected.** The plan says "~173 neurons per image".
   That is wrong: 173 is the number of flux images the 10,000/day free
   allowance buys. The official pricing page bills flux-1-schnell at
   4.80 neurons per 512x512 tile + 9.60 per step, so one 1024x1024
   image at 4 steps costs 4 x 4.80 + 4 x 9.60 = **57.6 neurons** (policy
   rounds to 58). Ten images a day cost ~580 neurons, ~6% of the free
   allowance. The policy table records 58, not 173.
4. **No seed is passed.** The plan asks for a random seed, but the typed
   flux input is `{ prompt, steps? }` — there is no seed parameter (the
   docs examples passing `seed` are stale; one observed live run had the
   seed rejected). The adapter passes `{ prompt, steps: 4 }` only.
   `media_assets.ai_seed` stays NULL for these rows (unseeded
   generation), not a fabricated value.
5. **No dimensions are passed.** The typed flux input takes no
   width/height, so the plan's 16:9 (1344x768) vs 1:1 (1024x1024) choice
   cannot be expressed on the primary; flux output is its default
   square. The prompt builder still records the intended aspect and the
   adapter passes dimensions only to models whose typed input accepts
   them (none in v1).
6. **Separate image budget, never the text budget.** The existing
   `budgets` table (scope `ai`) gains the key `workers-ai-image`:
   max **10 image attempts/day** and max **2,000 image neurons/day**
   (Tehran day bucket), charged atomically BEFORE each attempt with the
   text path's charge-on-success + refund discipline (a failed attempt
   refunds both the attempt and its neuron estimate). The text keys
   (`workers-ai`, `gemini`) are untouched.
7. **Separate circuit breaker, same code.** The image service reuses
   `ai-circuit-breaker.ts` with its own scope `'image'` — settings key
   `ai.circuit_breaker.image` (threshold 5, cooldown 15 min) — so image
   failures can never open a text breaker and vice versa. (Merged onto
   the v2.3 per-provider breaker family from ADR-0069: the image scope
   is one more row in the same `ai.circuit_breaker.*` family, not a
   second key scheme; the key `ai.image_circuit_breaker` from the first
   draft of this ADR was dropped in the merge.)
8. **Only for posts with no source photo; illustrative only; disclosed.**
   The scheduler tries generation ONLY when the editorial photo
   resolution finds no source image (`photo_no_image`). A generated
   image never replaces a real photo. The prompt is built from the
   headline's Latin tokens + the category scene hint, is English,
   technical and neutral (Soul stays with Gemini/text only), and always
   ends `no text in image, no logo, no watermark`. The caption carries
   the disclosure line `تصویر: ساختهٔ هوش مصنوعی` (the plan's suggested
   wording; the owner may reword it) — a generated image is NEVER sent
   without it: if render text + disclosure does not fit the 1024-unit
   caption envelope, the post goes out as text. The envelope is
   validated BEFORE the service call, so a post that cannot carry the
   disclosure never spends image budget on a generation it cannot use.
9. **Failure never blocks a post.** Any generation failure (budget,
   breaker, quota, provider, deadline, invalid prompt) degrades to the
   text send (or the source-photo send). The image is an enhancement;
   the post is the requirement.
10. **No R2, multipart upload, `file_id` cached.** The generated bytes
    go to `sendPhoto` as a multipart upload (new `sendPhotoBytesRich`
    on the Bot API client; 10 MB cap enforced at the boundary). After a
    successful send the returned `file_id` is saved with the existing
    `markUploaded` transition. Bytes are never stored in D1.
11. **Provenance in D1.** Migration 0012 adds four nullable columns to
    `media_assets`: `ai_provider`, `ai_model`, `ai_prompt`,
    `ai_seed`. Every generation attempt is also recorded in `ai_runs`
    with `task = 'image_generation'` (model, prompt version, input
    hash of the prompt, status, latency, error code). Prompts are never
    logged.
12. **Album rule (plan §6).** At most ONE generated image per post.
    A generated image NEVER enters an album in v1: the album-document
    path is untouched, and the editorial multi-photo album (2-4 real
    source photos, real-first, caption on ordinal 0) sends real photos
    only. Mixing real + generated (real-first, generated-last, AI
    image marked in the caption) is ALLOWED by the plan but has no
    defined trigger — auto-appending a generated image to a real-photo
    album would change post composition without owner direction, so it
    is NOT auto-wired; the pure assembler
    (`src/domain/media/post-album.ts`) pins the ordering for the
    follow-up that wires it (see OD-019). The editorial album path
    reuses the album evidence machinery (`evaluateAlbumDeliveryEvidence`)
    for crash recovery, so a recorded multi-photo delivery heals
    instead of re-sending.
13. **Fail-closed flag.** `AI_IMAGE_ENABLED` (default `"false"` in
    both envs, independent of `AI_ENABLED`) gates the whole surface:
    off = zero provider calls, zero budget writes, zero binding
    access, and the scheduler behaves exactly as before (text fallback).
    The cron wires the service only when the flag is `"true"` AND the
    `AI` binding is present. The media-group seam stays unwired in cron
    (as today): an editorial album due without the seam falls back to
    its first photo as a single photo, never a throw, never a lost post.

## Consequences

- A no-photo post can now carry a generated photo; every other post is
  byte-identical to before.
- Worst-case image spend: 10 attempts/day, 580 neurons/day at flux
  prices — inside the free allowance, and inside the text budget's
  shadow (text uses ~11 neurons/call; the shared 10,000/day allowance
  is not an app counter, the app caps are).
- Live verification still owed (no live inference in-repo): one
  controlled single post with a generated image, the first live neuron
  measurement (confirm ~58/image), and the `seed`-less call shape.
  If flux ever rejects the call, the post still goes out as text.
- Schema 11 -> 12 (migration 0012, append-only). App 1.47.0 -> 1.48.0.
- Merge note (2026-11-27): this ADR was first drafted as ADR-0069 on
  base 5bc1a98; while it was in review, main moved to d3a217a (PR #30,
  the v2.3 backup-account failover), which took ADR-0069 and OD-012 for
  itself. This ADR was renumbered to 0070 and its open decision to
  OD-019, and the image breaker was merged onto the v2.3 per-provider
  breaker family (scope `'image'`, key `ai.circuit_breaker.image`)
  instead of a second key scheme. No decision changed, only numbers
  and the breaker key string. On rebase onto f5d5570 (PR #32, the
  render v3 + multi-photo album), main had taken ADR-0070 (Gemini as
  ADMIN, PR #31) and ADR-0071 (render v3, PR #32) and OD-019..018, so
  this ADR was renumbered again to 0072 and its open decision to
  OD-019. No decision changed, only numbers.
