# ADR-0070 — Gemini as ADMIN: the Soul rewrite stage (Workers AI raw extraction only)

- **Status:** Accepted — implemented in PR #31 (flag default OFF; NO merge/deploy without owner go-ahead; go-live still requires a proven live rewrite, §10).
- **Date:** 2026-11-22.
- **Owner orders:** 2026-11-22 ~11:49 — «جمنای تست بکن دیگه! و نباید فقط بک اپ باشه! جمنای باید ادمین باشه!»; 2026-11-22 ~11:52 — the Soul and personality belong ONLY to Gemini from now on; Workers AI (gemma/qwen) are sub-agents doing RAW extraction only (ingest sources, extract raw facts/claims/headlines — NO Soul voice, NO rewrite); Gemini fixes them up, organizes, and REWRITES them in the Soul voice, producing the final post; the deterministic pipeline then sends that final post to the channel (gates/caps/fact-guard unchanged; the model does not decide publication).
- **Supersedes:** the review/score/veto reading of the admin stage (the 2026-11-21 verdict). The admin stage is a REWRITE stage: Gemini is the SOLE author of the final post. It also corrects the placement PR #27 made (ADR-0066 put Soul v1 into the Workers AI draft prompt — that placement is now wrong for Workers AI).

## 1. Measured live evidence (Step 1, 2026-11-22 08:23–08:49 UTC)

The live test forced the ladder to Gemini by temporarily exhausting the
workers-ai budget row (owner-authorized; restored exactly afterwards:
requests=56, input_tokens=28244, output_tokens=65504,
updated_at=1795334882860 — verified; gemini row stays requests=0, all
attempts refunded). Test job 5fc5abf6 (prepare_draft, "Farland Saga"),
window closed with a clean deploy (Version ID
5bac5743-ad50-4f3b-a5a9-f66c61e94fb3, v1.47.0 / 5bc1a98, flags off).

- **Direct Gemini: FAILED.** Two runs (08:25, 08:30 UTC), all three models
  (3.5-flash-lite, 3.1-flash-lite, 3.8-flash): `transient_failure`,
  durationMs 0 — the fetch throws/rejects in under 1 ms, NO HTTP
  response ever arrived (no 401/403/429). The API key was NEVER validated.
- **Relay (backup account): FAILED as a Gemini path.** Relay
  `https://pixel-gemini-relay.v1e6oq1ou912z3lucc.workers.dev` is itself
  healthy (wrong path → 404; no key → 400 in 0.59 s), but relay→Google
  returns 502 `upstream unreachable` after ~4.7 s (the relay's egress
  cannot reach Google either). And pixel→relay ALSO fails in 0 ms —
  no network round-trip at all (a reached relay would show ~4700 ms).
  VM→Google direct returns HTTP 400 in 0.89 s (dummy key): Google is up
  and non-Cloudflare egress is fine.
- **The duration measurement is sane:** gemma successes in the same
  window show latency 32128/34350 ms and a deadline failure 59900 ms —
  so the Gemini 0 ms is real, not a clock artifact. The RSS fetcher
  (same bound `globalThis.fetch`, same queue context) works, so the
  failure is specific to the Gemini adapter's fetch — its cause is
  undiagnosed (see §8: this ADR adds the transport error NAME to the
  attempt log so the next failure is diagnosable).
- **Quota: UNKNOWN.** No 429 was ever observed from any caller, so the
  per-project RPD is still unknown. The key's validity is still unknown.
- **The `budget_denied` terminal reason is an artifact:** it comes from
  the workers-ai authorization denial (`sawQuotaDenial`), NOT a Gemini
  quota denial — the prepare-draft handler maps it to
  `editorial_budget_exhausted` and dead-letters the job.

**Consequence (honest):** Gemini has NO working path today (direct
fails, relay fails). This stage therefore ships behind a flag
(default OFF) and is INERT until a Gemini path works. Go-live requires
a proven live rewrite (a real rewritten draft in D1), not just a ladder
attempt. Turning the stage on with a broken path halts publishing
(every draft waits un-rewritten — §5), so the flag must never be
flipped on a hope.

