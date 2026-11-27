/**
 * Versioned AI model/prompt policy (Phase 6 — ADR-0041).
 *
 * IMMUTABLE, VERSIONED ALLOWLIST — application policy over explicit model
 * IDs only. The literal "auto" is never a model id and unknown models from
 * any provider catalog are never trusted. New candidates enter ONLY as a
 * new policy version after current public official model/pricing docs have
 * been verified (a public-doc fetch failure is NOT proof of eligibility).
 *
 * Candidate CF ids evaluated for this version (round 1.10.6 instruction):
 * @cf/meta/llama-3.1-8b-instruct-fp8, @cf/qwen/qwen3-30b-a3b-fp8,
 * @cf/meta/llama-3.3-70b-instruct-fp8-fast. Per the instruction's "small
 * verified compatible allowlist, preferably a lightweight default plus one
 * alternate", THIS version ships the lightweight 8B default plus the Qwen3
 * alternate; the 70B-fast candidate intentionally stays out of the active
 * list. Gemini (ai-policy-v2.2.1, ADR-0067): the trio
 * gemini-3.5-flash-lite (primary) / gemini-3.1-flash-lite (alternate) /
 * gemini-3.8-flash (fallback). gemini-2.5-flash is DEPRECATED (auto-routes
 * to 3.5-flash-lite on 2026-12-01) and gemini-2.5-flash-lite is
 * LEGACY-GATED (past users only) — both removed. Eligibility is PARTIAL
 * (see AI_PROVIDER_ELIGIBILITY_V2): official docs verified 2026-11-21
 * that a Free tier exists, but the per-project quota is unpublished, so
 * the operator flag is the opt-in and the 40/day cap is the bound.
 *
 * SUPERSEDED (ai-policy-v1, 2026-11-20): Cloudflare retired BOTH v1
 * Workers AI ids on 2026-11-20 (the catalog lists
 * `planned_deprecation_date: 2026-11-20` for each). ai-policy-v2 replaces
 * them with @cf/google/gemma-4-26b-a4b-it (primary) and
 * @cf/qwen/qwen3.8-27b (alternate). Both v2 ids were verified live on
 * 2026-11-20 via the Cloudflare Workers AI models endpoint (catalog
 * lookup, Text Generation, no deprecation date, no paid-plan gate) AND a
 * live inference call each (HTTP 200, success true). glm-5.3 was
 * considered and NOT adopted: the catalog marks it require_workers_paid.
 *
 * ai-policy-v2.1 (2026-11-21) — deadline policy fix, models unchanged.
 * Live evidence 2026-11-21: ALL 22 ai_runs for task news_draft failed
 * with deadline_exceeded under the v2 15 s wall (gemma ~14.9 s each;
 * qwen fallback attempts starved at 113 ms–2 s by the already-consumed
 * wall). Live latency probe the same day (real draft workload via the
 * Cloudflare AI API): gemma max_tokens=768 → 16.5 s; gemma
 * max_tokens=384 → 11.6 s; qwen max_tokens=384 → 13.2 s. Both models
 * max out whatever token budget they get, so the output bound drops
 * 768 → 384 (Persian news drafts need ~150–250 words) and the wall
 * deadline rises 15 s → 60 s: a typical invocation is one primary
 * attempt (~12 s), worst case primary + fallback (~25 s) — 60 s covers
 * it with headroom. The workers-ai daily attempt cap rises 40 → 120
 * (12–18 posts/day × up to 2 attempts + retries + test windows); the
 * v2 cap of 40 was exhausted by the deadline failures (33/40 burned
 * before any draft succeeded).
 *
 * ai-policy-v2.2 (2026-11-21) — output-parse root-cause fix, models
 * unchanged. Live evidence 2026-11-21: the v2.1 15 s wall was a
 * SYMPTOM, not the cause. A live REST probe of gemma-4-26b (same input
 * shape `{ messages, max_tokens: 384 }`, HTTP 200 in ~8 s) returned an
 * OpenAI-compatible `chat.completion` — `result.choices[0].message
 * .content` held a valid complete Persian JSON answer while
 * `reasoning_content` held the model's thinking — but the adapter only
 * understood a raw string or `{ response }`, so EVERY successful model
 * answer became `transient`, the ladder fell through to qwen, the run
 * ended `provider_unavailable`, and the endless retry burned the
 * 120/120 daily budget. The probe also shows why 384 tokens is too
 * small: for a one-sentence title the model spent 375/384 tokens
 * (usage: neurons 10.77, completion_tokens 375 of 384) — mostly
 * thinking — so with the real (longer) draft prompt it spends the whole
 * budget on thinking and `content` comes back empty/truncated, which
 * after the parse fix would surface as `invalid_output`. The output
 * bound therefore rises 384 → 2048: real drafts need ~300–600 content
 * tokens plus thinking headroom. The 60 s wall still covers worst-case
 * primary + fallback, and neuron cost stays well under the 10,000/day
 * free cap (~11 neurons/call at 384 tokens).
 *
 * ai-policy-v2.2.1 (2026-11-22, ADR-0067) — Gemini direct-fallback
 * wiring, models only (bounds unchanged). The allowlist's Gemini entry
 * moves from the legacy-gated gemini-2.5-flash-lite to the trio above
 * (official ai.google.dev/gemini-api/docs/models, 2026-11-21). Patch
 * bump, not v2.3: v2.3 stays reserved for the failover release, which
 * then bumps v2.2.1 → v2.3. The version string changes because it is
 * stamped on attempt records — keeping v2.2 would mis-stamp
 * new-model attempts.
 * ai-policy-v2.3 (2026-11-22) — backup-account failover + budget
 * pressure governance, models unchanged. Adds the DISTINCT provider key
 * `workers-ai-backup`: the SAME two Workers AI model ids reached over
 * the official Workers AI REST API on the BACKUP Cloudflare account
 * (`POST /client/v4/accounts/{BACKUP_CF_ACCOUNT_ID}/ai/run/{model}`)
 * from the ONE primary worker — no second worker, no second D1, no
 * AI Gateway, no R2 (ADR-0069). The key exists so per-account budget
 * rows, per-account circuit breakers, and per-account refunds can never
 * mix: a denial on `workers-ai` skips only `workers-ai` candidates and
 * the ladder falls through to the backup account's own 120/day
 * allowance. Cap 120 mirrors the primary (both accounts share the same
 * free neuron allowance). Failover triggers ONLY on authorization
 * denial (or a provider quota_denied) — NEVER on an open circuit
 * breaker (a broken provider PATH must not burn the backup on the same
 * defect). Switch-back is automatic at the Tehran day change: every
 * invocation walks the static ladder from the top and the primary cap
 * replenishes at midnight — there is no switch state. The operator
 * kill switch `AI_FAILOVER_ENABLED` defaults OFF, and the backup port
 * is built ONLY when the flag is on AND the backup secret/var are
 * present (fail-closed: absent pieces = today's behavior exactly).
 * Budget pressure governance (before the 120 hard cap): a WARNING at
 * 96 charged attempts (80%) and a RESERVE of the last 6 units of each
 * account's cap — the autonomous chain stops at the effective cap
 * (cap − reserve) and defers typed `budget_pressure` (retryable)
 * instead of riding to the terminal hard denial, leaving bounded
 * headroom against accounting drift and one-shot operator probes.
 */

