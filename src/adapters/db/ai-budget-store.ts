/**
 * AI request-budget store (Phase 6 — ADR-0041 §4; typed D1 boundary per
 * ADR-0022).
 *
 * The EXISTING `budgets` table (migration 0001, unchanged) is the single
 * budget authority for AI too, under the DISTINCT scope 'ai' with
 * budget_key = provider ('workers-ai' | 'gemini') and the same explicit
 * Asia/Tehran day bucket (`bucket_date`). No migration, no DDL change, no
 * reuse of ingestion scope/source ids: provider accounting stays separate
 * from ingestion accounting by construction (PK scope+budget_key+day).
 *
 * Contract (round 1.10.6):
 * - EVERY potential provider attempt is charged through
 *   `authorizeAiRequestAttempt` BEFORE the call — a successful durable
 *   authorization is the ONLY thing that may start a provider request.
 * - The charge is ONE atomic D1 batch (guarded UPDATE + guarded
 *   INSERT..SELECT), race-safe against concurrent authorizations: the cap
 *   predicate is evaluated inside SQL against the CURRENT row.
 * - Units are app request ATTEMPTS (from AI_DAILY_REQUEST_ATTEMPT_CAPS).
 *   They are NOT Cloudflare Neurons and NOT a Google quota meter; provider
 *   reset boundaries are the providers' own — the app bucket is Tehran day
 *   by explicit policy, kept separate from both.
 * - Charge-on-success (ai-policy-v2.2 follow-up — owner-ordered guard):
 *   an attempt that ends WITHOUT a provider completion is REFUNDED
 *   best-effort through `refundAiRequestAttempt` (one unit, floored at
 *   0): deadline_exceeded, provider unavailable/transient, and auth
 *   failures. A provider ANSWER keeps the charge — success AND
 *   invalid_output (the provider did the work). A denied authorization
 *   never charged, so there is nothing to refund. A refund failure must
 *   never fail the run (callers swallow it); a late-finishing call that
 *   lost the deadline race is still refunded by the service, because
 *   the attempt produced no usable completion.
 * - The one charge that is NEVER refunded: an authorization whose wait
 *   timed out — whether its D1 batch landed is unknown, so refunding
 *   could eat an unrelated earlier charge. It stays recorded
 *   (conservative, honest).
 * - Storage failures propagate as mapped AppError — the CALLER classifies
 *   them as budget-store infrastructure errors (typed deferred
 *   budget_store_error), never as quota exhaustion.
 *
 * IMAGE BUDGET (ADR-0072): the SAME table carries the SEPARATE image
 * budget under budget_key 'workers-ai-image' (AI_IMAGE_BUDGET_KEY) —
 * the text keys are never charged for an image. For the image key the
 * `input_tokens` column carries ESTIMATED NEURONS, not tokens (the
 * binding reports no neuron usage): `authorizeAiRequestAttempt` with
 * `neuronCost`/`neuronCap` charges the estimate atomically with the
 * attempt and `refundAiRequestAttempt` with the same `neuronCost`
 * refunds it. A refund with no matching charge is a no-op (floored at
 * 0). Callers MUST pass the same `budgetKey` + `neuronCost` to both
 * functions for one attempt.
 */
import type { DbExecutor } from './db-executor';
import { tehranBudgetDay } from '../../shared/time/tehran-day';
import type { AiProvider } from '../../domain/ai/types';

/** Distinct budgets scope for AI provider accounting. */
export const AI_BUDGET_SCOPE = 'ai';

/**
 * The SEPARATE image budget key (ADR-0072): image attempts are charged
 * here, never against the text provider keys. For this key the
 * `input_tokens` column carries estimated neurons (see the header).
 */
export const AI_IMAGE_BUDGET_KEY = 'workers-ai-image';

/** Stable outcome of ONE per-attempt AI budget authorization. */
export type AiBudgetAuthorization =
  | { readonly kind: 'authorized'; readonly bucketDate: string }
  | { readonly kind: 'denied'; readonly bucketDate: string };

/**
 * Atomically consume EXACTLY ONE request attempt for `provider` on the
 * Tehran budget day resolved from the caller's `nowMs`. `cap` comes from
 * the versioned policy (AI_DAILY_REQUEST_ATTEMPT_CAPS) and is evaluated
 * inside SQL. A cap of 0 denies every attempt.
 *
 * Optional overrides (image budget, ADR-0072 — defaults preserve the
 * text behavior exactly): `budgetKey` replaces the provider as the
 * budget_key; `neuronCost` (estimated neurons for this attempt, 0 by
 * default) is charged atomically with the attempt and `neuronCap`
 * (default: no cap) bounds the day's charged neurons inside SQL.
 */