**Diagnosis outcome (Step 1, 2026-11-27 — OUR BUG, FIXED):** the 0 ms
failure was NOT a Cloudflare-egress block. workerd does not implement
`redirect: 'error'` in `fetch` — it throws a synchronous `TypeError:
Invalid redirect value, must be one of "follow" or "manual"`, before
any network I/O. Both the Gemini adapter
(`src/adapters/ai/gemini-adapter.ts`) and the relay worker passed
`redirect: 'error'`; the RSS/safeFetch path already used
`redirect: 'manual'`, which is why it worked in the same worker. Fixed
in both places (`redirect: 'manual'`; explicit 3xx → transient, never
followed); proven by a local workerd reproduction (before: `transient`
in 0–1 ms; after: the fetch reaches real network I/O). The relay's
`502 upstream unreachable` was the same bug (its catch converts any
upstream throw into 502) — the relay SOURCE is fixed in this PR, but
the DEPLOYED relay still needs a redeploy from the backup account. The
~4.7 s wall time on that call is not explained by the throw itself
(likely caller-side round-trip/cold start — open observation). Key
validity and a real 200 + live rewrite STILL need the post-deploy live
test — the go-live criterion (§10.1) is NOT yet met.

## 2. Architecture — two stages, deterministic publish unchanged

```
sources → [RAW EXTRACTION: Workers AI gemma/qwen, prompt v3]
        → raw draft (headline + summary + claims, NO Soul form)
        → [SOUL REWRITE: Gemini only, prompt v1]
        → final draft (Soul voice + soulForm, claims byte-identical)
        → bridge → auto-gate → scheduler → render → channel
```

- **Stage A — raw extraction.** The existing draft ladder (gemma-4-26b →
  qwen3.8-27b) with the draft prompt v3 (§3). It extracts only: a plain
  factual Persian headline, a plain factual Persian summary, and the
  model claims (each with evidenceIds). No voice, no form, no
  category/trust choice. The existing budget/breaker/deadline/circuit
  machinery is untouched.
- **Stage B — Soul rewrite.** A NEW service (`AiRewriteService`,
  `src/application/ai/rewrite-service.ts`) that calls ONLY Gemini — no
  Workers AI fallback for the final text (the raw models must never
  author the final post). It reuses the existing plumbing: the gemini
  port (`createGeminiAdapter`), the per-provider budget store
  (authorize / record usage / refund), the durable AI circuit breaker,
  the 60 s wall deadline, and `ai_runs` with task `'news_rewrite'`
  (its own deterministic id namespace — the draft ladder's
  `aiRunIdForAttempt` is per job+input for `news_draft` and must not
  collide with rewrite runs).
- **Deterministic publish UNCHANGED.** The bridge, the ag1 auto-gate,
  the scheduler, the render, the caps, and the fact-guard are untouched
  except for the two narrow seams in §5 (rewrite deferral in the bridge)
  and §4 (the in-place field replacement, which downstream already
  reads). A model NEVER decides to publish: the rewrite only produces
  text; the gate + bridge + scheduler decide publication exactly as
  today.

## 3. The Soul move — prompt v3 (raw) + rewrite prompt v1 (Soul)

- **Draft prompt v2 → v3** (`src/domain/ai/prompt.ts`,
  `AI_PROMPT_VERSION` `pixel-news-draft-v2` → `pixel-news-draft-v3`).
  Rules 6–7 (Soul v1 voice + form) LEAVE the draft prompt; the output
  schema drops `categoryEmoji` / `trustLabel`. The prompt becomes
  raw-extraction-only: plain factual Persian, headline + summary +
  claims, evidenceIds ⊆ the provided evidence, no Telegram HTML, no
  publishing. Prompt v2 stays readable history (the version is stamped
  on every ai_run, so a v2/v3 mix is always attributable).
- **Mapper** (`src/domain/editorial/mapper.ts` `buildDraftDocument`):
  `document.soulForm` becomes OPTIONAL — absent is the honest raw shape
  for prompt-v3 drafts (never backfilled, never invented for old
  drafts). The rewrite writes it (§4). `schemaVersion` stays 1; no
  migration; schema 11 untouched.
