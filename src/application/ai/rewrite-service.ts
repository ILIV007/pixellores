/**
 * AI rewrite service (ADR-0070 §2/§4): the Gemini-ONLY Soul rewrite
 * stage. Workers AI NEVER authors the final post — this service calls
 * ONLY the Gemini port (the allowlist trio, in order), over the SAME
 * plumbing the draft ladder uses:
 * - the per-provider budget store (authorize / record usage / refund),
 *   same gemini 40/day bucket — a rewrite never bypasses the shared cap;
 * - the durable AI circuit breaker (shared with drafting);
 * - the 60 s wall deadline, same `awaitWithDeadline` primitive;
 * - `ai_runs` task `'news_rewrite'` (own deterministic id namespace —
 *   the caller records the row; this service only returns attempts).
 *
 * Free-only, fail-closed orchestration:
 * 1. `AI_ENABLED` off OR `AI_GEMINI_REWRITE_ENABLED` off ⇒ typed
 *    deferred (`ai_disabled` / `rewrite_disabled`) with ZERO provider
 *    calls, ZERO budget writes. The rewrite ALSO requires the ladder
 *    gate `AI_GEMINI_ENABLED` on (both flags, plus a present key, plus
 *    `partial_free_tier` eligibility) — a single flag never opens the
 *    stage on its own.
 * 2. The request is validated and byte-bounded BEFORE anything else;
 *    violations ⇒ typed deferred `input_invalid`.
 * 3. The persistent AI circuit breaker is consulted BEFORE any
 *    authorization: while OPEN ⇒ typed deferred `circuit_open` with
 *    ZERO provider calls and ZERO charges.
 * 4. Attempts per invocation: the Gemini allowlist order
 *    (3.5-flash-lite → 3.1-flash-lite → 3.8-flash), each attempt
 *    budget-authorized + refunded on non-completion exactly like the
 *    draft ladder. A provider content/safety refusal is TERMINAL —
 *    never hop models to bypass safety. A guard refusal or invalid
 *    output falls through to the next Gemini model (the RAW models must
 *    never author the final text, so there is no Workers AI fallback).
 * 5. The claim-preservation guard runs on EVERY parsed output BEFORE
 *    success is returned: a guard refusal is a rejected attempt, never
 *    a successful rewrite.
 * 6. No free path remains ⇒ typed deferred with a stable reason and a
 *    known retry boundary when available. No silent drop, no paid
 *    fallback. Per-draft attempt counting (max 2 invocations) lives in
 *    the CALLER (the document's rewrite block) — this service is
 *    stateless across invocations.
 *
 * Logging is sanitized by construction: only stable event names,
 * provider/model ids, prompt version, outcome kinds, attempt counts and
 * clearly-labelled usage metadata ever reach the logger.
 */
import { z } from 'zod';
import type { Clock } from '../../shared/time/clock';
import { awaitWithDeadline, type DeadlineTimeoutScheduler } from '../../shared/time/deadline-wait';
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
} from './ai-circuit-breaker';
import {
  AI_BOUNDS,
  AI_DAILY_REQUEST_ATTEMPT_CAPS,
  AI_POLICY_VERSION,
  AI_REWRITE_MAX_OUTPUT_TOKENS,
  defaultProviderEligibility,
  listModelsForProvider,
} from '../../domain/ai/policy';
import {
  AI_REWRITE_PROMPT_VERSION,
  buildNewsRewriteSystemPrompt,
  buildNewsRewriteUserPrompt,
  type AiRewriteOutput,
} from '../../domain/ai/rewrite-prompt';
import { parseAiRewriteOutputJson } from '../../domain/ai/rewrite-schema';
import { checkRewritePreservesNumbers } from '../../domain/ai/rewrite-guard';
import type {
  AiAttemptRecord,
  AiDeferredReason,
  AiProvider,
  AiProviderPort,
} from '../../domain/ai/types';

const rewriteRequestSchema = z
  .object({
    draftId: z.string().min(1).max(128),
    headlineFa: z.string().min(1).max(200),
    summaryFa: z.string().min(1).max(1000),
    claimTexts: z.array(z.string().min(1).max(500)).max(10),
    sourceName: z.string().min(1).max(200),
  })
  .strict();