export async function authorizeAiRequestAttempt(
  executor: DbExecutor,
  input: {
    readonly provider: AiProvider;
    /** Positive app cap (attempts per Tehran day) from the versioned policy. */
    readonly cap: number;
    readonly nowMs: number;
    readonly budgetKey?: string;
    readonly neuronCost?: number;
    readonly neuronCap?: number;
  },
): Promise<AiBudgetAuthorization> {
  const bucketDate = tehranBudgetDay(input.nowMs);
  const nowMs = input.nowMs;
  const cap = Math.max(0, Math.floor(input.cap));
  const budgetKey = input.budgetKey ?? input.provider;
  const neuronCost = Math.max(0, Math.floor(input.neuronCost ?? 0));
  const neuronCap = Math.max(0, Math.floor(input.neuronCap ?? Number.MAX_SAFE_INTEGER));

  const metas = await executor.batch([
    {
      // Existing row: guarded ONE-attempt consume under the cap, plus
      // the atomic neuron charge under the neuron cap.
      sql: `UPDATE budgets
              SET requests = requests + 1, input_tokens = input_tokens + ?, updated_at = ?
            WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?
              AND requests + 1 <= ?
              AND input_tokens + ? <= ?`,
      params: [neuronCost, nowMs, budgetKey, bucketDate, cap, neuronCost, neuronCap],
    },
    {
      // New day row: first charge INSERT..SELECT under the same caps with
      // a NOT EXISTS guard — new-day initialization and the first charge
      // are atomic; a concurrent duplicate insert fails THIS statement
      // only (PK conflict) after the UPDATE already lost, and the batch
      // is atomic so the pair reads consistently.
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens, output_tokens, bytes_transferred, updated_at)
            SELECT '${AI_BUDGET_SCOPE}', ?, ?, 1, ?, 0, 0, ?
             WHERE 1 <= ?
               AND ? <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM budgets
                  WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?
               )`,
      params: [
        budgetKey,
        bucketDate,
        neuronCost,
        nowMs,
        cap,
        neuronCost,
        neuronCap,
        budgetKey,
        bucketDate,
      ],
    },
  ]);

  const updateChanges = metas[0]?.changes ?? 0;
  const insertChanges = metas[1]?.changes ?? 0;
  if (updateChanges > 0 || insertChanges > 0) {
    return { kind: 'authorized', bucketDate };
  }
  return { kind: 'denied', bucketDate };
}

/**
 * Best-effort refund of ONE previously authorized attempt for
 * `provider` on the Tehran budget day resolved from `nowMs`: decrements
 * `requests` by 1, floored at 0 by the guarded UPDATE (a refund with no
 * charge outstanding is a no-op, never a negative count). Returns true
 * when a unit was actually refunded.
 *
 * Callers invoke this ONLY for attempts that ended WITHOUT a provider
 * completion (deadline / provider unavailable / transient / auth
 * failure, or a charge that landed but started no provider call);
 * success and invalid_output keep the charge. Throws on a D1 error —
 * callers swallow it: a failed refund must never fail the run.
 *
 * Optional overrides (image budget, ADR-0072 — defaults preserve the
 * text behavior exactly): `budgetKey` replaces the provider as the
 * budget_key; `neuronCost` refunds the atomically charged neuron
 * estimate alongside the attempt (floored at 0). Pass the SAME values
 * the authorization used for this attempt.
 */
export async function refundAiRequestAttempt(
  executor: DbExecutor,
  input: {
    readonly provider: AiProvider;
    readonly nowMs: number;
    readonly budgetKey?: string;
    readonly neuronCost?: number;
  },
): Promise<boolean> {
  const budgetKey = input.budgetKey ?? input.provider;
  const neuronCost = Math.max(0, Math.floor(input.neuronCost ?? 0));
  const meta = await executor.run({
    sql: `UPDATE budgets
             SET requests = requests - 1, input_tokens = MAX(0, input_tokens - ?), updated_at = ?
           WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?
             AND requests > 0`,
    params: [neuronCost, input.nowMs, budgetKey, tehranBudgetDay(input.nowMs)],
  });
  return meta.changes > 0;
}

/**
 * Best-effort, NON-authoritative usage recording: increments the observed
 * input/output token columns when the provider actually reported them.
 * Never grants, refunds, or extends authority; absence or failure of this
 * recording never fails a successful call's result (the service logs a
 * sanitized warning and continues).
 */
export async function recordAiUsage(
  executor: DbExecutor,
  input: {
    readonly provider: AiProvider;
    readonly bucketDate: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly nowMs: number;
  },
): Promise<boolean> {
  const inputTokens = Math.max(0, Math.floor(input.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.floor(input.outputTokens ?? 0));
  if (inputTokens === 0 && outputTokens === 0) {
    return true;
  }
  const meta = await executor.run({
    sql: `UPDATE budgets
             SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ?
           WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?`,
    params: [inputTokens, outputTokens, input.nowMs, input.provider, input.bucketDate],
  });
  return meta.changes > 0;
}

/**
 * Charged-attempt readback for one provider's Tehran day: the count of
 * durably AUTHORIZED app request attempts — the conservative charging
 * metric, NOT an observed-provider-usage metric and NOT a remaining-free-
 * allowance proof.
 */
export async function readAiBudget(
  executor: DbExecutor,
  input: {
    readonly provider: AiProvider;
    readonly nowMs: number;
    /** Image budget (ADR-0072): replaces the provider as the budget_key. */
    readonly budgetKey?: string;
  },
): Promise<number> {
  const row = await executor.first<{
    requests: number;
    input_tokens: number;
    output_tokens: number;
  }>({
    sql: `SELECT requests, input_tokens, output_tokens FROM budgets
           WHERE scope = '${AI_BUDGET_SCOPE}' AND budget_key = ? AND bucket_date = ?`,
    params: [input.budgetKey ?? input.provider, tehranBudgetDay(input.nowMs)],
  });
  return row === null ? 0 : row.requests;
}
