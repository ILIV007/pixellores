/**
 * `editorial.rewrite_draft` handler (ADR-0070 §5): the Gemini-only Soul
 * rewrite job. ONE bounded handler execution:
 *
 *   load draft by id → validate the stored document → run the EXISTING
 *   `createAiRewriteService` (Gemini-only, real budget/breaker/deadline)
 *   → fenced atomic commit (rewritten document + news_rewrite ai_runs
 *   row, same batch — the rowcount is the authority).
 *
 * Typed-outcome contract:
 * - unknown draft id → PERMANENT `editorial_rewrite_draft_missing`:
 *   retries cannot conjure a missing reference.
 * - unparsable / structurally unusable document → PERMANENT
 *   `editorial_rewrite_document_invalid`: the identical input would
 *   deterministically repeat (no storm), zero provider calls.
 * - draft not `ready` / already rewritten / already failed → SUCCESS
 *   (nothing to do): the draft left the rewriteable state, or the work
 *   is already done — never a second rewrite, never an automatic retry
 *   of a failed rewrite.
 * - the rewrite flag OFF at execution time → SUCCESS with zero work:
 *   the flag is the kill-switch; a draft that is not rewritten stays
 *   raw and bridgeable while the flag is off. (Recorded decision:
 *   the ADR does not specify this case. The job completes rather than
 *   burning bounded engine retries waiting for a flag flip; a missed
 *   rewrite is re-enqueued only by a fresh draft creation — see
 *   docs/OPEN_DECISIONS.md.)
 * - provider SAFETY REFUSAL → the document is marked
 *   `rewrite.status = 'failed'` (reason `provider_safety_refusal`)
 *   and the job SUCCEEDS: terminal, no model hopping, and the bridge
 *   never auto-publishes the draft until a human reviews it.
 * - `quota_denied` (app budget OR provider quota) → RECOVERABLE retry
 *   with `retryAfterMs` = ms until the next Tehran midnight, WITHOUT
 *   consuming a rewrite attempt: NO document write, the spent count
 *   does not move. The engine's deferral primitive owns the schedule —
 *   never a retry every 5 minutes against a dead budget.
 * - any other failed invocation (transient / invalid output / guard
 *   refusal / deadline / circuit / auth) → the spent count IS persisted
 *   (fenced `pending` block, or `failed` once the 2-attempt budget is
 *   spent) and the job RETRIES with the engine's bounded retry, so the
 *   next generation runs rewrite attempt #2. After the 2nd failure the
 *   document is marked `rewrite.status = 'failed'` and the job
 *   SUCCEEDS — the draft is excluded from auto-publish until a human
 *   reviews it. The rewrite NEVER falls back to Workers AI for the
 *   final text; if Gemini is unavailable the draft simply waits.
 * - a lost ownership fence / a document changed underneath → the
 *   fenced commit writes ZERO rows; RECOVERABLE retry (the next
 *   generation re-reads the CURRENT document honestly).
 * - mid-commit storage failure → propagates: the engine classifies it
 *   as transient (`job_internal_error`) and reschedules; the atomic
 *   batch guarantees NO partial editorial state.
 *
 * Honest scope limits (recorded, never hidden): one ai_runs row per
 * rewrite invocation (task 'news_rewrite', the last attempt — mirroring
 * the draft path's one-row-per-invocation honesty); the service's
 * per-model attempts ride inside that row's latency/model fields, not
 * as separate rows. A crash after Gemini answered but before the commit
 * loses the ai_runs row WITH the document — the retry is a NEW
 * generation that legitimately calls Gemini again.
 */