import type { AiProvider } from './types';

/** Version marker for the shipped allowlist/eligibility set. */
export const AI_POLICY_VERSION = 'ai-policy-v2.3';

/** Version marker for the shipped prompt contract (see ./prompt.ts).
 * v2 (ADR-0066): the Soul v1 voice rules + the category-emoji/trust-label
 * output fields. v1 prompts are still readable history — the version is
 * stamped on every ai_run, so a v1/v2 mix is always attributable. */
export const AI_PROMPT_VERSION = 'pixel-news-draft-v2';

/** Validated, testable application bounds (round 1.10.6 instruction §3). */
export const AI_BOUNDS = {
  /** Public input bound (evidence text total, UTF-8 bytes). */
  maxInputUtf8Bytes: 16 * 1024,
  /** Output token bound passed to providers. */
  maxOutputTokens: 2048,
  /** TOTAL wall deadline for one service invocation (all attempts/fallbacks). */
  totalWallDeadlineMs: 60_000,
  /** Maximum provider attempts per service invocation. */
  maxProviderAttempts: 3,
  /** Evidence snippet count bounds. */
  minEvidenceCount: 1,
  maxEvidenceCount: 8,
} as const;

/** Role of a model inside the fallback ladder. */
export type AiModelRole = 'primary' | 'alternate' | 'fallback';

