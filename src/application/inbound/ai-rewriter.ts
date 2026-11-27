/**
 * Slice 4 — inbound AI rewriter (ai-policy-v2 ladder, plain-text rewrite).
 *
 * The bounded application service for the inbound rewrite step. It mirrors
 * the draft service's fail-closed discipline (ADR-0041) with a different
 * task: rewrite the owner's CLEANED text in Pixel's voice and return plain
 * text — never a structured draft, never a fabrication.
 *
 * 1. `AI_ENABLED` off/missing/invalid ⇒ typed deferred `ai_disabled` with
 *    ZERO provider calls, ZERO budget writes, ZERO binding access.
 * 2. The request is validated and byte-bounded (≤16 KiB UTF-8) BEFORE
 *    anything else; violations ⇒ typed deferred `input_invalid`.
 * 3. BEFORE any authorization the persistent AI circuit breaker is
 *    consulted (ai-circuit-breaker.ts, durable D1 `settings` state):
 *    while OPEN the service returns typed deferred `circuit_open`
 *    with ZERO provider calls and ZERO charges (retryable later).
 *    EVERY provider attempt requires a SUCCESSFUL DURABLE authorization
 *    through the per-provider budget store BEFORE the call (policy caps).
 *    Denied ⇒ the provider is skipped (a CF denial skips ALL remaining CF
 *    models — the same shared provider bucket); store failure ⇒ typed
 *    deferred `budget_store_error`, never mistaken for quota.
 *    Charge-on-success: an attempt that ends WITHOUT a provider
 *    completion (deadline, provider unavailable/transient, auth failure,
 *    or a grant that arrives after the deadline) is REFUNDED best-effort,
 *    one unit, floored at 0 — a refund failure never fails the run. A
 *    provider answer (success or invalid output) keeps the charge; a
 *    denied authorization never charged.
 * 4. Provider order: CF primary → CF alternate → Gemini ONLY if its
 *    independent eligibility is verified (default false — unverified Free
 *    tier stays OFF, zero network). A provider content/safety refusal is a
 *    TERMINAL typed refusal — no model or provider hopping to bypass it.
 * 5. Bounds: ≤3 provider calls, ≤2048 output tokens
 *    (AI_BOUNDS.maxOutputTokens, ai-policy-v2.2), a TOTAL wall deadline
 *    of 60 s bounding the whole invocation. Output must be non-empty plain
 *    text (≤8192 chars); a fenced code block wrapper is stripped.
 * 6. No free path remains ⇒ typed deferred with a stable reason. The
 *    pipeline caller falls back to the cleaned text — NEVER fabricates.
 *
 * Logging is sanitized by construction: only stable event names,
 * provider/model ids, prompt version, outcome kinds and attempt counts.
 */
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  authorizeAiRequestAttempt,
  recordAiUsage,
  refundAiRequestAttempt,
} from '../../adapters/db/ai-budget-store';
import {
  checkAiCircuitBreaker,
  recordAiCircuitBreakerFailure,
  recordAiCircuitBreakerSuccess,
} from '../ai/ai-circuit-breaker';
import { buildAiCandidateLadder } from '../ai/ai-ladder';
import {
  classifyAiBudgetDenial,
  effectiveAutonomousCap,
  noteBudgetPressureWarning,
} from '../ai/ai-budget-pressure';
import {
  AI_BOUNDS,
  AI_DAILY_REQUEST_ATTEMPT_CAPS,
  AI_POLICY_VERSION,
  defaultProviderEligibility,
} from '../../domain/ai/policy';
import type {
  AiChatMessage,
  AiDeferredReason,
  AiProvider,
  AiProviderPort,
} from '../../domain/ai/types';
import type { GamingCategory } from '../../domain/inbound/classifier';
import {
  buildInboundRewriteSystemPrompt,
  INBOUND_REWRITE_PROMPT_VERSION,
} from '../../domain/inbound/rewrite-prompt';

export type InboundRewriteOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly attempts: number }
  | { readonly kind: 'deferred'; readonly reason: AiDeferredReason; readonly attempts: number }
  | {
      readonly kind: 'refused';
      readonly reason: 'provider_safety_refusal';
      readonly attempts: number;
    };

export interface InboundRewriter {
  rewrite(input: {
    readonly text: string;
    readonly category: GamingCategory;
    readonly isCaption: boolean;
  }): Promise<InboundRewriteOutcome>;
}

