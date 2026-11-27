/**
 * AI draft service (Phase 6 — ADR-0041 §4): the bounded application
 * service callable from application code. No new public AI endpoint, no
 * admin command, no cron/queue wiring in this round — the future durable
 * caller is responsible for persistence; this service itself keeps NO
 * in-memory queue/circuit-breaker state — the circuit breaker is durable
 * D1 `settings` state (ai-circuit-breaker.ts), read fresh per invocation
 * (honest scope, see ADR-0041).
 *
 * Free-only, fail-closed orchestration over the versioned policy:
 * 1. `AI_ENABLED` off/missing/invalid ⇒ typed deferred `ai_disabled` with
 *    ZERO provider calls, ZERO budget writes, ZERO binding access.
 * 2. The request is Zod-validated and byte-bounded (≤16 KiB evidence
 *    UTF-8) BEFORE anything else; violations ⇒ typed deferred
 *    `input_invalid`.
 * 3. BEFORE any authorization the PRIMARY account's persistent AI
 *    circuit breaker is consulted: while OPEN the service returns typed
 *    deferred `circuit_open` with ZERO provider calls and ZERO charges
 *    (retryable later — the caller maps it onto its bounded retry), and
 *    an open PRIMARY breaker is NEVER a failover trigger (a broken
 *    provider PATH must not burn the backup account on the same defect;
 *    ADR-0069). The BACKUP account's breaker is checked per candidate
 *    and skips only the backup candidates. Breakers are PER ACCOUNT
 *    (ai-policy-v2.3, `ai.circuit_breaker.{provider}`). EVERY provider
 *    attempt requires a SUCCESSFUL DURABLE authorization through the
 *    per-provider budget store BEFORE the call. Denied ⇒ charged-as-
 *    denied attempt and the provider is skipped (a CF denial skips ALL
 *    remaining CF models of the SAME account — the same shared provider
 *    bucket — while the BACKUP account's own bucket stays reachable:
 *    that skip-by-provider-key IS the failover routing); store failure
 *    ⇒ typed deferred `budget_store_error`, never mistaken for quota.
 *    Charge-on-success: an attempt that ends WITHOUT a provider
 *    completion (deadline, provider unavailable/transient, auth
 *    failure, or a grant that arrives after the deadline) is REFUNDED
 *    best-effort, one unit, floored at 0 — a refund failure never fails
 *    the run, and refunds NEVER cross provider keys (a failed backup
 *    attempt refunds the backup row only). A provider answer (success
 *    or invalid output) keeps the charge; a denied authorization never
 *    charged.
 * 3b. Budget pressure (ai-policy-v2.3): the autonomous chain authorizes
 *    against the EFFECTIVE cap (hard cap − reserve). A denial inside
 *    the reserve window is typed `budget_pressure` (retryable — the
 *    chain degrades early instead of riding to the terminal denial); a
 *    denial at the hard cap stays the terminal `budget_denied`. A
 *    granted authorization crossing the warning threshold logs the
 *    sanitized `ai.budget.pressure_warning` event (visibility only).
 * 4. Provider order (ai-policy-v2.3): CF primary → CF alternate (only
 *    for suitable model-specific unavailable/retired/transient failures)
 *    → CF BACKUP primary → CF BACKUP alternate (the REST failover port;
 *    reached ONLY when the operator kill switch is on AND the port is
 *    wired) → Gemini ONLY if its independent eligibility/budget/key are
 *    valid. A provider content/safety refusal is a TERMINAL typed
 *    refusal — no model or provider hopping to bypass safety.
 * 5. Bounds: ≤3 provider calls, ≤2048 output tokens
 *    (AI_BOUNDS.maxOutputTokens, ai-policy-v2.2), and a TOTAL wall
 *    deadline (injected clock) bounding EVERY await in this service path
 *    (round 1.10.6.1): the durable budget-authorization wait, the provider
 *    call itself, and the post-success usage recording. Authorization that
 *    arrives after the deadline — or whose wait outlives it — starts NO
 *    provider work: the clock is re-checked immediately after authorization
 *    and before entering the provider port. D1 budget writes are NOT
 *    cancellable: a charge that lands during or after a TIMED-OUT
 *    AUTHORIZATION wait stays recorded — whether it landed is unknown, so
 *    no refund is attempted (conservative, honest). A charge that landed
 *    for an attempt which then ends WITHOUT a provider completion is
 *    REFUNDED best-effort (charge-on-success); a provider answer keeps
 *    the charge. Workers AI binding calls cannot be natively cancelled — a
 *    timed-out attempt is refunded by the service (documented). Late
 *    rejections are absorbed by the deadline primitive (never unhandled,
 *    never resurrected).
 * 6. Provider output is Zod-validated (schema + evidenceIds ⊆ request
 *    evidence); malformed/truncated/oversized/unknown-reference output is
 *    a rejected attempt — never a successful empty draft.
 * 7. No free path remains ⇒ typed deferred with a stable reason and a
 *    known retry boundary when available. No silent drop, no paid
 *    fallback.
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
  AI_POLICY_VERSION,
  AI_PROMPT_VERSION,
  defaultProviderEligibility,
} from '../../domain/ai/policy';
import { buildNewsDraftSystemPrompt, buildNewsDraftUserPrompt } from '../../domain/ai/prompt';
import { parseAiSemanticDraftJson } from '../../domain/ai/schema';
import type {
  AiAttemptRecord,
  AiChatMessage,
  AiDeferredReason,
  AiOutcome,
  AiProvider,
  AiProviderPort,
} from '../../domain/ai/types';

/** Stable evidence identifier shape (same family as ingestion ids). */
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

