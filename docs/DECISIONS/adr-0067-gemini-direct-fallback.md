# ADR-0067 — Wire the Gemini direct fallback (ai-policy-v2.2.1)

## Status

Accepted. Implements the owner order of 2026-11-21: Gemini stays a fallback
AND a strong option (it was never removed — it was never wired). The flag
`AI_GEMINI_ENABLED` ships `false` in every environment; the live test (one
direct call + the AI Studio limits check) is what flips it, after this
change merges and deploys. No reviewer/editor stage is built here and no
model decides to publish — publishing stays deterministic.

## Context

- The Gemini adapter (`src/adapters/ai/gemini-adapter.ts`,
  `createGeminiAdapter`) has existed since Phase 6 (ADR-0041) with zero
  callers: both port-construction sites (the jobs engine and the Telegram
  webhook's inbound rewriter) build only the Workers AI port, and the
  versioned eligibility marked Gemini `unverified_free_tier`, so every
  ladder skipped it even if the operator flag were on.
- Eligibility doc-check, 2026-11-21 (official ai.google.dev docs): a Free
  tier EXISTS (per-project limits, reset midnight Pacific), but the official
  page publishes NO fixed free-tier RPM/RPD for the flash-lite models, and
  third-party numbers conflict (1,000 RPD vs 20 RPD). Verdict: PARTIAL —
  the free tier is real, the per-project quota is not established. The
  remaining verification IS the live test, bounded by the 40/day app cap.
- Model research, 2026-11-21 (official ai.google.dev/gemini-api/docs/models):
  `gemini-2.5-flash` is DEPRECATED (auto-routes to 3.5-flash-lite on
  2026-12-01); `gemini-2.5-flash-lite` is NOT deprecated but LEGACY-GATED
  (limited to past users; new projects are steered to 3.5 Flash-Lite /
  Gemini 4 Hydrogen). The shipped allowlist's only Gemini entry was
  therefore legacy-gated.
- The owner also ordered a relay/proxy route for Gemini if the direct call
  is geo-blocked (TradeAgent precedent: Gemini direct is intermittent).
- The planned failover release is v2.3 (its ADR is ADR-0066, still to be
  written after the lost z.ai implementation is re-run). This change must
  NOT take that version number and must NOT rename that release.

## Decision

1. **Wire the port in both construction sites.** `resolveJobsEngine`
   (`src/application/jobs/engine-env.ts`) and the Telegram webhook
   (`src/entrypoints/http/handlers/telegram-webhook.ts`) build the Gemini
   port with `createGeminiAdapter` whenever `GEMINI_API_KEY` is present,
   over the platform `fetch`. The ladder gates are unchanged: the operator
   flag, the key presence, the port, and eligibility must ALL pass before
   any call. The draft service and the inbound rewriter already check the
   flag; the event-relation service gains the same `geminiEnabled` check
   (it previously had no Gemini flag in its config, so it would have used
   Gemini through the shared ports object on eligibility alone — that gap
   is closed here).
2. **Eligibility `unverified_free_tier` → `partial_free_tier`.** The new
   state records exactly what the 2026-11-21 doc-check established: the
   free tier exists; the per-project quota and Persian quality are still
   unverified. `partial_free_tier` counts as eligible in the ladder — the
   operator flag is the opt-in, the 40/day cap is the bound, and the live
   test is the remaining verification. The three services no longer carry
   their own hardcoded `{ workers-ai: true, gemini: false }` defaults;
   they share one `defaultProviderEligibility()` derived from the versioned
   policy (single source of truth).
3. **Model allowlist (ai-policy-v2.2.1):** `gemini-3.5-flash-lite` PRIMARY
   (owner's priority pick and Google's own migration target),
   `gemini-3.1-flash-lite` ALTERNATE, `gemini-3.8-flash` FALLBACK.
   `gemini-2.5-flash` and `gemini-2.5-flash-lite` are REMOVED (deprecated /
   legacy-gated). The Gemini app cap stays 40 attempts/day.
4. **Configurable endpoint.** `GEMINI_API_BASE_URL` (optional, non-secret
   wrangler var, validated fail-closed in `parseAiConfig`): strict
   `https://` URL, no credentials, no query/fragment; default
   `https://generativelanguage.googleapis.com` (unchanged behavior when
   absent). This deliberately relaxes the adapter's "no arbitrary host"
   rule in exactly one direction: the origin is OPERATOR-controlled
   (wrangler vars / deploy-time) — never caller-controlled, never
   model-controlled. It exists so a relay/proxy origin can be used later
   WITHOUT another code change. An invalid present value fails the jobs
   engine closed (`config_invalid`); the webhook path resolves to the
   official default, never to the invalid value.
5. **Policy version `ai-policy-v2.2.1`.** The allowlist changed, so the
   version string changes with it (the version is stamped on attempt
   records; keeping `v2.2` would mis-stamp new-model attempts). A patch
   bump keeps v2.3 free for the failover release — no rename, no
   collision. The failover release then bumps `v2.2.1` → `v2.3`.
6. **ADR-0066 stays free** for the planned failover ADR (v2.3). This ADR
   takes 0067 so nothing in the lost z.ai v2.3 delivery (which claimed
   ADR-0066) collides with it.

## Consequences

- After merge + deploy + flag flip, the ladder is Workers AI gemma →
  qwen → Gemini 3.5-flash-lite → 3.1-flash-lite → 3.8-flash, bounded by
  the 60 s wall, the 3-attempt cap, the per-provider caps (120 / 40),
  the circuit breaker, and charge-on-success refunds (unchanged).
- Until the flag flips, behavior is byte-identical to v2.2: the port is
  built but never called (the ladder still skips Gemini on the flag).
- A relay origin can be set later by the operator alone
  (`GEMINI_API_BASE_URL` var + flag); no code change, no new secret
  handling (the key still travels only in the `x-goog-api-key` header).
- The `eligibility_unverified` deferred reason survives for the
  explicitly-ineligible case (injected `eligibility: false` in tests,
  or a future policy regression) — it is no longer the default.