export interface AiInboundRewriterConfig {
  readonly aiEnabled: boolean;
  readonly geminiEnabled: boolean;
  /**
   * Validated AI_FAILOVER_ENABLED operator kill switch (parseAiConfig,
   * ai-policy-v2.3). Backup candidates run only when this is on AND the
   * backup REST port is wired — BOTH gates fail closed. Optional with a
   * default OFF (the flag's own fail-closed default), so callers that
   * predate failover keep today's behavior exactly.
   */
  readonly failoverEnabled?: boolean;
  readonly workersAiBindingPresent: boolean;
  readonly geminiApiKeyPresent: boolean;
}

export interface AiInboundRewriterDeps {
  readonly executor: DbExecutor;
  readonly ports: Readonly<Partial<Record<AiProvider, AiProviderPort>>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: AiInboundRewriterConfig;
  readonly eligibility?: Readonly<Record<AiProvider, boolean>>;
}

/** Rewritten text bound: the formatter chunks it; this is the sanity cap. */
export const INBOUND_REWRITE_MAX_CHARS = 8192;

/** Default eligibility is the versioned policy (ADR-0067) — see policy.ts. */
function defaultEligibility(): Record<AiProvider, boolean> {
  return defaultProviderEligibility();
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
    return withoutOpen.replace(/\n?```\s*$/, '').trim();
  }
  return trimmed;
}

export function createAiInboundRewriter(deps: AiInboundRewriterDeps): InboundRewriter {
  const eligibility = deps.eligibility ?? defaultEligibility();
  const encoder = new TextEncoder();

  return {
    async rewrite(input): Promise<InboundRewriteOutcome> {
      if (!deps.config.aiEnabled) {
        return { kind: 'deferred', reason: 'ai_disabled', attempts: 0 };
      }
      const text = input.text.trim();
      if (text === '' || encoder.encode(text).length > AI_BOUNDS.maxInputUtf8Bytes) {
        return { kind: 'deferred', reason: 'input_invalid', attempts: 0 };
      }

      // ---- The persistent AI circuit breaker — consulted BEFORE any
      // authorization, so an open breaker means ZERO provider calls and
      // ZERO charges. Checked for the PRIMARY account (per-account
      // breakers, ai-policy-v2.3) after the ladder construction below;
      // an open PRIMARY breaker is typed `circuit_open` and is NEVER a
      // failover trigger. A failed breaker READ fails open (closed): the
      // provider path still has its own budget/deadline guards.

      /** Best-effort refund of THIS attempt's charge (charge-on-success).
       * Refunds are PER PROVIDER KEY (ai-policy-v2.3): a failed backup
       * attempt refunds the backup row only, never the primary row. */
      const refundAttempt = async (provider: AiProvider): Promise<void> => {
        try {
          await refundAiRequestAttempt(deps.executor, {
            provider,
            nowMs: deps.clock.now(),
          });
        } catch {
          deps.logger.warn('ai.inbound_rewrite.refund_failed', { provider });
        }
      };
      /** Best-effort breaker bookkeeping on the CANDIDATE'S OWN account
       * breaker (`ai.circuit_breaker.{provider}` — per account,
       * ai-policy-v2.3). Provider failures only; a failed record never
       * fails the run. */
      const noteBreakerFailure = async (provider: AiProvider): Promise<void> => {
        try {
          await recordAiCircuitBreakerFailure(deps.executor, deps.clock.now(), provider);
        } catch {
          deps.logger.warn('ai.inbound_rewrite.circuit_breaker_record_failed', { provider });
        }
      };
      const noteBreakerSuccess = async (provider: AiProvider): Promise<void> => {
        try {
          await recordAiCircuitBreakerSuccess(deps.executor, deps.clock.now(), provider);
        } catch {
          deps.logger.warn('ai.inbound_rewrite.circuit_breaker_record_failed', { provider });
        }
      };

      const startedAt = deps.clock.now();
      const deadlineAtMs = startedAt + AI_BOUNDS.totalWallDeadlineMs;
      let attempts = 0;
      let providerCalls = 0;
      const skippedProviders = new Set<AiProvider>();
      const sharedQuotaProviders = new Set<AiProvider>();
      const authFailedProviders = new Set<AiProvider>();
      let geminiSkippedIneligible = false;
      let sawProviderAttempt = false;
      let sawHardQuotaDenial = false;
      let sawReservePressure = false;

      // ---- Candidate ladder (the SHARED versioned-policy builder,
      // ai-policy-v2.3): Workers AI primary → Workers AI alternate →
      // Workers AI BACKUP primary → Workers AI BACKUP alternate →
      // (conditional) Gemini. The backup candidates gate on BOTH the
      // operator kill switch AND the wired REST port (fail-closed).
      const ladder = buildAiCandidateLadder({
        workersAiPrimaryPresent:
          deps.config.workersAiBindingPresent && deps.ports['workers-ai'] !== undefined,
        failoverEnabled: deps.config.failoverEnabled === true,
        backupPortPresent: deps.ports['workers-ai-backup'] !== undefined,
        geminiEnabled: deps.config.geminiEnabled,
        geminiKeyPresent: deps.config.geminiApiKeyPresent,
        geminiPortPresent: deps.ports.gemini !== undefined,
        geminiEligible: eligibility.gemini,
      });
      const candidates = ladder.candidates.map((candidate) => ({
        provider: candidate.provider,
        modelId: candidate.modelId,
      }));
      geminiSkippedIneligible = ladder.geminiSkippedIneligible;

      if (candidates.length === 0) {
        const reason: AiDeferredReason = !deps.config.workersAiBindingPresent
          ? 'binding_missing'
          : geminiSkippedIneligible
            ? 'eligibility_unverified'
            : 'no_free_path';
        return { kind: 'deferred', reason, attempts };
      }

      // ---- Gate 3: the PRIMARY account's breaker — only when the ladder
      // contains primary candidates (a missing binding means the primary
      // breaker's stale state must not mask the typed binding_missing or
      // the backup path). An open PRIMARY breaker is NEVER a failover
      // trigger; the BACKUP breaker is checked per candidate below.
      if (candidates.some((candidate) => candidate.provider === 'workers-ai')) {
        try {
          const breaker = await checkAiCircuitBreaker(
            deps.executor,
            deps.clock.now(),
            'workers-ai',
          );
          if (!breaker.allow) {
            deps.logger.info('ai.inbound_rewrite.circuit_open', {
              consecutiveFailures: breaker.snapshot.consecutiveFailures,
              openedAtMs: breaker.snapshot.openedAtMs,
            });
            return { kind: 'deferred', reason: 'circuit_open', attempts: 0 };
          }
        } catch {
          deps.logger.warn('ai.inbound_rewrite.circuit_breaker_check_failed');
        }
      }

      for (const candidate of candidates) {
        if (providerCalls >= AI_BOUNDS.maxProviderAttempts) {
          break;
        }
        if (deps.clock.now() >= deadlineAtMs) {
          break;
        }
        if (sharedQuotaProviders.has(candidate.provider)) {
          continue;
        }
        if (authFailedProviders.has(candidate.provider)) {
          continue;
        }
        // ---- Per-account breaker for the NON-primary providers
        // (ai-policy-v2.3): the PRIMARY breaker was already consulted at
        // gate 3 (an open primary breaker returned `circuit_open` —
        // breaker-open is NEVER a failover trigger). An open BACKUP (or
        // Gemini) breaker skips only THAT provider's candidates and the
        // ladder continues. A failed read fails open (closed).
        if (candidate.provider !== 'workers-ai') {
          try {
            const breaker = await checkAiCircuitBreaker(
              deps.executor,
              deps.clock.now(),
              candidate.provider,
            );
            if (!breaker.allow) {
              continue;
            }
          } catch {
            deps.logger.warn('ai.inbound_rewrite.circuit_breaker_check_failed', {
              provider: candidate.provider,
            });
          }
        }

        let bucketDate: string;
        try {
          const authorization = await authorizeAiRequestAttempt(deps.executor, {
            provider: candidate.provider,
            // ai-policy-v2.3: the autonomous chain authorizes against the
            // EFFECTIVE cap (hard cap − reserve) — the shared reserve.
            cap: effectiveAutonomousCap(AI_DAILY_REQUEST_ATTEMPT_CAPS[candidate.provider]),
            nowMs: deps.clock.now(),
          });
          if (authorization.kind === 'denied') {
            sharedQuotaProviders.add(candidate.provider);
            skippedProviders.add(candidate.provider);
            // ai-policy-v2.3: classify the denial — INSIDE the reserve
            // window is the early, retryable pressure; at the hard cap it
            // stays terminal. Ambiguity falls to HARD.
            const denialKind = await classifyAiBudgetDenial(deps.executor, {
              provider: candidate.provider,
              hardCap: AI_DAILY_REQUEST_ATTEMPT_CAPS[candidate.provider],
              nowMs: deps.clock.now(),
            });
            if (denialKind === 'hard') {
              sawHardQuotaDenial = true;
            } else {
              sawReservePressure = true;
            }
            continue;
          }
          bucketDate = authorization.bucketDate;
          // ai-policy-v2.3: best-effort early pressure warning on the
          // granted charge (visibility only — never changes the outcome).
          await noteBudgetPressureWarning(deps.executor, deps.logger, {
            provider: candidate.provider,
            nowMs: deps.clock.now(),
          });
        } catch {
          deps.logger.warn('ai.inbound_rewrite.budget_store_failed', {
            provider: candidate.provider,
          });
          return { kind: 'deferred', reason: 'budget_store_error', attempts };
        }
        if (deps.clock.now() >= deadlineAtMs) {
          // The grant landed but no provider call started: refund the
          // charge best-effort (charge-on-success).
          await refundAttempt(candidate.provider);
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }

        const port = deps.ports[candidate.provider];
        if (port === undefined) {
          continue;
        }
        providerCalls += 1;
        attempts += 1;
        sawProviderAttempt = true;
        const attemptStartedAt = deps.clock.now();
        const messages: AiChatMessage[] = [
          { role: 'system', content: buildInboundRewriteSystemPrompt(input.category) },
          { role: 'user', content: text },
        ];
        let callOutcome: Awaited<ReturnType<AiProviderPort['complete']>>;
        try {
          callOutcome = await port.complete({
            modelId: candidate.modelId,
            messages,
            maxOutputTokens: AI_BOUNDS.maxOutputTokens,
            deadlineAtMs,
          });
        } catch {
          deps.logger.info('ai.inbound_rewrite.attempt', {
            provider: candidate.provider,
            modelId: candidate.modelId,
            promptVersion: INBOUND_REWRITE_PROMPT_VERSION,
            policyVersion: AI_POLICY_VERSION,
            outcome: 'transient_failure',
            durationMs: deps.clock.now() - attemptStartedAt,
          });
          // No provider completion: refund the attempt and count the
          // provider failure toward THE CANDIDATE'S OWN account breaker.
          await refundAttempt(candidate.provider);
          await noteBreakerFailure(candidate.provider);
          continue;
        }
        const durationMs = deps.clock.now() - attemptStartedAt;
        deps.logger.info('ai.inbound_rewrite.attempt', {
          provider: candidate.provider,
          modelId: candidate.modelId,
          promptVersion: INBOUND_REWRITE_PROMPT_VERSION,
          policyVersion: AI_POLICY_VERSION,
          outcome: callOutcome.kind,
          durationMs,
        });

        switch (callOutcome.kind) {
          case 'refused':
            return { kind: 'refused', reason: 'provider_safety_refusal', attempts };
          case 'deadline_exceeded':
            await refundAttempt(candidate.provider);
            await noteBreakerFailure(candidate.provider);
            return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
          case 'quota_denied':
            // The provider answered with its own quota verdict: no refund
            // and no breaker count. A HARD quota condition (the provider's
            // own pool) — maps to the terminal classification.
            sawHardQuotaDenial = true;
            sharedQuotaProviders.add(candidate.provider);
            skippedProviders.add(candidate.provider);
            break;
          case 'auth_failed':
            // The provider answered with an auth/config failure: refund
            // the attempt, but do not count it toward the breaker.
            await refundAttempt(candidate.provider);
            authFailedProviders.add(candidate.provider);
            skippedProviders.add(candidate.provider);
            break;
          case 'model_unavailable':
          case 'transient':
            await refundAttempt(candidate.provider);
            await noteBreakerFailure(candidate.provider);
            break;
          case 'ok': {
            const rewritten = stripFence(callOutcome.rawText);
            if (rewritten === '' || rewritten.length > INBOUND_REWRITE_MAX_CHARS) {
              // Invalid output — a rejected attempt, never a successful
              // empty/oversized rewrite. The provider answered, so the
              // charge stays and the breaker does not move.
              break;
            }
            try {
              await recordAiUsage(deps.executor, {
                provider: candidate.provider,
                bucketDate,
                inputTokens: callOutcome.usage?.inputTokens,
                outputTokens: callOutcome.usage?.outputTokens,
                nowMs: deps.clock.now(),
              });
            } catch {
              deps.logger.warn('ai.inbound_rewrite.usage_record_failed', {
                provider: candidate.provider,
              });
            }
            // The provider answered: reset THAT account's breaker counter
            // (a half-open probe success closes it) and keep the charge.
            await noteBreakerSuccess(candidate.provider);
            return { kind: 'ok', text: rewritten, attempts };
          }
        }
      }

      const reason: AiDeferredReason =
        authFailedProviders.size > 0
          ? 'provider_auth_failed'
          : sawHardQuotaDenial
            ? 'budget_denied'
            : sawReservePressure
              ? 'budget_pressure'
              : geminiSkippedIneligible && sawProviderAttempt
                ? 'eligibility_unverified'
                : sawProviderAttempt
                  ? 'provider_unavailable'
                  : 'no_free_path';
      deps.logger.info('ai.inbound_rewrite.result', { kind: 'deferred', reason, attempts });
      return { kind: 'deferred', reason, attempts };
    },
  };
}
