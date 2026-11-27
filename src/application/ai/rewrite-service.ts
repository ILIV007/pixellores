/**
 * AI rewrite service (ADR-0070 §2/§4): the Gemini-ONLY Soul rewrite
 * stage. Workers AI NEVER authors the final post — this service calls
 * ONLY the Gemini port (the allowlist trio, in order), over the SAME
 * plumbing the draft ladder uses:
 * - the SHARED candidate-ladder builder (`ai-ladder.ts`, ai-policy-v2.3
 *   — this service uses the ladder's Gemini leg only, per ADR-0070 §7:
 *   WS1 merged first as PR #30, so the Gemini candidacy gates live in
 *   ONE construction site, not in a second inline ladder);
 * - the per-provider budget store (authorize / record usage / refund),
 *   same gemini 40/day bucket — a rewrite never bypasses the shared cap
 *   — authorized against the EFFECTIVE autonomous cap (40 − 6 reserve,
 *   ai-policy-v2.3) with reserve-window denials classified as the
 *   retryable `budget_pressure`;
 * - the durable per-provider AI circuit breaker (the `gemini` breaker,
 *   shared with drafting);
 * - the 60 s wall deadline, same `awaitWithDeadline` primitive;
 * - `ai_runs` task `'news_rewrite'` (own deterministic id namespace —
 *   the caller records the row; this service only returns attempts).
 *
 * Two public methods share ONE Gemini attempt loop (`runGeminiRewrite`):
 * `rewriteNewsDraft` (pipeline drafts, ADR-0070) and `rewriteInboundPost`
 * (owner-sent posts, ADR-0073 §1). They differ only in their gates (the
 * news method requires the `AI_GEMINI_REWRITE_ENABLED` stage flag; the
 * inbound method does NOT — ADR-0073 §2), their prompts, their output
 * parser, their preservation guard, and their success shape. The budget
 * bucket, the breaker, and the refusal/deferral semantics are identical
 * by construction.
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
import { buildAiCandidateLadder } from './ai-ladder';
import {
  classifyAiBudgetDenial,
  effectiveAutonomousCap,
  noteBudgetPressureWarning,
} from './ai-budget-pressure';
import {
  AI_BOUNDS,
  AI_DAILY_REQUEST_ATTEMPT_CAPS,
  AI_INBOUND_REWRITE_MAX_OUTPUT_TOKENS,
  AI_POLICY_VERSION,
  AI_REWRITE_MAX_OUTPUT_TOKENS,
  defaultProviderEligibility,
} from '../../domain/ai/policy';
import {
  AI_REWRITE_PROMPT_VERSION,
  buildNewsRewriteSystemPrompt,
  buildNewsRewriteUserPrompt,
  type AiRewriteOutput,
} from '../../domain/ai/rewrite-prompt';
import {
  AI_INBOUND_REWRITE_PROMPT_VERSION,
  buildInboundRewriteSystemPrompt,
  buildInboundRewriteUserPrompt,
  type AiInboundRewriteOutput,
} from '../../domain/ai/inbound-rewrite-prompt';
import { parseAiRewriteOutputJson } from '../../domain/ai/rewrite-schema';
import { parseAiInboundRewriteOutputJson } from '../../domain/ai/inbound-rewrite-schema';
import {
  checkInboundRewritePreservesNumbers,
  checkRewritePreservesNumbers,
} from '../../domain/ai/rewrite-guard';
import { GAMING_CATEGORIES, type GamingCategory } from '../../domain/inbound/classifier';
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

/** Inbound rewrite request: the owner's cleaned post text + its category. */
const inboundRewriteRequestSchema = z
  .object({
    text: z.string().min(1).max(4096),
    category: z
      .string()
      .refine((value): value is GamingCategory =>
        (GAMING_CATEGORIES as readonly string[]).includes(value),
      ),
    isCaption: z.boolean(),
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
  /**
   * Validated AI_FAILOVER_ENABLED operator kill switch (parseAiConfig,
   * ai-policy-v2.3). Only feeds the shared ladder builder's gates — the
   * rewrite is Gemini-only, so the failover leg is filtered out; the
   * flag is passed through so the builder sees the TRUE static view.
   * Optional with a default OFF, like the draft service.
   */
  readonly failoverEnabled?: boolean;
  /** Whether the native Workers AI binding is present in the runtime. */
  readonly workersAiBindingPresent: boolean;
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

/** Sanitized usage metadata for one successful rewrite (shared shape). */
export interface AiRewriteUsageEntry {
  readonly provider: AiProvider;
  readonly modelId: string;
  readonly promptVersion: string;
  /** Mutable like the original inline shape: assigned after the call returns. */
  inputTokens?: number;
  outputTokens?: number;
}

/** Successful Gemini rewrite with sanitized usage metadata. */
export interface AiRewriteSuccess {
  readonly kind: 'rewritten';
  readonly rewrite: AiRewriteOutput;
  /** The model that authored the final text (a Gemini allowlist id). */
  readonly modelId: string;
  readonly usage: readonly AiRewriteUsageEntry[];
  readonly attempts: readonly AiAttemptRecord[];
}

/** Successful Gemini inbound rewrite: the complete rewritten post text. */
export interface AiInboundRewriteSuccess {
  readonly kind: 'rewritten';
  readonly text: string;
  /** The model that authored the final text (a Gemini allowlist id). */
  readonly modelId: string;
  readonly usage: readonly AiRewriteUsageEntry[];
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

/** The complete outcome surface of the inbound rewrite. */
export type AiInboundRewriteOutcome =
  AiInboundRewriteSuccess | AiRewriteRefusal | AiRewriteDeferred;

export interface AiRewriteService {
  rewriteNewsDraft(request: unknown): Promise<AiRewriteOutcome>;
  rewriteInboundPost(request: unknown): Promise<AiInboundRewriteOutcome>;
}

function defaultEligibility(): Record<AiProvider, boolean> {
  return defaultProviderEligibility();
}

export function createAiRewriteService(deps: AiRewriteServiceDeps): AiRewriteService {
  const eligibility = deps.eligibility ?? defaultEligibility();
  const encoder = new TextEncoder();
  const systemPrompt = buildNewsRewriteSystemPrompt();
  const inboundSystemPrompt = buildInboundRewriteSystemPrompt();

  /**
   * The SHARED Gemini attempt loop (ADR-0070 §7 + ADR-0073 §1): gate 3
   * (the per-provider breaker), the shared ladder's Gemini leg, budget
   * authorization + refund, the 60 s wall deadline, and the
   * parse → guard → success pipeline. The two public methods differ
   * only in their gates (the news method requires the stage flag; the
   * inbound method does not — ADR-0073 §2), their prompts, their
   * output parser, their preservation guard, and their success shape.
   * Everything else — including the budget bucket, the breaker, and
   * the refusal/deferral semantics — is identical by construction.
   */
  async function runGeminiRewrite<Parsed, Success>(options: {
    readonly logPrefix: 'ai.rewrite' | 'ai.inbound_rewrite';
    readonly promptVersion: string;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly maxOutputTokens: number;
    readonly parse: (
      rawText: string,
    ) => { readonly ok: true; readonly value: Parsed } | { readonly ok: false };
    readonly guard: (
      parsed: Parsed,
    ) =>
      | { readonly ok: true }
      | { readonly ok: false; readonly code: string; readonly token?: string };
    readonly buildSuccess: (args: {
      readonly parsed: Parsed;
      readonly modelId: string;
      readonly usage: AiRewriteUsageEntry;
      readonly attempts: readonly AiAttemptRecord[];
    }) => Success;
  }): Promise<Success | AiRewriteRefusal | AiRewriteDeferred> {
    const {
      logPrefix,
      promptVersion,
      systemPrompt,
      userPrompt,
      maxOutputTokens,
      parse,
      guard,
      buildSuccess,
    } = options;

    const startedAt = deps.clock.now();
    const deadlineAtMs = startedAt + AI_BOUNDS.totalWallDeadlineMs;

    // ---- Gate 3: the GEMINI account's persistent AI circuit breaker —
    // consulted BEFORE any authorization (same contract as the draft
    // service, ai-policy-v2.3: breakers are per provider now).
    try {
      const breaker = await checkAiCircuitBreaker(deps.executor, startedAt, 'gemini');
      if (!breaker.allow) {
        deps.logger.info(`${logPrefix}.circuit_open`, {
          consecutiveFailures: breaker.snapshot.consecutiveFailures,
          openedAtMs: breaker.snapshot.openedAtMs,
        });
        return { kind: 'deferred', reason: 'circuit_open', attempts: [] };
      }
    } catch {
      deps.logger.warn(`${logPrefix}.circuit_breaker_check_failed`);
    }

    const refundAttempt = async (modelId: string): Promise<void> => {
      try {
        await refundAiRequestAttempt(deps.executor, {
          provider: 'gemini',
          nowMs: deps.clock.now(),
        });
      } catch {
        deps.logger.warn(`${logPrefix}.refund_failed`, { provider: 'gemini', modelId });
      }
    };
    const noteBreakerFailure = async (): Promise<void> => {
      try {
        await recordAiCircuitBreakerFailure(deps.executor, deps.clock.now(), 'gemini');
      } catch {
        deps.logger.warn(`${logPrefix}.circuit_breaker_record_failed`);
      }
    };
    const noteBreakerSuccess = async (): Promise<void> => {
      try {
        await recordAiCircuitBreakerSuccess(deps.executor, deps.clock.now(), 'gemini');
      } catch {
        deps.logger.warn(`${logPrefix}.circuit_breaker_record_failed`);
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
        promptVersion,
        outcome,
        durationMs,
      });
      deps.logger.info(`${logPrefix}.attempt`, {
        provider: 'gemini',
        modelId,
        promptVersion,
        policyVersion: AI_POLICY_VERSION,
        outcome,
        durationMs,
        ...(transportErrorName !== undefined ? { transportErrorName } : {}),
      });
    };

    // ---- Candidate ladder: the SHARED versioned-policy builder
    // (ai-ladder.ts, ai-policy-v2.3) — this service uses the ladder's
    // Gemini leg ONLY (ADR-0070 §7). The builder sees the TRUE static
    // view (all gates as wired); the non-Gemini legs are filtered out
    // below, never called. A missing port, a missing key, a disabled
    // ladder flag, or unverified eligibility means NO Gemini path
    // exists — zero network, typed deferred.
    const geminiPort = deps.ports.gemini;
    const ladder = buildAiCandidateLadder({
      workersAiPrimaryPresent:
        deps.config.workersAiBindingPresent && deps.ports['workers-ai'] !== undefined,
      failoverEnabled: deps.config.failoverEnabled === true,
      backupPortPresent: deps.ports['workers-ai-backup'] !== undefined,
      geminiEnabled: deps.config.geminiEnabled,
      geminiKeyPresent: deps.config.geminiApiKeyPresent,
      geminiPortPresent: geminiPort !== undefined,
      geminiEligible: eligibility.gemini,
    });
    const geminiCandidates = ladder.candidates.filter(
      (candidate) => candidate.provider === 'gemini',
    );
    if (geminiCandidates.length === 0) {
      const reason: AiDeferredReason = !deps.config.geminiEnabled
        ? 'no_free_path'
        : !deps.config.geminiApiKeyPresent
          ? 'key_missing'
          : !eligibility.gemini
            ? 'eligibility_unverified'
            : 'no_free_path';
      return { kind: 'deferred', reason, attempts };
    }
    if (geminiPort === undefined) {
      // Unreachable in practice: the ladder yields Gemini candidates
      // only when the port is present — fail closed rather than assume.
      return { kind: 'deferred', reason: 'no_free_path', attempts };
    }

    for (const model of geminiCandidates) {
      if (providerCalls >= AI_BOUNDS.maxProviderAttempts) {
        break;
      }
      if (deps.clock.now() >= deadlineAtMs) {
        record(model.modelId, 'skipped_deadline', 0);
        break;
      }

      // ---- Durable authorization BEFORE the attempt (no grant, no call).
      // ai-policy-v2.3: the autonomous chain authorizes against the
      // EFFECTIVE cap (hard cap − reserve) so the reserved tail of the
      // day stays unspent headroom.
      let bucketDate: string;
      try {
        const authWaitStartedAtMs = deps.clock.now();
        const authorizationWait = await awaitWithDeadline(
          authorizeAiRequestAttempt(deps.executor, {
            provider: 'gemini',
            cap: effectiveAutonomousCap(AI_DAILY_REQUEST_ATTEMPT_CAPS.gemini),
            nowMs: authWaitStartedAtMs,
          }),
          deadlineAtMs,
          authWaitStartedAtMs,
          { scheduleTimeout: deps.deadlineScheduler },
        );
        if (authorizationWait.kind === 'timed_out') {
          record(model.modelId, 'skipped_deadline', deps.clock.now() - startedAt);
          deps.logger.info(`${logPrefix}.result`, {
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
          // denial is CLASSIFIED (ai-policy-v2.3): a denial inside the
          // reserve window is the early, retryable `budget_pressure`;
          // a denial at the hard cap stays the terminal `budget_denied`.
          // Either way the caller defers to the next-day reset WITHOUT
          // consuming a rewrite attempt (ADR-0070 §5).
          const denialKind = await classifyAiBudgetDenial(deps.executor, {
            provider: 'gemini',
            hardCap: AI_DAILY_REQUEST_ATTEMPT_CAPS.gemini,
            nowMs: deps.clock.now(),
          });
          const reason: AiDeferredReason =
            denialKind === 'hard' ? 'budget_denied' : 'budget_pressure';
          deps.logger.info(`${logPrefix}.result`, {
            kind: 'deferred',
            reason,
          });
          return { kind: 'deferred', reason, attempts };
        }
        bucketDate = authorization.bucketDate;
        // ai-policy-v2.3: best-effort early pressure warning on the
        // granted charge (visibility only — never changes the outcome,
        // never fails the run).
        await noteBudgetPressureWarning(deps.executor, deps.logger, {
          provider: 'gemini',
          nowMs: deps.clock.now(),
        });
      } catch {
        deps.logger.warn(`${logPrefix}.budget_store_failed`, { provider: 'gemini' });
        return { kind: 'deferred', reason: 'budget_store_error', attempts };
      }

      if (deps.clock.now() >= deadlineAtMs) {
        await refundAttempt(model.modelId);
        record(model.modelId, 'skipped_deadline', 0);
        deps.logger.info(`${logPrefix}.result`, {
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
            maxOutputTokens,
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
          deps.logger.info(`${logPrefix}.result`, {
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
          deps.logger.info(`${logPrefix}.result`, { kind: 'refusal', attempts: attempts.length });
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
          deps.logger.info(`${logPrefix}.result`, {
            kind: 'deferred',
            reason: 'deadline_exceeded',
          });
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }
        case 'ok': {
          const parsed = parse(callOutcome.rawText);
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
          const guardResult = guard(parsed.value);
          if (!guardResult.ok) {
            deps.logger.info(`${logPrefix}.guard_refused`, {
              code: guardResult.code,
              modelId: model.modelId,
            });
            record(model.modelId, 'invalid_output', durationMs);
            break;
          }
          const usageEntry: AiRewriteUsageEntry = {
            provider: 'gemini',
            modelId: model.modelId,
            promptVersion,
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
              deps.logger.warn(`${logPrefix}.usage_record_timeout`, {
                provider: 'gemini',
              });
            }
          } catch {
            deps.logger.warn(`${logPrefix}.usage_record_failed`, { provider: 'gemini' });
          }
          record(model.modelId, 'succeeded', durationMs);
          await noteBreakerSuccess();
          deps.logger.info(`${logPrefix}.result`, {
            kind: 'rewritten',
            provider: 'gemini',
            modelId: model.modelId,
            attempts: attempts.length,
            usage: {
              inputTokens: usageEntry.inputTokens ?? null,
              outputTokens: usageEntry.outputTokens ?? null,
            },
          });
          return buildSuccess({
            parsed: parsed.value,
            modelId: model.modelId,
            usage: usageEntry,
            attempts,
          });
        }
        case 'quota_denied': {
          record(model.modelId, 'quota_denied', durationMs);
          // The provider answered with its own quota verdict: no refund
          // and no breaker count — this is a HARD quota condition (the
          // provider's own pool), so it maps to the terminal
          // `budget_denied`; the caller defers to the next-day reset
          // without consuming a rewrite attempt.
          if (callOutcome.retryAfterMs !== undefined) {
            knownRetryAfterMs = Math.max(knownRetryAfterMs, callOutcome.retryAfterMs);
          }
          deps.logger.info(`${logPrefix}.result`, {
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
          deps.logger.info(`${logPrefix}.result`, {
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
    deps.logger.info(`${logPrefix}.result`, {
      kind: 'deferred',
      reason,
      attempts: attempts.length,
    });
    return {
      kind: 'deferred',
      reason,
      retryAfterMs: knownRetryAfterMs > 0 ? knownRetryAfterMs : undefined,
      attempts,
    };
  }

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
    return runGeminiRewrite<AiRewriteOutput, AiRewriteSuccess>({
      logPrefix: 'ai.rewrite',
      promptVersion: AI_REWRITE_PROMPT_VERSION,
      systemPrompt,
      userPrompt,
      maxOutputTokens: AI_REWRITE_MAX_OUTPUT_TOKENS,
      parse: (rawText) => {
        const parsed = parseAiRewriteOutputJson(rawText);
        return parsed.ok ? { ok: true as const, value: parsed.rewrite } : { ok: false as const };
      },
      guard: (parsed) =>
        checkRewritePreservesNumbers({
          rawHeadlineFa: headlineFa,
          rawSummaryFa: summaryFa,
          rawClaimTexts: claimTexts,
          rewrittenHeadlineFa: parsed.headlineFa,
          rewrittenSummaryFa: parsed.summaryFa,
        }),
      buildSuccess: ({ parsed, modelId, usage, attempts }) => ({
        kind: 'rewritten' as const,
        rewrite: parsed,
        modelId,
        usage: [usage],
        attempts,
      }),
    });
  }

  async function rewriteInboundPost(request: unknown): Promise<AiInboundRewriteOutcome> {
    // ---- Gate 1: the master flag is the FIRST decision, before any
    // work. Off => zero provider calls, zero budget writes, zero
    // binding access. NOTE (ADR-0073 §2): there is deliberately NO
    // `rewriteEnabled` stage gate here — that flag is the PIPELINE-draft
    // stage gate, and the inbound rewrite gates on aiEnabled +
    // geminiEnabled + key + eligibility only.
    if (!deps.config.aiEnabled) {
      return { kind: 'deferred', reason: 'ai_disabled', attempts: [] };
    }

    // ---- Gate 2: bounded request validation (fail closed, zero side effects).
    const parsedRequest = inboundRewriteRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }
    const { text, category, isCaption } = parsedRequest.data;
    const userPrompt = buildInboundRewriteUserPrompt({ text, category, isCaption });
    if (encoder.encode(userPrompt).length > AI_BOUNDS.maxInputUtf8Bytes) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }
    return runGeminiRewrite<AiInboundRewriteOutput, AiInboundRewriteSuccess>({
      logPrefix: 'ai.inbound_rewrite',
      promptVersion: AI_INBOUND_REWRITE_PROMPT_VERSION,
      systemPrompt: inboundSystemPrompt,
      userPrompt,
      maxOutputTokens: AI_INBOUND_REWRITE_MAX_OUTPUT_TOKENS,
      parse: (rawText) => {
        const parsed = parseAiInboundRewriteOutputJson(rawText);
        return parsed.ok ? { ok: true as const, value: parsed.rewrite } : { ok: false as const };
      },
      guard: (parsed) =>
        checkInboundRewritePreservesNumbers({ rawText: text, rewrittenText: parsed.text }),
      buildSuccess: ({ parsed, modelId, usage, attempts }) => ({
        kind: 'rewritten' as const,
        text: parsed.text,
        modelId,
        usage: [usage],
        attempts,
      }),
    });
  }

  return { rewriteNewsDraft, rewriteInboundPost };
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