/** One immutable allowlist entry. */
export interface AiModelRecord {
  readonly modelId: string;
  readonly provider: AiProvider;
  readonly role: AiModelRole;
  /**
   * Gemini entries additionally require verified Free-tier eligibility
   * (AI_PROVIDER_ELIGIBILITY_V2); `requiresEligibility` is false only for
   * the Workers-AI binding path, whose gate is the binding + flag itself.
   */
  readonly requiresEligibility: boolean;
}

/**
 * The ONLY models this policy version may call, in ladder order:
 * Workers AI primary → Workers AI alternate → Workers AI BACKUP primary
 * → Workers AI BACKUP alternate → (conditional) Gemini.
 *
 * The backup entries (ai-policy-v2.3) carry the SAME model ids as the
 * primary account: the backup account's ladder is the same ladder one
 * account over. They gate on the REST port being WIRED (the
 * `AI_FAILOVER_ENABLED` flag + the backup secret/var present at the
 * wiring sites) — the `requiresEligibility` gate stays false because
 * the backup path's proof is the port itself, exactly like the binding
 * path's proof is the binding.
 */
export const AI_MODEL_ALLOWLIST_V2: readonly AiModelRecord[] = [
  {
    modelId: '@cf/google/gemma-4-26b-a4b-it',
    provider: 'workers-ai',
    role: 'primary',
    requiresEligibility: false,
  },
  {
    modelId: '@cf/qwen/qwen3.8-27b',
    provider: 'workers-ai',
    role: 'alternate',
    requiresEligibility: false,
  },
  {
    modelId: '@cf/google/gemma-4-26b-a4b-it',
    provider: 'workers-ai-backup',
    role: 'primary',
    requiresEligibility: false,
  },
  {
    modelId: '@cf/qwen/qwen3.8-27b',
    provider: 'workers-ai-backup',
    role: 'alternate',
    requiresEligibility: false,
  },
  {
    modelId: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    role: 'primary',
    requiresEligibility: true,
  },
  {
    modelId: 'gemini-3.1-flash-lite',
    provider: 'gemini',
    role: 'alternate',
    requiresEligibility: true,
  },
  {
    modelId: 'gemini-3.8-flash',
    provider: 'gemini',
    role: 'fallback',
    requiresEligibility: true,
  },
];

/**
 * Per-provider eligibility for THIS policy version.
 *
 * 'binding_gated' — usable iff the native binding/flag is present (Workers
 * AI; the binding itself is the account access proof for the binding path).
 * 'unverified_free_tier' — Gemini: documentation availability, account
 * access, Free-tier status and Persian quality are DISTINCT concerns; the
 * key/binding alone proves none of them, so the fallback stays OFF until an
 * operator round verifies current official Free-tier docs and records the
 * verification. Unknown eligibility => typed deferred, zero network.
 * 'partial_free_tier' — Gemini (ADR-0067): the operator round of
 * 2026-11-21 verified from current official docs that a Free tier
 * EXISTS, but the per-project quota (and Persian quality) stay
 * unverified. The fallback is usable ONLY when the operator explicitly
 * flips AI_GEMINI_ENABLED (the flag is the opt-in) and stays bounded by
 * the 40/day app cap; the live test is the remaining verification.
 */