export interface AiRewriteServiceConfig {
  /** Validated AI_ENABLED flag (parseAiConfig) — the master gate. */
  readonly aiEnabled: boolean;
  /** Validated AI_GEMINI_ENABLED operator gate (parseAiConfig). */
  readonly geminiEnabled: boolean;
  /** Validated AI_GEMINI_REWRITE_ENABLED stage gate (parseAiConfig). */
  readonly rewriteEnabled: boolean;
  /** Whether a Gemini API key is configured (presence only — never the value). */
  readonly geminiApiKeyPresent: boolean;
}

export interface AiRewriteServiceDeps {
  readonly executor: DbExecutor;
  /** Provider ports keyed by provider — the service reads ONLY `gemini`. */
  readonly ports: Readonly<Partial<Record<AiProvider, AiProviderPort>>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: AiRewriteServiceConfig;
  /**
   * Eligibility view (per provider). Defaults to the versioned policy
   * (ADR-0067: Gemini PARTIAL — the operator flag is the opt-in).
   * Injectable for deterministic tests.
   */
  readonly eligibility?: Readonly<Record<AiProvider, boolean>>;
  /**
   * Deadline scheduler for the bounded waits (same contract as the
   * draft service — production defaults to real setTimeout; tests inject
   * a manual scheduler).
   */
  readonly deadlineScheduler?: DeadlineTimeoutScheduler;
}

/** Successful Gemini rewrite with sanitized usage metadata. */
export interface AiRewriteSuccess {
  readonly kind: 'rewritten';
  readonly rewrite: AiRewriteOutput;
  /** The model that authored the final text (a Gemini allowlist id). */
  readonly modelId: string;
  readonly usage: readonly {
    readonly provider: AiProvider;
    readonly modelId: string;
    readonly promptVersion: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  }[];
  readonly attempts: readonly AiAttemptRecord[];
}

/** Terminal provider safety refusal — never retried on another model. */
export interface AiRewriteRefusal {
  readonly kind: 'refusal';
  readonly provider: AiProvider;
  readonly modelId: string;
  readonly reason: 'provider_safety_refusal';
  readonly attempts: readonly AiAttemptRecord[];
}

/** Typed deferred outcome — the free-only path is exhausted or gated OFF. */
export interface AiRewriteDeferred {
  readonly kind: 'deferred';
  readonly reason: AiDeferredReason;
  /** Known retry boundary in ms (e.g. provider Retry-After); undefined = unknown. */
  readonly retryAfterMs?: number;
  readonly attempts: readonly AiAttemptRecord[];
}

/** The complete outcome surface of the rewrite service. */
export type AiRewriteOutcome = AiRewriteSuccess | AiRewriteRefusal | AiRewriteDeferred;

export interface AiRewriteService {
  rewriteNewsDraft(request: unknown): Promise<AiRewriteOutcome>;
}

function defaultEligibility(): Record<AiProvider, boolean> {
  return defaultProviderEligibility();
}