const evidenceSnippetSchema = z
  .object({
    id: z.string().regex(EVIDENCE_ID_PATTERN),
    text: z.string().min(1),
  })
  .strict();

const aiDraftRequestSchema = z
  .object({
    taskType: z.literal('news_draft'),
    locale: z.literal('fa'),
    evidence: z
      .array(evidenceSnippetSchema)
      .min(AI_BOUNDS.minEvidenceCount)
      .max(AI_BOUNDS.maxEvidenceCount),
  })
  .strict();

export interface AiDraftServiceConfig {
  /** Validated AI_ENABLED flag (parseAiConfig). */
  readonly aiEnabled: boolean;
  /** Validated AI_GEMINI_ENABLED operator gate (parseAiConfig). */
  readonly geminiEnabled: boolean;
  /**
   * Validated AI_FAILOVER_ENABLED operator kill switch (parseAiConfig,
   * ai-policy-v2.3). Backup candidates run only when this is on AND the
   * backup REST port is wired — BOTH gates fail closed. Optional with a
   * default OFF (the flag's own fail-closed default), so callers that
   * predate failover keep today's behavior exactly.
   */
  readonly failoverEnabled?: boolean;
  /** Whether the native Workers AI binding is present in the runtime. */
  readonly workersAiBindingPresent: boolean;
  /** Whether a Gemini API key is configured (presence only — never the value). */
  readonly geminiApiKeyPresent: boolean;
}

export interface AiDraftServiceDeps {
  readonly executor: DbExecutor;
  /** Provider ports keyed by provider (missing port = provider unavailable). */
  readonly ports: Readonly<Partial<Record<AiProvider, AiProviderPort>>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: AiDraftServiceConfig;
  /**
   * Eligibility view (per provider). Defaults to the versioned policy
   * (ADR-0067: Gemini PARTIAL — docs-verified free tier, per-project
   * quota unpublished; the operator flag is the opt-in). Injectable for
   * deterministic tests.
   */
  readonly eligibility?: Readonly<Record<AiProvider, boolean>>;
  /**
   * Deadline scheduler for the bounded waits below (round 1.10.6.1).
   * Production defaults to real setTimeout/clearTimeout; deterministic
   * tests inject a manual scheduler and fire the deadline themselves. This
   * does NOT change the clock contract: `clock` remains the source of
   * `now()`; the scheduler only decides when the deadline callback fires.
   */
  readonly deadlineScheduler?: DeadlineTimeoutScheduler;
}

export interface AiDraftService {
  generateNewsDraft(request: unknown): Promise<AiOutcome>;
}

interface Candidate {
  readonly provider: AiProvider;
  readonly modelId: string;
}

function defaultEligibility(): Record<AiProvider, boolean> {
  return defaultProviderEligibility();
}