- **Rewrite prompt v1** (NEW `src/domain/ai/rewrite-prompt.ts`,
  `AI_REWRITE_PROMPT_VERSION = 'pixel-news-rewrite-v1'`). The system
  prompt carries the Soul v1 rules — register (clean conversational
  Persian «می‌شه»/«نمی‌تونن», «تو» address, third-person fact body),
  controlled hype, anti-clickbait, no fabricated personal experience,
  Iranian angle (Soul §1–§2), the fixed form (one-line title +
  category emoji, trust label right after the title, `⏺` separator,
  blockquote for background — Soul §3), and the intensity dial
  (Soul §5: LOW-TO-MEDIUM — facts NEVER rewritten, only voice/order).
  The user message carries the RAW draft as data (headline, summary,
  claims — each labeled, wrapped as untrusted data like the draft
  prompt's evidence sections). Output schema (zod):
  `{"headlineFa": string, "summaryFa": string, "categoryEmoji":
"🔴|🚨|🏆|🎮|🟢|🔵", "trustLabel":
"#رسمی|#تأییدشده|#گزارش‌شده|#شایعه|#لیک|#تکذیب‌شده"}` — the same
  enums ADR-0066 introduced, now chosen ONLY by Gemini. The prompt
  forbids: Telegram HTML, the footer (the render adds `👾 @pixellores`,
  never the model), hashtags, any new fact, and any change to a number,
  date, or name.

## 4. The rewrite contract — what Gemini may and may not change

- **Input:** the raw draft document (`headlineFa`, `summaryFa`,
  `modelClaims`, `sourceReport`). **Output:** rewritten `headlineFa` +
  `summaryFa` + `soulForm` (categoryEmoji + trustLabel).
- **The rewrite REPLACES `headlineFa`/`summaryFa` IN PLACE** in
  `document_json`. The raw texts are preserved for audit as additive
  `rawHeadlineFa` / `rawSummaryFa`; the rewrite adds an additive
  `rewrite` block: `{status: 'rewritten', model, promptVersion:
'pixel-news-rewrite-v1', soulVersion, attempts, rewrittenAtMs}`.
  Because downstream (auto-gate, render, scheduler) already reads
  `headlineFa`/`summaryFa`, the rewritten text flows through with NO
  gate/render change. The render-form fix (#4, separate task) will
  consume `document.soulForm` when present.
- **Stored-shape note (implementation, found by the rewrite-draft
  integration test 2026-11-27):** `document_json` is the BARE
  `StoredDraftDocument` — the prepare-draft handler stores
  `canonicalizeJson(document.document)`, not the `{title, document,
facts, warnings}` build wrapper — and every other reader (auto-gate,
  exact-content basis) reads it bare. The rewrite parser and the
  bridge's rewrite-status reader read the bare record directly; an
  earlier version unwrapped a `document` key that never exists in
  stored JSON, which would have rejected every real draft as invalid
  and deferred every draft forever with the flag on.
- **Statuses:** the ADR names `rewritten`/`failed`; the implementation
  adds `'pending'` (a failed invocation that has NOT yet exhausted the
  2-attempt budget, so the spent count survives across job
  generations). The bridge defers ANY status other than `'rewritten'`.
- **Claims are NEVER touched.** The service keeps the stored
  `modelClaims` byte-identical; the rewrite output carries no claims,
  so preservation is structural, not a promise. The stored fact-guard
  report (computed on the raw draft's claims) still covers exactly those
  claims, so it stays valid and is NOT re-run.
- **Claim-preservation guard (pure, lexical, `src/domain/ai/
rewrite-guard.ts`):** every digit-sequence in the rewritten
  headline+summary — Persian/Arabic-Indic digits folded to Latin,
  `٫`→`.`, `٬`→`,` (the ADR-0066 folding, reused) — must occur in the
  raw text (raw headline + raw summary + all claim texts, folded the
  same way). Empty headline/summary or an enum violation also refuses.
  On guard failure: NO document write, the rewrite attempt is recorded
  (ai_runs, task `news_rewrite`), typed refusal. This is a bounded
  lexical check (numbers/dates), not a truth engine — names are
  constrained by the prompt only (§3), which the ADR records honestly.
- **Rewrite output tokens:** 1024 (headline + summary + two enum
  fields; Gemini 3.5-flash-lite answers are short). Wall deadline 60 s
  (the same `AI_BOUNDS.totalWallDeadlineMs`). Attempts per rewrite
  invocation: the Gemini allowlist order (3.5-flash-lite → 3.1-flash-lite
  → 3.8-flash), each attempt budget-authorized + refunded on
  non-completion exactly like the draft ladder.

## 5. Job, hook, and quota sizing (from the MEASURED unknown quota)

- **New durable job type `rewrite_draft`.** Enqueued at draft creation
  (prepare-draft-handler, immediately after `commitEditorialResult`
  succeeds) when `AI_GEMINI_REWRITE_ENABLED` is on. The job carries
  only the draft id — all state is read from D1. The handler loads the
  draft, runs the rewrite service, and commits through a NEW fenced
  store function (WHERE id = ? AND status = 'ready'; the rowcount is
  the authority; `document_json` replaced atomically in the same batch
  as the ai_runs row, following the `commitEditorialResult` pattern).
- **Bridge seam** (`bridgeReadyDrafts`, called from cron Link 4): a new
  `rewriteRequired` input, threaded from the flag. When ON, a draft
  whose `document.rewrite.status` is not `'rewritten'` is DEFERRED
  (new report field `deferredRewrite`, left `ready` — never rejected).
  A draft marked `rewrite.status = 'failed'` is never bridged. When
  the flag is OFF the bridge behaves exactly as today (raw drafts
  publish) — the flag is the kill-switch.
- **Sizing (RPD unknown → conservative + prioritized):** the rewrite
  draws from the SAME gemini budget bucket (scope `'ai'`, budget_key
  `'gemini'`, cap 40/day — `AI_DAILY_REQUEST_ATTEMPT_CAPS`, unchanged).
  At most 5 rewrites per bridge pass (matches
  `AUTO_PUBLISH_BRIDGE_LIMIT`); prioritization is the bridge's own
  order (P1 first, then oldest ready). A draft that is not rewritten
  this pass stays `ready` for a later pass — deferred, never dropped.
- **Quota_denied → defer to the next Tehran-day reset** WITHOUT
  consuming a retry attempt (the engine's existing deferral primitive;
  the handler returns the deferred shape, it does not burn attempts
  retrying every 5 minutes against a dead budget). **At most 2 rewrite
  attempts per draft** (transient / invalid output / guard refusal);
  after the 2nd failure the document is marked
  `rewrite.status = 'failed'` (with the reason code) and the job
  completes — the draft is excluded from auto-publish until a human
  reviews it. The rewrite NEVER falls back to Workers AI for the final
  text; if Gemini is unavailable the draft simply waits un-rewritten.
- **Flags** (`src/shared/config/phase6.ts`): `AI_GEMINI_REWRITE_ENABLED`
  (`'true'` | `'false'`, default `'false'`) — INDEPENDENT of
  `AI_GEMINI_ENABLED` (the ladder fallback gate). The rewrite requires
  BOTH flags on, plus a present key, plus eligibility `partial_free_tier`.
  `AI_GEMINI_ENABLED` stays the ladder gate; `AI_ENABLED` stays the
  master gate. **Policy version** `ai-policy-v2.3` (the failover's
  version, landed as PR #30 — v2.3 is no longer reserved; the rewrite
  rides it and the PROMPT version v3 carries this change) + prompt
  `pixel-news-draft-v3`. **Budget (ai-policy-v2.3):** the rewrite
  authorizes against the EFFECTIVE autonomous cap (gemini 40 − 6
  reserve = 34); a denial inside the reserve window classifies as the
  retryable `budget_pressure` (same midnight deferral as
  `budget_denied`, no rewrite attempt consumed); a denial at the hard
  cap stays the terminal `budget_denied`.

## 6. Transport — the relay, and its hardening follow-up

- The rewrite uses the existing gemini port and `GEMINI_API_BASE_URL`
  (default the official origin; the backup-account relay is the
  operator-configured transport until a working path is proven — a var
  change, not code). The relay (`workers/gemini-relay/`, deployed on
  the backup account as
  `pixel-gemini-relay.v1e6oq1ou912z3lucc.workers.dev`) is a minimal
  pass-through that never stores the key — but it is currently a PUBLIC
  pass-through (no shared secret). **Hardening follow-up (NOT in this
  PR, required before production use):** require a relay shared-secret
  header, stored as a secret on pixel-preview, so the endpoint cannot
  be abused as an open proxy. Until a Gemini path works at all, the
  relay question is moot — the 0 ms pixel→relay failure (§1) is the
  prior problem.
- **Remaining Gemini-path options if the relay retry also stays dead:**
  OpenRouter (needs the owner's API key — he said he will provide it
  later) or a non-Cloudflare proxy. Neither is in this PR.
- **Rebase finding (2026-11-27): the backup REST adapter shipped the
  SAME `redirect: 'error'` bug.** PR #30's
  `workers-ai-rest-adapter.ts` passed `redirect: 'error'` to fetch, so
  the entire failover path was dead on arrival in workerd (every
  backup-account call would fail as `transient` in 0 ms — the same
  signature as §1). Fixed in this PR (`redirect: 'manual'` + explicit
  3xx → `transient`, never followed) with a 3xx regression test, and
  ADR-0069's transport line corrected accordingly. The fix is a
  transport-value correction, not an architecture change: the refusal
  intent (never follow a redirect) is preserved.

## 7. Merge-order caveat

- WS1 (z.ai failover, ADR-0069, in verification) introduces a shared
  ladder builder `ai-ladder.ts`. If WS1 merges first, this rewrite
  service's Gemini-call plumbing must be rebased onto it (the rewrite
  is Gemini-only, so it uses the ladder's Gemini leg, not the full
  ladder). If this PR merges first, WS1 rebases onto it. The ADR
  records the dependency either way; the code must not duplicate the
  ladder's authorization/refund/breaker logic twice. (**Resolved
  2026-11-27: WS1 merged FIRST as PR #30** — this PR rebases onto
  `d3a217a`: the rewrite service builds its candidates through
  `buildAiCandidateLadder` and takes the Gemini leg only, the breaker
  calls are per-provider (`gemini`), and authorization uses the
  effective autonomous cap with `budget_pressure` classification.)

## 8. Diagnostic gap fixed in this PR (small, in scope)

- The 0 ms failures are undiagnosable today: the adapter swallows the
  transport error and records only `transient`. This PR adds the
  transport error's stable NAME only (e.g. `TypeError` — no message,
  no URL, no headers, no body) to the `ai.draft.attempt` log line via an
  optional `transportErrorName` on the transient outcome. This is
  consistent with ADR-0017 (error name + stable code + HTTP status
  only) and makes the rewrite stage — and every Gemini call —
  debuggable the next time it fails.