import type { JobHandler, HandlerOutcome, JobExecutionContext } from '../../domain/jobs/handler';
import type { EditorialRewriteDraftPayload } from '../../domain/jobs/payloads';
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  commitRewriteResult,
  findDraftById,
  recordEditorialAiRun,
  type EditorialCommitInput,
} from '../../adapters/db/editorial-store';
import type { AiRewriteOutcome, AiRewriteService } from '../ai/rewrite-service';
import { AI_REWRITE_MAX_ATTEMPTS_PER_DRAFT } from '../../domain/ai/policy';
import { AI_REWRITE_PROMPT_VERSION, AI_REWRITE_SOUL_VERSION } from '../../domain/ai/rewrite-prompt';
import {
  applyRewriteToDocument,
  markRewriteFailedOnDocument,
  markRewritePendingOnDocument,
  parseDraftDocumentForRewrite,
} from '../../domain/editorial/mapper';
import { aiRunIdForRewriteAttempt } from '../../domain/editorial/identity';
import { msUntilNextTehranMidnight } from '../../shared/time/tehran-day';
import { sha256Hex } from '../../shared/ids/idempotency-key';
import type { Logger } from '../../observability/logger';

export interface EditorialRewriteDraftHandlerOptions {
  readonly executor: DbExecutor;
  /** The EXISTING AI rewrite service (ADR-0070) — Gemini-only. */
  readonly rewriteService: AiRewriteService;
  /**
   * The AI_GEMINI_REWRITE_ENABLED flag at execution time. The handler
   * re-checks it (layered defense with the service's own gate): a job
   * enqueued while the flag was on but executed after it flipped off
   * does ZERO work.
   */
  readonly rewriteEnabled: boolean;
  readonly nowMs: () => number;
  readonly logger?: Logger;
}

/** One real rewrite invocation observed by the handler (for ai_runs honesty). */
interface ObservedRewriteRun {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly status: 'succeeded' | 'failed' | 'invalid';
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly errorCode: string | null;
}

/** Derive the real ai_runs fields from the outcome (never invent usage). */
export function observeRewriteRun(
  outcome: AiRewriteOutcome,
  startedAtMs: number,
  finishedAtMs: number,
): ObservedRewriteRun | null {
  if (outcome.kind === 'rewritten') {
    const usage = outcome.usage[0];
    const succeededAttempt = [...outcome.attempts]
      .reverse()
      .find((attempt) => attempt.outcome === 'succeeded');
    return {
      provider: usage?.provider ?? succeededAttempt?.provider ?? 'gemini',
      model: usage?.modelId ?? succeededAttempt?.modelId ?? outcome.modelId,
      promptVersion:
        usage?.promptVersion ?? succeededAttempt?.promptVersion ?? AI_REWRITE_PROMPT_VERSION,
      status: 'succeeded',
      latencyMs: succeededAttempt?.durationMs ?? finishedAtMs - startedAtMs,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      errorCode: null,
    };
  }
  const lastAttempt = outcome.attempts.at(-1);
  if (lastAttempt === undefined) {
    // Zero real provider involvement (e.g. a flag gate / pre-service
    // rejection): NO ai_runs row — a provider that never ran is never
    // fabricated.
    return null;
  }
  if (outcome.kind === 'refusal') {
    return {
      provider: outcome.provider,
      model: outcome.modelId,
      promptVersion: lastAttempt.promptVersion,
      status: 'failed',
      latencyMs: lastAttempt.durationMs,
      inputTokens: null,
      outputTokens: null,
      errorCode: 'provider_safety_refusal',
    };
  }
  // An invalid-output / guard-refusal ending is 'invalid' (the provider
  // answered but its output could not be used); every other deferred
  // ending is 'failed' with the deferred reason as the error code.
  const invalidEnding = lastAttempt.outcome === 'invalid_output';
  return {
    provider: lastAttempt.provider,
    model: lastAttempt.modelId,
    promptVersion: lastAttempt.promptVersion,
    status: invalidEnding ? 'invalid' : 'failed',
    latencyMs: lastAttempt.durationMs,
    inputTokens: null,
    outputTokens: null,
    errorCode: invalidEnding ? 'invalid_output' : outcome.reason,
  };
}