export function createAiDraftService(deps: AiDraftServiceDeps): AiDraftService {
  const eligibility = deps.eligibility ?? defaultEligibility();
  const encoder = new TextEncoder();
  const systemPrompt = buildNewsDraftSystemPrompt();

  async function generateNewsDraft(request: unknown): Promise<AiOutcome> {
    // ---- Gate 1: the master flag is the FIRST decision, before any work.
    if (!deps.config.aiEnabled) {
      return { kind: 'deferred', reason: 'ai_disabled', attempts: [] };
    }

    // ---- Gate 2: bounded request validation (fail closed, zero side effects).
    const parsedRequest = aiDraftRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }
    const evidence = parsedRequest.data.evidence;
    const evidenceIds = new Set(evidence.map((snippet) => snippet.id));
    const totalEvidenceBytes = evidence.reduce(
      (total, snippet) => total + encoder.encode(snippet.text).length,
      0,
    );
    if (totalEvidenceBytes > AI_BOUNDS.maxInputUtf8Bytes) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }

    const startedAt = deps.clock.now();
    const deadlineAtMs = startedAt + AI_BOUNDS.totalWallDeadlineMs;

    /**
     * Best-effort refund of THIS attempt's charge (charge-on-success):
     * called only when the attempt ended WITHOUT a provider completion.
     * A failed refund never fails the run — the outcome stands and the
     * charge is the only casualty (logged, honest).
     */
    const refundAttempt = async (candidate: Candidate): Promise<void> => {
      try {
        await refundAiRequestAttempt(deps.executor, {
          provider: candidate.provider,
          nowMs: deps.clock.now(),
        });
      } catch {
        deps.logger.warn('ai.draft.refund_failed', { provider: candidate.provider });
      }
    };
    /**
     * Best-effort breaker bookkeeping on the CANDIDATE's OWN account
     * breaker (`ai.circuit_breaker.{provider}` — per account,
     * ai-policy-v2.3). Failures count ONLY provider failures (transient /
     * model_unavailable / deadline_exceeded); quota denials, auth
     * failures, refusals and invalid output never move the counter. A
     * failed record never fails the run.
     */
    const noteBreakerFailure = async (provider: AiProvider): Promise<void> => {
      try {
        await recordAiCircuitBreakerFailure(deps.executor, deps.clock.now(), provider);
      } catch {
        deps.logger.warn('ai.draft.circuit_breaker_record_failed', { provider });
      }
    };
    const noteBreakerSuccess = async (provider: AiProvider): Promise<void> => {
      try {
        await recordAiCircuitBreakerSuccess(deps.executor, deps.clock.now(), provider);
      } catch {
        deps.logger.warn('ai.draft.circuit_breaker_record_failed', { provider });
      }
    };

    const attempts: AiAttemptRecord[] = [];
    const skippedProviders = new Set<AiProvider>();
    const sharedQuotaProviders = new Set<AiProvider>();
    const authFailedProviders = new Set<AiProvider>();
    let providerCalls = 0;
    let knownRetryAfterMs = 0;
    let geminiSkippedIneligible = false;
    let sawHardQuotaDenial = false;
    let sawReservePressure = false;

    const record = (
      candidate: Candidate,
      outcome: AiAttemptRecord['outcome'],
      durationMs: number,
    ): void => {
      attempts.push({
        provider: candidate.provider,
        modelId: candidate.modelId,
        promptVersion: AI_PROMPT_VERSION,
        outcome,
        durationMs,
      });
      deps.logger.info('ai.draft.attempt', {
        provider: candidate.provider,
        modelId: candidate.modelId,
        promptVersion: AI_PROMPT_VERSION,
        policyVersion: AI_POLICY_VERSION,
        outcome,
        durationMs,
      });
    };

    // ---- Candidate ladder (the SHARED versioned-policy builder,
    // ai-policy-v2.3): Workers AI primary → Workers AI alternate →
    // Workers AI BACKUP primary → Workers AI BACKUP alternate →
    // (conditional) Gemini. The backup candidates gate on BOTH the
    // operator kill switch AND the wired REST port (fail-closed). Pure
    // and synchronous — no D1, no clock, no network.
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
    const candidates: Candidate[] = ladder.candidates.map((candidate) => ({
      provider: candidate.provider,
      modelId: candidate.modelId,
    }));
    geminiSkippedIneligible = ladder.geminiSkippedIneligible;

    if (candidates.length === 0) {
      return {
        kind: 'deferred',
        reason: classifyZeroCandidates(deps.config, eligibility, geminiSkippedIneligible),
        attempts,
      };
    }

    // ---- Gate 3: the PRIMARY account's persistent AI circuit breaker —
    // consulted BEFORE any authorization, so an open breaker means ZERO
    // provider calls and ZERO charges. Checked only when the ladder
    // contains primary candidates: a missing binding means the primary
    // breaker's stale state must not mask the typed binding_missing or
    // the backup path (ADR-0069 §6). An open PRIMARY breaker is NEVER a
    // failover trigger — the outcome is typed `circuit_open` with zero
    // failover and zero charges (a broken provider PATH must not burn
    // the backup on the same defect). The BACKUP account's breaker is
    // checked per candidate INSIDE the loop below. A failed breaker READ
    // fails open (closed): the provider path still has its own
    // budget/deadline guards, and a settings outage must not block
    // drafting by itself.
    if (candidates.some((candidate) => candidate.provider === 'workers-ai')) {
      try {
        const breaker = await checkAiCircuitBreaker(deps.executor, startedAt, 'workers-ai');
        if (!breaker.allow) {
          deps.logger.info('ai.draft.circuit_open', {
            consecutiveFailures: breaker.snapshot.consecutiveFailures,
            openedAtMs: breaker.snapshot.openedAtMs,
          });
          return { kind: 'deferred', reason: 'circuit_open', attempts: [] };
        }
      } catch {
        deps.logger.warn('ai.draft.circuit_breaker_check_failed');
      }
    }

    const portFor = (provider: AiProvider): AiProviderPort => {
      const port = deps.ports[provider];
      if (port === undefined) {
        throw new Error('provider port missing after candidacy check');
      }
      return port;
    };

    const deferredByDeadline = (candidate: Candidate): AiOutcome => {
      record(candidate, 'skipped_deadline', deps.clock.now() - startedAt);
      deps.logger.info('ai.draft.result', { kind: 'deferred', reason: 'deadline_exceeded' });
      return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
    };

    for (const candidate of candidates) {
      // The ≤3 cap counts REAL provider calls; ledger skips do not.
      if (providerCalls >= AI_BOUNDS.maxProviderAttempts) {
        break;
      }
      // The wall deadline stops further fallback work — a late
      // authorization must never start a new provider call.
      if (deps.clock.now() >= deadlineAtMs) {
        record(candidate, 'skipped_deadline', 0);
        break;
      }
      // A shared provider-bucket quota denial (or a provider auth/config
      // failure) skips ALL remaining candidates of the SAME provider.
      if (sharedQuotaProviders.has(candidate.provider)) {
        record(candidate, 'skipped_shared_quota', 0);
        continue;
      }
      if (authFailedProviders.has(candidate.provider)) {
        record(candidate, 'skipped_provider_failed', 0);
        continue;
      }
      // ---- Per-account breaker for the NON-primary providers
      // (ai-policy-v2.3): the PRIMARY breaker was already consulted at
      // gate 3 (an open primary breaker returned `circuit_open` above —
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
            record(candidate, 'skipped_circuit_open', 0);
            continue;
          }
        } catch {
          deps.logger.warn('ai.draft.circuit_breaker_check_failed', {
            provider: candidate.provider,
          });
        }
      }

      // ---- Durable authorization BEFORE the attempt (no grant, no call).
      // The authorization wait itself is bounded by the SAME wall deadline
      // (round 1.10.6.1): a stalled budget store must never hang the whole
      // invocation. The D1 batch is NOT cancellable — a charge that lands
      // after the deadline race stays recorded (conservative, no refund).
      let bucketDate: string;
      try {
        // The remaining wall time is measured BEFORE the wait starts so a
        // mid-wait clock jump cannot retroactively decide an in-flight
        // store operation; the race bounds it from its true start.
        const authWaitStartedAtMs = deps.clock.now();
        const authorizationWait = await awaitWithDeadline(
          authorizeAiRequestAttempt(deps.executor, {
            provider: candidate.provider,
            // ai-policy-v2.3: the autonomous chain authorizes against the
            // EFFECTIVE cap (hard cap − reserve) so the reserved tail of
            // each account's day stays unspent headroom.
            cap: effectiveAutonomousCap(AI_DAILY_REQUEST_ATTEMPT_CAPS[candidate.provider]),
            nowMs: authWaitStartedAtMs,
          }),
          deadlineAtMs,
          authWaitStartedAtMs,
          { scheduleTimeout: deps.deadlineScheduler },
        );
        if (authorizationWait.kind === 'timed_out') {
          // The deadline fired while the authorization was pending. This is
          // NEITHER a quota denial NOR a store error: no provider work may
          // start, and late resolutions/rejections are absorbed by the
          // primitive. NO refund is attempted here: whether the possibly-
          // late D1 charge landed is unknown, so refunding could eat an
          // unrelated earlier charge (conservative, honest).
          return deferredByDeadline(candidate);
        }
        const authorization = authorizationWait.value;
        if (authorization.kind === 'denied') {
          record(candidate, 'quota_denied', 0);
          // Same shared provider bucket: remaining same-provider candidates
          // are futile and are skipped (and LEDGERED) at the loop top.
          // ai-policy-v2.3: the denial is then classified — a denial
          // INSIDE the reserve window (the effective cap) is the early,
          // retryable `budget_pressure`; a denial at the hard cap stays
          // the terminal `budget_denied`. Ambiguity falls to HARD.
          sharedQuotaProviders.add(candidate.provider);
          skippedProviders.add(candidate.provider);
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
        // granted charge (visibility only — never changes the outcome,
        // never fails the run).
        await noteBudgetPressureWarning(deps.executor, deps.logger, {
          provider: candidate.provider,
          nowMs: deps.clock.now(),
        });
      } catch {
        // Budget-store infrastructure failures are DISTINCT from quota
        // exhaustion: zero provider calls, typed deferred outcome.
        deps.logger.warn('ai.draft.budget_store_failed', { provider: candidate.provider });
        return { kind: 'deferred', reason: 'budget_store_error', attempts };
      }

      // ---- Post-authorization deadline guard: a grant that arrives in
      // time but whose processing crosses the deadline must not start any
      // provider work. The granted charge is REFUNDED best-effort
      // (charge-on-success — the D1 write itself is not cancellable, so
      // the refund is a compensating write): no provider call started, so
      // no provider work was consumed. The adapter's own internal guard is
      // NEVER a substitute for this service-level contract.
      if (deps.clock.now() >= deadlineAtMs) {
        await refundAttempt(candidate);
        return deferredByDeadline(candidate);
      }

      // ---- The authorized attempt (counted against the cap; a failed
      // attempt is refunded best-effort under charge-on-success, a
      // provider answer keeps the charge). The wait is raced against the
      // wall deadline at the SERVICE level as well: a port that ignores
      // its deadline contract cannot hang the invocation (the in-flight
      // provider work may still complete runtime-side and is refunded by
      // the service — documented).
      providerCalls += 1;
      const attemptStartedAt = deps.clock.now();
      const messages: AiChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildNewsDraftUserPrompt(evidence) },
      ];
      let callOutcome: Awaited<ReturnType<AiProviderPort['complete']>>;
      try {
        const callWait = await awaitWithDeadline(
          portFor(candidate.provider).complete({
            modelId: candidate.modelId,
            messages,
            maxOutputTokens: AI_BOUNDS.maxOutputTokens,
            deadlineAtMs,
          }),
          deadlineAtMs,
          // Bounded from the attempt's TRUE start: a clock jump inside the
          // port call does not retroactively decide an in-flight call — the
          // pinned contract records the real outcome and stops the ladder.
          attemptStartedAt,
          { scheduleTimeout: deps.deadlineScheduler },
        );
        if (callWait.kind === 'timed_out') {
          record(candidate, 'deadline_exceeded', deps.clock.now() - attemptStartedAt);
          // No provider completion within the deadline: refund the
          // attempt and count the provider failure toward THE CANDIDATE'S
          // OWN account breaker.
          await refundAttempt(candidate);
          await noteBreakerFailure(candidate.provider);
          deps.logger.info('ai.draft.result', {
            kind: 'deferred',
            reason: 'deadline_exceeded',
          });
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }
        callOutcome = callWait.value;
      } catch {
        // A port throwing past its own mapping is a defensive transient:
        // refund the attempt, count the failure, try the next candidate.
        record(candidate, 'transient_failure', deps.clock.now() - attemptStartedAt);
        await refundAttempt(candidate);
        await noteBreakerFailure(candidate.provider);
        continue;
      }
      const durationMs = deps.clock.now() - attemptStartedAt;

      switch (callOutcome.kind) {
        case 'refused': {
          // TERMINAL typed refusal — never hop models/providers to bypass
          // a content/safety rejection.
          record(candidate, 'refused', durationMs);
          deps.logger.info('ai.draft.result', { kind: 'refusal', attempts: attempts.length });
          return {
            kind: 'refusal',
            provider: candidate.provider,
            modelId: candidate.modelId,
            reason: 'provider_safety_refusal',
            attempts,
          };
        }
        case 'deadline_exceeded': {
          record(candidate, 'deadline_exceeded', durationMs);
          await refundAttempt(candidate);
          await noteBreakerFailure(candidate.provider);
          deps.logger.info('ai.draft.result', { kind: 'deferred', reason: 'deadline_exceeded' });
          return { kind: 'deferred', reason: 'deadline_exceeded', attempts };
        }
        case 'ok': {
          const parsed = parseAiSemanticDraftJson(callOutcome.rawText);
          if (!parsed.ok) {
            // The provider answered but its output failed validation: the
            // charge stays (the provider did the work) and the breaker
            // does not move — this is not a provider failure.
            record(candidate, 'invalid_output', durationMs);
            break;
          }
          // Cross-check: every referenced evidence id MUST exist in the
          // request evidence set (referenced ids alone do NOT prove the
          // generated claim is true — the fact guard stays downstream).
          const unknownReference = parsed.draft.claims.some((claim) =>
            claim.evidenceIds.some((id) => !evidenceIds.has(id)),
          );
          if (unknownReference) {
            record(candidate, 'invalid_output', durationMs);
            break;
          }
          const usageEntry: {
            provider: AiProvider;
            modelId: string;
            promptVersion: string;
            inputTokens?: number;
            outputTokens?: number;
          } = {
            provider: candidate.provider,
            modelId: candidate.modelId,
            promptVersion: AI_PROMPT_VERSION,
          };
          if (callOutcome.usage?.inputTokens !== undefined) {
            usageEntry.inputTokens = callOutcome.usage.inputTokens;
          }
          if (callOutcome.usage?.outputTokens !== undefined) {
            usageEntry.outputTokens = callOutcome.usage.outputTokens;
          }
          // Best-effort, NON-authoritative usage recording, bounded by the
          // SAME wall deadline (round 1.10.6.1): a stalled D1 write must
          // never hold a successful draft hostage. Its failure or timeout
          // NEVER revokes the durable authorization (a provider answer
          // keeps its charge — no refund on success), never starts another
          // provider or fallback, and NEVER changes the outcome — the draft
          // is already valid; recording is post-success bookkeeping. A
          // late-finishing write may still land (the D1 operation is not
          // cancellable); its late rejection is absorbed.
          try {
            const usageWaitStartedAtMs = deps.clock.now();
            const usageWait = await awaitWithDeadline(
              recordAiUsage(deps.executor, {
                provider: candidate.provider,
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
              deps.logger.warn('ai.draft.usage_record_timeout', {
                provider: candidate.provider,
              });
            }
          } catch {
            deps.logger.warn('ai.draft.usage_record_failed', { provider: candidate.provider });
          }
          record(candidate, 'succeeded', durationMs);
          // The provider answered: reset THAT account's breaker counter
          // (a half-open probe success closes it) and keep the charge.
          await noteBreakerSuccess(candidate.provider);
          deps.logger.info('ai.draft.result', {
            kind: 'draft',
            provider: candidate.provider,
            modelId: candidate.modelId,
            attempts: attempts.length,
            usage: {
              inputTokens: usageEntry.inputTokens ?? null,
              outputTokens: usageEntry.outputTokens ?? null,
            },
          });
          return { kind: 'draft', draft: parsed.draft, usage: [usageEntry], attempts };
        }
        case 'quota_denied': {
          record(candidate, 'quota_denied', durationMs);
          // The provider answered with its own quota verdict: no refund
          // (the provider did the work) and no breaker count — this is a
          // quota condition, not a provider failure. It is a HARD quota
          // condition (the provider's own pool), so it maps to the
          // terminal budget classification when the ladder exhausts.
          sawHardQuotaDenial = true;
          skippedProviders.add(candidate.provider);
          sharedQuotaProviders.add(candidate.provider);
          if (callOutcome.retryAfterMs !== undefined) {
            knownRetryAfterMs = Math.max(knownRetryAfterMs, callOutcome.retryAfterMs);
          }
          break;
        }
        case 'auth_failed': {
          record(candidate, 'auth_failed', durationMs);
          // The provider answered with an auth/config failure: refund the
          // attempt, but do NOT count it toward the breaker — it is not a
          // provider-availability failure.
          await refundAttempt(candidate);
          skippedProviders.add(candidate.provider);
          authFailedProviders.add(candidate.provider);
          break;
        }
        case 'model_unavailable':
        case 'transient': {
          record(
            candidate,
            callOutcome.kind === 'model_unavailable' ? 'model_unavailable' : 'transient_failure',
            durationMs,
          );
          // No provider completion: refund the attempt and count the
          // provider failure toward THE CANDIDATE'S OWN account breaker.
          await refundAttempt(candidate);
          await noteBreakerFailure(candidate.provider);
          if (callOutcome.retryAfterMs !== undefined) {
            knownRetryAfterMs = Math.max(knownRetryAfterMs, callOutcome.retryAfterMs);
          }
          break;
        }
      }
    }

    const reason = classifyExhausted(attempts, {
      skippedProviders,
      authFailedProviders,
      geminiSkippedIneligible,
      sawProviderAttempt: attempts.some((attempt) => isProviderOutcome(attempt.outcome)),
      sawHardQuotaDenial,
      sawReservePressure,
    });
    deps.logger.info('ai.draft.result', { kind: 'deferred', reason, attempts: attempts.length });
    return {
      kind: 'deferred',
      reason,
      retryAfterMs: knownRetryAfterMs > 0 ? knownRetryAfterMs : undefined,
      attempts,
    };
  }

  return { generateNewsDraft };
}