export function createAiRewriteService(deps: AiRewriteServiceDeps): AiRewriteService {
  const eligibility = deps.eligibility ?? defaultEligibility();
  const encoder = new TextEncoder();
  const systemPrompt = buildNewsRewriteSystemPrompt();

  async function rewriteNewsDraft(request: unknown): Promise<AiRewriteOutcome> {
    // ---- Gate 1: the master flag AND the stage flag are the FIRST
    // decisions, before any work. Either off => zero provider calls,
    // zero budget writes, zero binding access.
    if (!deps.config.aiEnabled) {
      return { kind: 'deferred', reason: 'ai_disabled', attempts: [] };
    }
    if (!deps.config.rewriteEnabled) {
      return { kind: 'deferred', reason: 'rewrite_disabled', attempts: [] };
    }

    // ---- Gate 2: bounded request validation (fail closed, zero side effects).
    const parsedRequest = rewriteRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }
    const { headlineFa, summaryFa, claimTexts, sourceName } = parsedRequest.data;
    const userPrompt = buildNewsRewriteUserPrompt({
      headlineFa,
      summaryFa,
      claimTexts,
      sourceName,
    });
    if (encoder.encode(userPrompt).length > AI_BOUNDS.maxInputUtf8Bytes) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }

    const startedAt = deps.clock.now();
    const deadlineAtMs = startedAt + AI_BOUNDS.totalWallDeadlineMs;

    // ---- Gate 3: the persistent AI circuit breaker — consulted BEFORE
    // any authorization (same contract as the draft service).
    try {
      const breaker = await checkAiCircuitBreaker(deps.executor, startedAt);
      if (!breaker.allow) {
        deps.logger.info('ai.rewrite.circuit_open', {
          consecutiveFailures: breaker.snapshot.consecutiveFailures,
          openedAtMs: breaker.snapshot.openedAtMs,
        });
        return { kind: 'deferred', reason: 'circuit_open', attempts: [] };
      }
    } catch {
      deps.logger.warn('ai.rewrite.circuit_breaker_check_failed');
    }

    const refundAttempt = async (modelId: string): Promise<void> => {
      try {
        await refundAiRequestAttempt(deps.executor, {
          provider: 'gemini',
          nowMs: deps.clock.now(),
        });
      } catch {
        deps.logger.warn('ai.rewrite.refund_failed', { provider: 'gemini', modelId });
      }
    };
    const noteBreakerFailure = async (): Promise<void> => {
      try {
        await recordAiCircuitBreakerFailure(deps.executor, deps.clock.now());
      } catch {
        deps.logger.warn('ai.rewrite.circuit_breaker_record_failed');
      }
    };
    const noteBreakerSuccess = async (): Promise<void> => {
      try {
        await recordAiCircuitBreakerSuccess(deps.executor, deps.clock.now());
      } catch {
        deps.logger.warn('ai.rewrite.circuit_breaker_record_failed');
      }
    };

    const attempts: AiAttemptRecord[] = [];
    let providerCalls = 0;
    let knownRetryAfterMs = 0;

    const record = (
      modelId: string,
      outcome: AiAttemptRecord['outcome'],
      durationMs: number,
      transportErrorName?: string,
    ): void => {
      attempts.push({
        provider: 'gemini',
        modelId,
        promptVersion: AI_REWRITE_PROMPT_VERSION,
        outcome,
        durationMs,
      });
      deps.logger.info('ai.rewrite.attempt', {
        provider: 'gemini',
        modelId,
        promptVersion: AI_REWRITE_PROMPT_VERSION,
        policyVersion: AI_POLICY_VERSION,
        outcome,
        durationMs,
        ...(transportErrorName !== undefined ? { transportErrorName } : {}),
      });
    };

    // ---- Candidate ladder: Gemini allowlist order ONLY. A missing port,
    // a missing key, a disabled ladder flag, or unverified eligibility
    // means NO Gemini path exists — zero network, typed deferred.
    const geminiPort = deps.ports.gemini;
    if (
      !deps.config.geminiEnabled ||
      !deps.config.geminiApiKeyPresent ||
      geminiPort === undefined ||
      !eligibility.gemini
    ) {
      const reason: AiDeferredReason = !deps.config.geminiEnabled
        ? 'no_free_path'
        : !deps.config.geminiApiKeyPresent
          ? 'key_missing'
          : !eligibility.gemini
            ? 'eligibility_unverified'
            : 'no_free_path';
      return { kind: 'deferred', reason, attempts };
    }

    for (const model of listModelsForProvider('gemini')) {
      if (providerCalls >= AI_BOUNDS.maxProviderAttempts) {
        break;
      }
      if (deps.clock.now() >= deadlineAtMs) {
        record(model.modelId, 'skipped_deadline', 0);
        break;
      }

      // ---- Durable authorization BEFORE the attempt (no grant, no call).
      let bucketDate: string;
      try {
        const authWaitStartedAtMs = deps.clock.now();
        const authorizationWait = await awaitWithDeadline(
          authorizeAiRequestAttempt(deps.executor, {
            provider: 'gemini',
            cap: AI_DAILY_REQUEST_ATTEMPT_CAPS.gemini,
            nowMs: authWaitStartedAtMs,
          }),
          deadlineAtMs,
          authWaitStartedAtMs,
          { scheduleTimeout: deps.deadlineScheduler },
        );
        if (authorizationWait.kind === 'timed_out') {
          record(model.modelId, 'skipped_deadline', deps.clock.now() - startedAt);
          deps.logger.info('ai.rewrite.result', {
            kind: 'deferred',
            reason: 'deadline_exceeded',
          });
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }
        const authorization = authorizationWait.value;
        if (authorization.kind === 'denied') {
          record(model.modelId, 'quota_denied', 0);
          // The app budget is exhausted for the Tehran day: no further
          // Gemini model can be authorized — stop the ladder here. The
          // caller defers to the next-day reset WITHOUT consuming a
          // rewrite attempt (ADR-0070 §5).
          deps.logger.info('ai.rewrite.result', {
            kind: 'deferred',
            reason: 'budget_denied',
          });
          return { kind: 'deferred', reason: 'budget_denied', attempts };
        }
        bucketDate = authorization.bucketDate;
      } catch {
        deps.logger.warn('ai.rewrite.budget_store_failed', { provider: 'gemini' });
        return { kind: 'deferred', reason: 'budget_store_error', attempts };
      }

      if (deps.clock.now() >= deadlineAtMs) {
        await refundAttempt(model.modelId);
        record(model.modelId, 'skipped_deadline', 0);
        deps.logger.info('ai.rewrite.result', {
          kind: 'deferred',
          reason: 'deadline_exceeded',
        });
        return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
      }

      providerCalls += 1;
      const attemptStartedAt = deps.clock.now();
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userPrompt },
      ];
      let callOutcome: Awaited<ReturnType<AiProviderPort['complete']>>;
      try {
        const callWait = await awaitWithDeadline(
          geminiPort.complete({
            modelId: model.modelId,
            messages,
            maxOutputTokens: AI_REWRITE_MAX_OUTPUT_TOKENS,
            deadlineAtMs,
          }),
          deadlineAtMs,
          attemptStartedAt,
          { scheduleTimeout: deps.deadlineScheduler },
        );
        if (callWait.kind === 'timed_out') {
          record(model.modelId, 'deadline_exceeded', deps.clock.now() - attemptStartedAt);
          await refundAttempt(model.modelId);
          await noteBreakerFailure();
          deps.logger.info('ai.rewrite.result', {
            kind: 'deferred',
            reason: 'deadline_exceeded',
          });
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }
        callOutcome = callWait.value;
      } catch {
        record(model.modelId, 'transient_failure', deps.clock.now() - attemptStartedAt);
        await refundAttempt(model.modelId);
        await noteBreakerFailure();
        continue;
      }
      const durationMs = deps.clock.now() - attemptStartedAt;

      switch (callOutcome.kind) {
        case 'refused': {
          // TERMINAL typed refusal — never hop models to bypass a
          // content/safety rejection.
          record(model.modelId, 'refused', durationMs);
          deps.logger.info('ai.rewrite.result', { kind: 'refusal', attempts: attempts.length });
          return {
            kind: 'refusal',
            provider: 'gemini',
            modelId: model.modelId,
            reason: 'provider_safety_refusal',
            attempts,
          };
        }
        case 'deadline_exceeded': {
          record(model.modelId, 'deadline_exceeded', durationMs);
          await refundAttempt(model.modelId);
          await noteBreakerFailure();
          deps.logger.info('ai.rewrite.result', {
            kind: 'deferred',
            reason: 'deadline_exceeded',
          });
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }
        case 'ok': {
          const parsed = parseAiRewriteOutputJson(callOutcome.rawText);
          if (!parsed.ok) {
            // The provider answered but its output failed validation: the
            // charge stays and the breaker does not move — fall through
            // to the next Gemini model.
            record(model.modelId, 'invalid_output', durationMs);
            break;
          }
          // The claim-preservation guard runs BEFORE success is
          // returned: a rewritten number/date not in the raw text is a
          // rejected attempt, never a successful rewrite.
          const guard = checkRewritePreservesNumbers({
            rawHeadlineFa: headlineFa,
            rawSummaryFa: summaryFa,
            rawClaimTexts: claimTexts,
            rewrittenHeadlineFa: parsed.rewrite.headlineFa,
            rewrittenSummaryFa: parsed.rewrite.summaryFa,
          });
          if (!guard.ok) {
            deps.logger.info('ai.rewrite.guard_refused', {
              code: guard.code,
              modelId: model.modelId,
            });
            record(model.modelId, 'invalid_output', durationMs);
            break;
          }
          const usageEntry: {
            provider: AiProvider;
            modelId: string;
            promptVersion: string;
            inputTokens?: number;
            outputTokens?: number;
          } = {
            provider: 'gemini',
            modelId: model.modelId,
            promptVersion: AI_REWRITE_PROMPT_VERSION,
          };
          if (callOutcome.usage?.inputTokens !== undefined) {
            usageEntry.inputTokens = callOutcome.usage.inputTokens;
          }
          if (callOutcome.usage?.outputTokens !== undefined) {
            usageEntry.outputTokens = callOutcome.usage.outputTokens;
          }
          try {
            const usageWaitStartedAtMs = deps.clock.now();
            const usageWait = await awaitWithDeadline(
              recordAiUsage(deps.executor, {
                provider: 'gemini',
                bucketDate,
                inputTokens: callOutcome.usage?.inputTokens,
                outputTokens: callOutcome.usage?.outputTokens,
                nowMs: usageWaitStartedAtMs,
              }),
              deadlineAtMs,
              usageWaitStartedAtMs,
              { scheduleTimeout: deps.deadlineScheduler },
            );
            if (usageWait.kind === 'timed_out') {
              deps.logger.warn('ai.rewrite.usage_record_timeout', {
                provider: 'gemini',
              });
            }
          } catch {
            deps.logger.warn('ai.rewrite.usage_record_failed', { provider: 'gemini' });
          }
          record(model.modelId, 'succeeded', durationMs);
          await noteBreakerSuccess();
          deps.logger.info('ai.rewrite.result', {
            kind: 'rewritten',
            provider: 'gemini',
            modelId: model.modelId,
            attempts: attempts.length,
            usage: {
              inputTokens: usageEntry.inputTokens ?? null,
              outputTokens: usageEntry.outputTokens ?? null,
            },
          });
          return {
            kind: 'rewritten',
            rewrite: parsed.rewrite,
            modelId: model.modelId,
            usage: [usageEntry],
            attempts,
          };
        }
        case 'quota_denied': {
          record(model.modelId, 'quota_denied', durationMs);
          // The provider answered with its own quota verdict: no refund
          // and no breaker count — the caller defers to the next-day
          // reset without consuming a rewrite attempt.
          if (callOutcome.retryAfterMs !== undefined) {
            knownRetryAfterMs = Math.max(knownRetryAfterMs, callOutcome.retryAfterMs);
          }
          deps.logger.info('ai.rewrite.result', {
            kind: 'deferred',
            reason: 'budget_denied',
          });
          return {
            kind: 'deferred',
            reason: 'budget_denied',
            retryAfterMs: knownRetryAfterMs > 0 ? knownRetryAfterMs : undefined,
            attempts,
          };
        }
        case 'auth_failed': {
          record(model.modelId, 'auth_failed', durationMs);
          await refundAttempt(model.modelId);
          deps.logger.info('ai.rewrite.result', {
            kind: 'deferred',
            reason: 'provider_auth_failed',
          });
          return {
            kind: 'deferred',
            reason: 'provider_auth_failed',
            attempts,
          };
        }
        case 'model_unavailable': {
          record(model.modelId, 'model_unavailable', durationMs);
          await refundAttempt(model.modelId);
          await noteBreakerFailure();
          if (callOutcome.retryAfterMs !== undefined) {
            knownRetryAfterMs = Math.max(knownRetryAfterMs, callOutcome.retryAfterMs);
          }
          break;
        }
        case 'transient': {
          record(model.modelId, 'transient_failure', durationMs, callOutcome.transportErrorName);
          await refundAttempt(model.modelId);
          await noteBreakerFailure();
          if (callOutcome.retryAfterMs !== undefined) {
            knownRetryAfterMs = Math.max(knownRetryAfterMs, callOutcome.retryAfterMs);
          }
          break;
        }
      }
    }

    const reason = classifyExhausted(attempts);
    deps.logger.info('ai.rewrite.result', { kind: 'deferred', reason, attempts: attempts.length });
    return {
      kind: 'deferred',
      reason,
      retryAfterMs: knownRetryAfterMs > 0 ? knownRetryAfterMs : undefined,
      attempts,
    };
  }

  return { rewriteNewsDraft };
}

function classifyExhausted(attempts: readonly AiAttemptRecord[]): AiDeferredReason {
  if (attempts.some((attempt) => attempt.outcome === 'skipped_deadline')) {
    return 'deadline_exceeded';
  }
  if (attempts.some((attempt) => attempt.outcome === 'auth_failed')) {
    return 'provider_auth_failed';
  }
  if (attempts.some((attempt) => attempt.outcome === 'quota_denied')) {
    return 'budget_denied';
  }
  if (
    attempts.some(
      (attempt) =>
        attempt.outcome === 'transient_failure' ||
        attempt.outcome === 'model_unavailable' ||
        attempt.outcome === 'deadline_exceeded' ||
        attempt.outcome === 'invalid_output',
    )
  ) {
    return 'provider_unavailable';
  }
  return 'no_free_path';
}