export function createEditorialRewriteDraftHandler(
  options: EditorialRewriteDraftHandlerOptions,
): JobHandler<EditorialRewriteDraftPayload> {
  const { executor, rewriteService, nowMs, logger } = options;

  async function recordRealRewriteRun(
    jobId: string,
    generation: number,
    observed: ObservedRewriteRun,
    inputHash: string,
    fenceNowMs: number,
  ): Promise<void> {
    const id = await aiRunIdForRewriteAttempt(jobId, generation, 0);
    try {
      await recordEditorialAiRun(executor, {
        jobId,
        generation,
        fenceNowMs,
        aiRun: {
          id,
          task: 'news_rewrite',
          provider: observed.provider,
          model: observed.model,
          promptVersion: observed.promptVersion,
          inputHash,
          status: observed.status,
          latencyMs: observed.latencyMs,
          inputTokens: observed.inputTokens,
          outputTokens: observed.outputTokens,
          errorCode: observed.errorCode,
          errorMessage: null,
          createdAt: fenceNowMs,
          completedAt: fenceNowMs,
        },
      });
    } catch {
      // The ai_runs row for a NON-commit path is observability, not the
      // durable outcome: its failure never changes the handler's typed
      // result (the engine's own bookkeeping carries the reason code).
      logger?.warn('editorial.rewrite_draft.ai_run_record_failed');
    }
  }

  function buildAiRun(
    observed: ObservedRewriteRun,
    inputHash: string,
    fenceNowMs: number,
  ): Omit<EditorialCommitInput['aiRun'], 'id'> {
    return {
      task: 'news_rewrite',
      provider: observed.provider,
      model: observed.model,
      promptVersion: observed.promptVersion,
      inputHash,
      status: observed.status,
      latencyMs: observed.latencyMs,
      inputTokens: observed.inputTokens,
      outputTokens: observed.outputTokens,
      errorCode: observed.errorCode,
      errorMessage: null,
      createdAt: fenceNowMs,
      completedAt: fenceNowMs,
    };
  }

  async function execute(
    context: JobExecutionContext<EditorialRewriteDraftPayload>,
  ): Promise<HandlerOutcome> {
    const { jobId, generation, payload } = context;

    // ---- 1. The referenced draft must exist (typed, terminal).
    const draft = await findDraftById(executor, payload.draftId);
    if (draft === null) {
      logger?.warn('editorial.rewrite_draft.draft_missing');
      return { kind: 'permanent', reasonCode: 'editorial_rewrite_draft_missing' };
    }

    // ---- 2. Only a `ready` draft is rewriteable — a draft that already
    // moved on (auto_approved / rejected / superseded) is none of this
    // job's business; success, zero writes, zero provider calls.
    if (draft.status !== 'ready') {
      logger?.info('editorial.rewrite_draft.draft_not_ready', { status: draft.status });
      return { kind: 'success' };
    }

    // ---- 3. The stored document must parse into a rewriteable input.
    const parsed = parseDraftDocumentForRewrite(draft.document_json);
    if (parsed === null) {
      logger?.warn('editorial.rewrite_draft.document_invalid');
      return { kind: 'permanent', reasonCode: 'editorial_rewrite_document_invalid' };
    }

    // ---- 4. Idempotency / terminal states: already rewritten (a retry
    // after a successful commit) or already failed (never retried
    // automatically) complete with zero work.
    if (parsed.alreadyRewritten) {
      logger?.info('editorial.rewrite_draft.already_rewritten');
      return { kind: 'success' };
    }
    if (parsed.alreadyFailed) {
      logger?.info('editorial.rewrite_draft.already_failed');
      return { kind: 'success' };
    }

    // ---- 5. The flag is the kill-switch, re-checked at execution time:
    // a job enqueued while ON but executed after it flipped OFF does
    // zero work — the draft stays raw and bridgeable while the flag is
    // off. Success, not retry: the job must not burn bounded engine
    // attempts waiting for a flag flip.
    if (!options.rewriteEnabled) {
      logger?.info('editorial.rewrite_draft.skipped_flag_off');
      return { kind: 'success' };
    }

    // ---- 6. Defensive correction: the spent count already hit the
    // budget without a failed marking (a crash between invocations, or
    // a hand-written block). Mark it failed — no provider call, no
    // fabricated run — and complete.
    if (parsed.attemptsSpent >= AI_REWRITE_MAX_ATTEMPTS_PER_DRAFT) {
      const corrected = markRewriteFailedOnDocument(parsed.document, {
        reason: 'rewrite_attempts_exhausted',
        promptVersion: AI_REWRITE_PROMPT_VERSION,
        soulVersion: AI_REWRITE_SOUL_VERSION,
        attempts: parsed.attemptsSpent,
        failedAtMs: nowMs(),
      });
      const commit = await commitRewriteResult(executor, {
        jobId,
        generation,
        fenceNowMs: nowMs(),
        draftId: draft.id,
        documentJson: JSON.stringify(corrected),
        title: null,
        aiRun: null,
        expectedDocumentJson: draft.document_json,
      });
      if (!commit.documentUpdated) {
        logger?.warn('editorial.rewrite_draft.ownership_fence_lost');
        return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
      }
      logger?.info('editorial.rewrite_draft.attempts_exhausted');
      return { kind: 'success' };
    }

    // ---- 7. The rewrite invocation (Gemini-only service).
    const inputHash = await sha256Hex(
      JSON.stringify({
        draftId: draft.id,
        headlineFa: parsed.headlineFa,
        summaryFa: parsed.summaryFa,
        claimTexts: parsed.claimTexts,
        sourceName: parsed.sourceName,
      }),
    );
    const rewriteStartedAtMs = nowMs();
    const outcome = await rewriteService.rewriteNewsDraft({
      draftId: draft.id,
      headlineFa: parsed.headlineFa,
      summaryFa: parsed.summaryFa,
      claimTexts: parsed.claimTexts,
      sourceName: parsed.sourceName,
    });
    const rewriteFinishedAtMs = nowMs();
    const observed = observeRewriteRun(outcome, rewriteStartedAtMs, rewriteFinishedAtMs);

    // Zero real provider involvement (flag gates / pre-service
    // rejections inside the service): no ai_runs row, no document
    // write. Flag-gate deferrals complete quietly (the flag flipped
    // mid-flight); an oversized input is terminal (the identical
    // input would deterministically repeat).
    if (observed === null) {
      if (outcome.kind === 'deferred' && outcome.reason === 'input_invalid') {
        logger?.warn('editorial.rewrite_draft.input_invalid');
        return { kind: 'permanent', reasonCode: 'editorial_rewrite_document_invalid' };
      }
      logger?.info('editorial.rewrite_draft.skipped_flag_off');
      return { kind: 'success' };
    }

    const aiRunId = await aiRunIdForRewriteAttempt(jobId, generation, 0);
    const aiRun: EditorialCommitInput['aiRun'] = {
      ...buildAiRun(observed, inputHash, rewriteFinishedAtMs),
      id: aiRunId,
    };

    // ---- 8a. SUCCESS: the rewritten text replaces the raw text in
    // place (raw preserved for audit); the fenced batch is the
    // authority — a lost fence / changed document writes zero rows.
    if (outcome.kind === 'rewritten') {
      const rewritten = applyRewriteToDocument(parsed.document, {
        headlineFa: outcome.rewrite.headlineFa,
        summaryFa: outcome.rewrite.summaryFa,
        categoryEmoji: outcome.rewrite.categoryEmoji,
        trustLabel: outcome.rewrite.trustLabel,
        model: outcome.modelId,
        promptVersion: AI_REWRITE_PROMPT_VERSION,
        soulVersion: AI_REWRITE_SOUL_VERSION,
        attempts: parsed.attemptsSpent + 1,
        rewrittenAtMs: rewriteFinishedAtMs,
      });
      const commit = await commitRewriteResult(executor, {
        jobId,
        generation,
        fenceNowMs: rewriteFinishedAtMs,
        draftId: draft.id,
        documentJson: JSON.stringify(rewritten),
        title: outcome.rewrite.headlineFa,
        aiRun,
        expectedDocumentJson: draft.document_json,
      });
      if (!commit.documentUpdated) {
        logger?.warn('editorial.rewrite_draft.ownership_fence_lost');
        return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
      }
      logger?.info('editorial.rewrite_draft.rewritten', {
        draftId: draft.id,
        model: outcome.modelId,
        attempts: parsed.attemptsSpent + 1,
      });
      return { kind: 'success' };
    }

    // ---- 8b. SAFETY REFUSAL: terminal — mark failed, job completes.
    // The bridge never auto-publishes the draft until a human reviews it.
    if (outcome.kind === 'refusal') {
      const failed = markRewriteFailedOnDocument(parsed.document, {
        reason: 'provider_safety_refusal',
        promptVersion: AI_REWRITE_PROMPT_VERSION,
        soulVersion: AI_REWRITE_SOUL_VERSION,
        attempts: parsed.attemptsSpent + 1,
        failedAtMs: rewriteFinishedAtMs,
      });
      const commit = await commitRewriteResult(executor, {
        jobId,
        generation,
        fenceNowMs: rewriteFinishedAtMs,
        draftId: draft.id,
        documentJson: JSON.stringify(failed),
        title: null,
        aiRun,
        expectedDocumentJson: draft.document_json,
      });
      if (!commit.documentUpdated) {
        logger?.warn('editorial.rewrite_draft.ownership_fence_lost');
        return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
      }
      logger?.info('editorial.rewrite_draft.refused', { draftId: draft.id });
      return { kind: 'success' };
    }

    // ---- 8c. QUOTA DENIED: defer to the next Tehran-day reset WITHOUT
    // consuming a rewrite attempt — NO document write, the spent count
    // does not move. The ai_runs row IS recorded (the denial happened);
    // its failure never changes the retry.
    if (outcome.reason === 'budget_denied') {
      await recordRealRewriteRun(jobId, generation, observed, inputHash, rewriteFinishedAtMs);
      logger?.info('editorial.rewrite_draft.quota_deferred', { draftId: draft.id });
      return {
        kind: 'retry',
        reasonCode: 'job_handler_retryable_error',
        retryAfterMs: msUntilNextTehranMidnight(rewriteFinishedAtMs),
      };
    }

    // ---- 8d. Any other failed invocation: persist the spent count
    // (pending — or failed once the 2-attempt budget is spent) and
    // retry with the engine's bounded retry, so the next generation
    // runs rewrite attempt #2. A spent budget completes the job: the
    // draft is excluded from auto-publish until a human reviews it.
    const spent = parsed.attemptsSpent + 1;
    const exhausted = spent >= AI_REWRITE_MAX_ATTEMPTS_PER_DRAFT;
    const nextDocument = exhausted
      ? markRewriteFailedOnDocument(parsed.document, {
          reason: outcome.reason,
          promptVersion: AI_REWRITE_PROMPT_VERSION,
          soulVersion: AI_REWRITE_SOUL_VERSION,
          attempts: spent,
          failedAtMs: rewriteFinishedAtMs,
        })
      : markRewritePendingOnDocument(parsed.document, {
          promptVersion: AI_REWRITE_PROMPT_VERSION,
          soulVersion: AI_REWRITE_SOUL_VERSION,
          attempts: spent,
        });
    const commit = await commitRewriteResult(executor, {
      jobId,
      generation,
      fenceNowMs: rewriteFinishedAtMs,
      draftId: draft.id,
      documentJson: JSON.stringify(nextDocument),
      title: null,
      aiRun,
      expectedDocumentJson: draft.document_json,
    });
    if (!commit.documentUpdated) {
      logger?.warn('editorial.rewrite_draft.ownership_fence_lost');
      return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
    }
    if (exhausted) {
      logger?.info('editorial.rewrite_draft.failed', {
        draftId: draft.id,
        reason: outcome.reason,
      });
      return { kind: 'success' };
    }
    logger?.info('editorial.rewrite_draft.pending_retry', {
      draftId: draft.id,
      reason: outcome.reason,
      attempts: spent,
    });
    return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
  }

  return { type: 'editorial.rewrite_draft', execute };
}