function isProviderOutcome(outcome: AiAttemptRecord['outcome']): boolean {
  return (
    outcome === 'succeeded' ||
    outcome === 'refused' ||
    outcome === 'transient_failure' ||
    outcome === 'model_unavailable' ||
    outcome === 'deadline_exceeded' ||
    outcome === 'invalid_output'
  );
}

function classifyZeroCandidates(
  config: AiDraftServiceConfig,
  eligibility: Readonly<Record<AiProvider, boolean>>,
  geminiSkippedIneligible: boolean,
): AiDeferredReason {
  if (!config.workersAiBindingPresent) {
    return 'binding_missing';
  }
  if (geminiSkippedIneligible) {
    return 'eligibility_unverified';
  }
  if (config.geminiEnabled && !config.geminiApiKeyPresent) {
    return 'key_missing';
  }
  if (!eligibility.gemini) {
    return 'eligibility_unverified';
  }
  return 'no_free_path';
}

function classifyExhausted(
  attempts: readonly AiAttemptRecord[],
  state: {
    readonly skippedProviders: ReadonlySet<AiProvider>;
    readonly authFailedProviders: ReadonlySet<AiProvider>;
    readonly geminiSkippedIneligible: boolean;
    readonly sawProviderAttempt: boolean;
    /** A HARD quota denial (app cap or the provider's own pool). */
    readonly sawHardQuotaDenial: boolean;
    /** Only the RESERVE window denied — the early, retryable pressure. */
    readonly sawReservePressure: boolean;
  },
): AiDeferredReason {
  if (attempts.some((attempt) => attempt.outcome === 'skipped_deadline')) {
    // The wall deadline stopped the ladder before an authorized attempt.
    return 'deadline_exceeded';
  }
  if (state.authFailedProviders.size > 0) {
    return 'provider_auth_failed';
  }
  if (state.sawHardQuotaDenial) {
    return 'budget_denied';
  }
  if (state.sawReservePressure) {
    // ai-policy-v2.3: the autonomous chain backed off INSIDE the reserve
    // window — retryable (refunds/midnight can reopen units), never the
    // terminal hard denial.
    return 'budget_pressure';
  }
  if (state.geminiSkippedIneligible && state.sawProviderAttempt) {
    // CF attempts failed AND the Gemini fallback stayed OFF for unverified
    // eligibility — surface the eligibility gate, not a generic failure.
    return 'eligibility_unverified';
  }
  if (state.sawProviderAttempt) {
    return 'provider_unavailable';
  }
  return 'no_free_path';
}