export const AI_PROVIDER_ELIGIBILITY_V2: Readonly<
  Record<AiProvider, 'binding_gated' | 'unverified_free_tier' | 'partial_free_tier'>
> = {
  'workers-ai': 'binding_gated',
  // ai-policy-v2.3: the backup REST path's access proof is the wired
  // port itself (flag + secret + account id at the wiring sites) — the
  // same 'binding_gated' family as the primary binding path.
  'workers-ai-backup': 'binding_gated',
  gemini: 'partial_free_tier',
};

/**
 * Default per-provider eligibility derived from THIS policy version —
 * the single source of truth for the three AI services (draft,
 * event-relation, inbound rewriter). A future `verified_free_tier`
 * state must extend this mapping; unknown eligibility stays `false`.
 */
export function defaultProviderEligibility(): Record<AiProvider, boolean> {
  return {
    'workers-ai': AI_PROVIDER_ELIGIBILITY_V2['workers-ai'] === 'binding_gated',
    'workers-ai-backup': AI_PROVIDER_ELIGIBILITY_V2['workers-ai-backup'] === 'binding_gated',
    gemini: AI_PROVIDER_ELIGIBILITY_V2.gemini === 'partial_free_tier',
  };
}

/**
 * Conservative PER-PROVIDER app request-ATTEMPT caps per Tehran day,
 * charged through the EXISTING budgets table (scope 'ai') BEFORE every
 * call. Units are app request attempts — NOT Cloudflare Neurons, NOT
 * Google quota, NOT an account-wide billing meter. Workers AI free
 * Neurons are SHARED across its models: changing models does not
 * replenish quota, so a shared-quota denial on one CF model skips the
 * other CF model regardless of these app counters.
 */
export const AI_DAILY_REQUEST_ATTEMPT_CAPS: Readonly<Record<AiProvider, number>> = {
  'workers-ai': 120,
  // ai-policy-v2.3: the backup account has the same free neuron
  // allowance as the primary, so the same 120 attempts/day. The cap is
  // per ACCOUNT because the provider key is per account.
  'workers-ai-backup': 120,
  gemini: 40,
};

/**
 * Budget pressure governance (ai-policy-v2.3) — the EARLY thresholds
 * that act BEFORE the 120 hard cap, per account:
 * - WARNING: when a Tehran day's charged-attempt count crosses this
 *   threshold for a provider, the authorizing services log a sanitized
 *   pressure warning (stable event, counts only) — visibility, not
 *   enforcement; the outcome never changes.
 * - RESERVE: the last N units of a provider's daily cap are held back
 *   from the AUTONOMOUS chain (drafting, event-relation, inbound
 *   rewrite authorize against cap − reserve). When the counter reaches
 *   the effective cap the authorization denies and the services defer
 *   typed `budget_pressure` (retryable) instead of the terminal hard
 *   `budget_denied` — the chain degrades EARLY and GRACEFULLY, and the
 *   reserved headroom absorbs accounting drift (the ~3-unit remainder
 *   observed on 2026-11-21) plus one-shot operator probes. The hard cap
 *   itself is unchanged: a non-reserving caller can still spend to 120.
 */
export const AI_BUDGET_PRESSURE_WARNING_REQUESTS = 96;
export const AI_BUDGET_PRESSURE_RESERVE_UNITS = 6;

/** All allowlist entries for one provider, in ladder order. */
export function listModelsForProvider(provider: AiProvider): readonly AiModelRecord[] {
  return AI_MODEL_ALLOWLIST_V2.filter((model) => model.provider === provider);
}

/** True iff the model id is in THIS policy version's allowlist. */
export function isAllowedModel(provider: AiProvider, modelId: string): boolean {
  return AI_MODEL_ALLOWLIST_V2.some(
    (model) => model.provider === provider && model.modelId === modelId,
  );
}