## 9. What this PR does NOT do

- No render change (the render reads `headlineFa`/`summaryFa` as
  before; fix #4 owns the Soul form in the render). No OpenRouter. No
  failover. No migration (all rewrite state is additive `document_json`
  fields; `schemaVersion` stays 1; schema 11 untouched). No change to
  the ladder, the auto-gate, the caps, or the fact-guard. No
  merge/deploy (owner go-ahead required, as always).

## 10. Go-live conditions (NOT in this PR)

1. A working Gemini path proven by a LIVE REWRITE (a real rewritten
   draft in D1 — not just a ladder attempt).
2. The relay shared-secret hardening (§6), if the relay is the path.
3. The owner flips `AI_GEMINI_REWRITE_ENABLED` (and
   `AI_GEMINI_ENABLED`) in a controlled window; the first rewritten
   posts are verified in the channel before regular posting resumes.

## 11. Tests

- Unit: rewrite prompt byte-pinned (v1); claim-preservation guard
  (digit-folding cases incl. the `۳٫۷۹` → `3.79` case; a rewritten
  number not in the raw text refuses); rewrite service with a fake
  gemini port (success; guard refusal; quota_denied deferral; breaker
  open; flag off = zero calls); mapper (`soulForm` absent for raw
  drafts; present after rewrite); bridge (`rewriteRequired` skips
  un-rewritten drafts, `deferredRewrite` counted, failed rewrites
  never bridged); config (new flag parses, default `false`); prompt v3
  byte-pinned (no Soul rules, no category/trust fields).
- Unit (v2.3 rebase): reserve-window denial (34 charged) classifies
  as retryable `budget_pressure`; hard-cap denial (40 charged) stays
  `budget_denied`; the backup REST adapter sends `redirect: 'manual'`
  and maps 3xx to `transient` (regression test for the
  `redirect: 'error'` workerd bug).
- REAL-D1 (registered in `test:db`): the fenced document update
  (rowcount authority; a non-ready draft refuses with zero writes);
  the rewrite job handler end-to-end over a real draft (fake port),
  including the `budget_pressure` deferral (34 charged → retry at the
  next Tehran midnight, no document write, one failed `news_rewrite`
  row with error `budget_pressure`).
- Gate: `npm run check` green (the repo's full gate).
