/**
 * Budget pressure governance (ai-policy-v2.3) — the EARLY
 * warning/reserve thresholds acting BEFORE the hard daily caps, shared
 * by the three authorizing services so their accounting cannot diverge.
 *
 * Two mechanisms, both per provider (= per account):
 * - WARNING: after a GRANTED authorization, a best-effort readback of
 *   the charged-attempt counter; when it crosses
 *   AI_BUDGET_PRESSURE_WARNING_REQUESTS exactly, the service logs the
 *   sanitized `ai.budget.pressure_warning` event (stable event name,
 *   provider key, counts only). Visibility, not enforcement — the
 *   outcome never changes, a failed readback never fails the run.
 * - RESERVE: the autonomous chain authorizes against the EFFECTIVE cap
 *   (hard cap − AI_BUDGET_PRESSURE_RESERVE_UNITS). When the counter
 *   reaches the effective cap the authorization denies; the denial is
 *   then classified through `classifyAiBudgetDenial` with a best-effort
 *   readback:
 *   - counter inside the reserve window (effective ≤ count < hard) →
 *     `budget_pressure` — a RETRYABLE typed deferral (refunds and the
 *     Tehran-midnight reset can still reopen units; the chain degrades
 *     early instead of riding to the terminal denial);
 *   - counter at/over the hard cap, an inconsistent readback, or a
 *     failed readback → `hard` — the services' existing terminal
 *     `budget_denied` path, unchanged.
 *   The conservative direction is deliberate: ambiguity never softens a
 *   denial, it only ever falls back to today's terminal behavior.
 *
 * The reserved headroom (the last AI_BUDGET_PRESSURE_RESERVE_UNITS
 * units of each account's day) absorbs accounting drift — the ~3-unit
 * remainder observed on 2026-11-21 — and keeps one-shot operator probes
 * available after the autonomous chain has backed off. The hard caps
 * themselves are unchanged: a non-reserving caller can still spend to
 * the cap.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import { readAiBudget } from '../../adapters/db/ai-budget-store';
import type { Logger } from '../../observability/logger';
import {
  AI_BUDGET_PRESSURE_RESERVE_UNITS,
  AI_BUDGET_PRESSURE_WARNING_REQUESTS,
} from '../../domain/ai/policy';
import type { AiProvider } from '../../domain/ai/types';

/**
 * The effective cap the AUTONOMOUS chain authorizes against: the hard
 * cap minus the reserved tail, floored at 0 (a cap of 0 denies every
 * attempt — the store's own contract).
 */
export function effectiveAutonomousCap(hardCap: number): number {
  return Math.max(0, hardCap - AI_BUDGET_PRESSURE_RESERVE_UNITS);
}

/**
 * Classify ONE denied authorization. Best-effort readback of the
 * charged-attempt counter; on read error the denial is HARD (the
 * conservative direction — never soften a denial on ambiguity).
 */
export async function classifyAiBudgetDenial(
  executor: DbExecutor,
  input: {
    readonly provider: AiProvider;
    /** The provider's HARD daily cap (AI_DAILY_REQUEST_ATTEMPT_CAPS). */
    readonly hardCap: number;
    readonly nowMs: number;
  },
): Promise<'hard' | 'reserve'> {
  let chargedAttempts: number;
  try {
    chargedAttempts = await readAiBudget(executor, {
      provider: input.provider,
      nowMs: input.nowMs,
    });
  } catch {
    return 'hard';
  }
  const effectiveCap = effectiveAutonomousCap(input.hardCap);
  const insideReserveWindow = chargedAttempts >= effectiveCap && chargedAttempts < input.hardCap;
  return insideReserveWindow ? 'reserve' : 'hard';
}

/**
 * Best-effort pressure warning after a GRANTED authorization: one
 * readback; the sanitized warning fires when the counter crosses the
 * threshold EXACTLY (naturally once per provider per Tehran day,
 * modulo refunds re-crossing — bounded and honest). A failed readback
 * never affects the run.
 */
export async function noteBudgetPressureWarning(
  executor: DbExecutor,
  logger: Logger,
  input: { readonly provider: AiProvider; readonly nowMs: number },
): Promise<void> {
  try {
    const chargedAttempts = await readAiBudget(executor, {
      provider: input.provider,
      nowMs: input.nowMs,
    });
    if (chargedAttempts === AI_BUDGET_PRESSURE_WARNING_REQUESTS) {
      logger.warn('ai.budget.pressure_warning', {
        provider: input.provider,
        chargedAttempts,
        warningThreshold: AI_BUDGET_PRESSURE_WARNING_REQUESTS,
      });
    }
  } catch {
    // Visibility only — a failed pressure readback is a silent no-op.
  }
}
