import { beforeEach, describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryMeta, DbRows } from '../../src/adapters/db/db-executor';
import { tehranBudgetDay } from '../../src/shared/time/tehran-day';
import { createAiDraftService } from '../../src/application/ai/draft-service';
import { createEventRelationService } from '../../src/application/ai/event-relation-service';
import { buildAiCandidateLadder } from '../../src/application/ai/ai-ladder';
import {
  AI_CIRCUIT_BREAKER_COOLDOWN_MS,
  aiCircuitBreakerSettingsKey,
} from '../../src/application/ai/ai-circuit-breaker';
import { createAiInboundRewriter } from '../../src/application/inbound/ai-rewriter';
import type { AiCallOutcome, AiProvider, AiProviderPort } from '../../src/domain/ai/types';
import { createLogger } from '../../src/observability/logger';

/**
 * Backup-account failover + budget pressure (ai-policy-v2.3, ADR-0069)
 * over INJECTED FAKES — fully offline. The stateful fake below enforces
 * the REAL store semantics per provider: guarded authorize under the cap
 * the service passed (the effective cap), per-provider refund rows, and
 * per-provider breaker settings keys — the plain always-null fakes
 * cannot observe any of it.
 *
 * Covering the design's test list (ADR-0069 §8.7):
 * primary denied → backup authorized and called; backup denied →
 * terminal; backup auth_failed → refunded, no retry loop; Tehran
 * midnight rollover → primary authorized again; breaker open on primary
 * → circuit_open with NO failover; an open BACKUP breaker skips only
 * the backup candidates; refunds never cross provider keys; the reserve
 * window defers typed budget_pressure; the warning fires at the 80%
 * crossing; the failover flag/port conjunction fails closed.
 */

const silentLogger = createLogger({ level: 'error', sink: () => undefined });

const VALID_DRAFT_JSON = JSON.stringify({
  headlineFa: 'تیتر خبر',
  categoryEmoji: '🔵',
  trustLabel: '#گزارش‌شده',
  summaryFa: 'خلاصهٔ خبر',
  claims: [{ text: 'ادعای اول', evidenceIds: ['ev-1'] }],
});

const VALID_REQUEST = {
  taskType: 'news_draft',
  locale: 'fa',
  evidence: [{ id: 'ev-1', text: 'متن شاهد عمومی' }],
};

const REWRITE_INPUT = { text: 'متن خام', category: 'news' as const, isCaption: false };

// Day 1 Tehran 2025-10-06 15:30; DAY2 = Tehran 2025-10-07 00:01.
const DAY1 = Date.UTC(2025, 9, 6, 12, 0, 0);
const DAY2 = Date.UTC(2025, 9, 6, 20, 31, 0);
const DAY1_BUCKET = tehranBudgetDay(DAY1);
const DAY2_BUCKET = tehranBudgetDay(DAY2);

function createFakeClock(start = DAY1) {
  let current = start;
  return {
    now: () => current,
    setNow(value: number) {
      current = value;
    },
  };
}

/**
 * Stateful fake executor with PER-PROVIDER budgets and breaker rows,
 * enforcing the SAME guarded-cap semantics as the real store:
 * - authorize (batch): requests + 1 <= cap evaluated against the CURRENT
 *   row (the cap param is what the service passed — the effective cap);
 *   a new-day INSERT..SELECT creates requests=1 under the same guard.
 * - refund (run): per-provider decrement floored at 0.
 * - readback (first): the charged-attempt counter for readAiBudget and
 *   the per-provider breaker row for the settings SELECT.
 */
interface StatefulFake extends DbExecutor {
  readonly settings: Map<string, string>;
  readonly budgets: Map<string, number>;
  batchCalls: number;
  refundCalls: number;
  failRefunds: boolean;
  denyAll: boolean;
}

function budgetKey(provider: string, bucketDate: string): string {
  return `${provider}|${bucketDate}`;
}

function createStatefulExecutor(): StatefulFake {
  const state: StatefulFake = {
    settings: new Map<string, string>(),
    budgets: new Map<string, number>(),
    batchCalls: 0,
    refundCalls: 0,
    failRefunds: false,
    denyAll: false,
    async query<T>(): Promise<DbRows<T>> {
      return { rows: [] as T[], meta: { durationMs: 0, changes: 0 } };
    },
    async first<T>(statement: { sql: string; params?: readonly unknown[] }): Promise<T | null> {
      if (statement.sql.includes('FROM settings')) {
        const key = statement.params?.[0] as string;
        const valueJson = state.settings.get(key);
        return (valueJson === undefined ? null : { value_json: valueJson }) as T | null;
      }
      if (statement.sql.includes('FROM budgets')) {
        const provider = statement.params?.[0] as string;
        const bucketDate = statement.params?.[1] as string;
        const requests = state.budgets.get(budgetKey(provider, bucketDate)) ?? 0;
        return {
          requests,
          input_tokens: 0,
          output_tokens: 0,
        } as T;
      }
      return null;
    },
    async run(statement: { sql: string; params?: readonly unknown[] }): Promise<DbQueryMeta> {
      if (statement.sql.includes('INSERT INTO settings')) {
        const key = statement.params?.[0] as string;
        const valueJson = statement.params?.[1] as string;
        state.settings.set(key, valueJson);
        return { durationMs: 0, changes: 1 };
      }
      if (statement.sql.includes('requests = requests - 1')) {
        state.refundCalls += 1;
        if (state.failRefunds) {
          throw new Error('refund write down');
        }
        const nowMs = statement.params?.[0] as number;
        const provider = statement.params?.[1] as string;
        const key = budgetKey(provider, tehranBudgetDay(nowMs));
        const current = state.budgets.get(key) ?? 0;
        if (current > 0) {
          state.budgets.set(key, current - 1);
          return { durationMs: 0, changes: 1 };
        }
        return { durationMs: 0, changes: 0 };
      }
      return { durationMs: 0, changes: 1 };
    },
    async batch(
      statements: readonly { sql: string; params?: readonly unknown[] }[],
    ): Promise<readonly DbQueryMeta[]> {
      state.batchCalls += 1;
      if (state.denyAll) {
        return statements.map(() => ({ durationMs: 0, changes: 0 }));
      }
      // UPDATE params: [nowMs, provider, bucketDate, cap].
      const update = statements[0];
      const updateParams = update?.params ?? [];
      const updateCap = updateParams[3] as number;
      const updateProvider = updateParams[1] as string;
      const updateBucket = updateParams[2] as string;
      const current = state.budgets.get(budgetKey(updateProvider, updateBucket)) ?? 0;
      if (current + 1 <= updateCap) {
        state.budgets.set(budgetKey(updateProvider, updateBucket), current + 1);
        return [
          { durationMs: 0, changes: 1 },
          { durationMs: 0, changes: 0 },
        ];
      }
      // INSERT..SELECT params: [provider, bucketDate, nowMs, cap, ...].
      const insertParams = statements[1]?.params ?? [];
      const insertProvider = insertParams[0] as string;
      const insertBucket = insertParams[1] as string;
      const insertCap = insertParams[3] as number;
      if (!state.budgets.has(budgetKey(insertProvider, insertBucket)) && 1 <= insertCap) {
        state.budgets.set(budgetKey(insertProvider, insertBucket), 1);
        return [
          { durationMs: 0, changes: 0 },
          { durationMs: 0, changes: 1 },
        ];
      }
      return [
        { durationMs: 0, changes: 0 },
        { durationMs: 0, changes: 0 },
      ];
    },
  };
  return state;
}

/** Charge a provider's day row DIRECTLY (pre-seeding test state). */
function seedBudgets(
  executor: StatefulFake,
  provider: AiProvider,
  bucketDate: string,
  count: number,
): void {
  executor.budgets.set(budgetKey(provider, bucketDate), count);
}

/** Open one provider's breaker DIRECTLY (pre-seeding test state). */
function openBreaker(
  executor: StatefulFake,
  provider: AiProvider,
  settingsKey: (provider: AiProvider) => string,
  nowMs: number,
): void {
  executor.settings.set(
    settingsKey(provider),
    JSON.stringify({
      state: 'open',
      consecutive_failures: 5,
      opened_at_ms: nowMs,
      updated_at_ms: nowMs,
    }),
  );
}

interface FakePort {
  readonly provider: AiProvider;
  readonly calls: string[];
  setOutcomes(outcomes: readonly AiCallOutcome[]): void;
}

function createFakePort(provider: AiProvider): FakePort & AiProviderPort {
  const calls: string[] = [];
  const queue: AiCallOutcome[] = [];
  return {
    provider,
    calls,
    setOutcomes(next: readonly AiCallOutcome[]) {
      queue.length = 0;
      queue.push(...next);
    },
    async complete(input: { modelId: string }) {
      calls.push(input.modelId);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('fake port exhausted its scripted outcomes');
      }
      return next;
    },
  } as FakePort & AiProviderPort;
}

describe('shared ladder builder (ai-policy-v2.3)', () => {
  it('orders the ladder: primary → alternate → BACKUP primary → BACKUP alternate → Gemini', () => {
    const ladder = buildAiCandidateLadder({
      workersAiPrimaryPresent: true,
      failoverEnabled: true,
      backupPortPresent: true,
      geminiEnabled: true,
      geminiKeyPresent: true,
      geminiPortPresent: true,
      geminiEligible: true,
    });
    expect(ladder.candidates.map((candidate) => candidate.provider)).toEqual([
      'workers-ai',
      'workers-ai',
      'workers-ai-backup',
      'workers-ai-backup',
      'gemini',
      'gemini',
      'gemini',
    ]);
  });

  it('the BACKUP is absent unless BOTH the kill switch AND the wired port are present (fail-closed conjunction)', () => {
    const both = buildAiCandidateLadder({
      workersAiPrimaryPresent: true,
      failoverEnabled: true,
      backupPortPresent: true,
      geminiEnabled: false,
      geminiKeyPresent: false,
      geminiPortPresent: false,
      geminiEligible: false,
    });
    expect(both.candidates.map((candidate) => candidate.provider)).not.toContain('gemini');
    expect(both.candidates.map((candidate) => candidate.provider)).toContain('workers-ai-backup');
    const flagOnly = buildAiCandidateLadder({
      workersAiPrimaryPresent: true,
      failoverEnabled: true,
      backupPortPresent: false,
      geminiEnabled: false,
      geminiKeyPresent: false,
      geminiPortPresent: false,
      geminiEligible: false,
    });
    expect(flagOnly.candidates.map((candidate) => candidate.provider)).not.toContain(
      'workers-ai-backup',
    );
    const portOnly = buildAiCandidateLadder({
      workersAiPrimaryPresent: true,
      failoverEnabled: false,
      backupPortPresent: true,
      geminiEnabled: false,
      geminiKeyPresent: false,
      geminiPortPresent: false,
      geminiEligible: false,
    });
    expect(portOnly.candidates.map((candidate) => candidate.provider)).not.toContain(
      'workers-ai-backup',
    );
  });

  it('Gemini dropped ONLY for unverified eligibility is reported distinctly', () => {
    const ineligible = buildAiCandidateLadder({
      workersAiPrimaryPresent: false,
      failoverEnabled: false,
      backupPortPresent: false,
      geminiEnabled: true,
      geminiKeyPresent: true,
      geminiPortPresent: true,
      geminiEligible: false,
    });
    expect(ineligible.geminiSkippedIneligible).toBe(true);
    const unconfigured = buildAiCandidateLadder({
      workersAiPrimaryPresent: false,
      failoverEnabled: false,
      backupPortPresent: false,
      geminiEnabled: false,
      geminiKeyPresent: false,
      geminiPortPresent: false,
      geminiEligible: false,
    });
    expect(unconfigured.geminiSkippedIneligible).toBe(false);
  });
});

describe('draft service — failover to the backup account', () => {
  let executor: StatefulFake;
  let clock: ReturnType<typeof createFakeClock>;
  let primaryPort: FakePort & AiProviderPort;
  let backupPort: FakePort & AiProviderPort;

  beforeEach(() => {
    executor = createStatefulExecutor();
    clock = createFakeClock();
    primaryPort = createFakePort('workers-ai');
    backupPort = createFakePort('workers-ai-backup');
  });

  function buildService() {
    return createAiDraftService({
      executor,
      ports: { 'workers-ai': primaryPort, 'workers-ai-backup': backupPort },
      clock,
      logger: silentLogger,
      config: {
        aiEnabled: true,
        geminiEnabled: false,
        failoverEnabled: true,
        workersAiBindingPresent: true,
        geminiApiKeyPresent: false,
      },
    });
  }

  it('primary budget denied → the BACKUP is authorized and called; the draft succeeds there', async () => {
    // The primary day row sits at the EFFECTIVE cap (120 − 6 = 114):
    // the next primary authorization denies; the backup's own row is empty.
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 114);
    backupPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome.kind).toBe('draft');
    if (outcome.kind === 'draft') {
      expect(outcome.usage[0]?.provider).toBe('workers-ai-backup');
    }
    expect(primaryPort.calls).toHaveLength(0); // denial is a ledger skip — 0 calls
    expect(backupPort.calls).toHaveLength(1); // the failover call
    const attempts = outcome.kind === 'draft' ? outcome.attempts : [];
    expect(attempts[0]).toMatchObject({ provider: 'workers-ai', outcome: 'quota_denied' });
    // The primary alternate is LEDGERED as futile (same shared bucket) before
    // the ladder reaches the backup account.
    expect(attempts[1]).toMatchObject({ provider: 'workers-ai', outcome: 'skipped_shared_quota' });
    expect(attempts[2]).toMatchObject({ provider: 'workers-ai-backup', outcome: 'succeeded' });
    // Per-account rows: the primary stayed at 114; the backup charged 1.
    expect(executor.budgets.get(budgetKey('workers-ai', DAY1_BUCKET))).toBe(114);
    expect(executor.budgets.get(budgetKey('workers-ai-backup', DAY1_BUCKET))).toBe(1);
  });

  it('backup budget ALSO hard-denied → the terminal budget_denied', async () => {
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 120);
    seedBudgets(executor, 'workers-ai-backup', DAY1_BUCKET, 120);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'budget_denied' });
    expect(primaryPort.calls).toHaveLength(0);
    expect(backupPort.calls).toHaveLength(0);
  });

  it('primary denied inside the RESERVE window (backup unreachable) → the early, retryable budget_pressure', async () => {
    // The reserve-only service: the primary day row sits at the effective
    // cap (114) and there is no backup — the chain backs off EARLY with
    // the typed, retryable pressure instead of riding to the terminal
    // hard denial.
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 114);
    const service = createAiDraftService({
      executor,
      ports: { 'workers-ai': primaryPort },
      clock,
      logger: silentLogger,
      config: {
        aiEnabled: true,
        geminiEnabled: false,
        failoverEnabled: false,
        workersAiBindingPresent: true,
        geminiApiKeyPresent: false,
      },
    });
    const outcome = await service.generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'budget_pressure' });
    expect(primaryPort.calls).toHaveLength(0);
    expect(backupPort.calls).toHaveLength(0);
  });

  it('a HARD denial anywhere in the ladder dominates the classification (terminal budget_denied)', async () => {
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 120); // hard
    seedBudgets(executor, 'workers-ai-backup', DAY1_BUCKET, 114); // reserve
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'budget_denied' });
    expect(primaryPort.calls).toHaveLength(0);
    expect(backupPort.calls).toHaveLength(0);
  });

  it('backup auth_failed → the backup charge is refunded and the ladder stops (no retry loop)', async () => {
    primaryPort.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    backupPort.setOutcomes([{ kind: 'auth_failed' }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_auth_failed' });
    expect(primaryPort.calls).toHaveLength(2); // gemma transient → qwen transient
    expect(backupPort.calls).toHaveLength(1);
    // Refunds NEVER cross provider keys: both accounts back at 0.
    expect(executor.budgets.get(budgetKey('workers-ai', DAY1_BUCKET)) ?? 0).toBe(0);
    expect(executor.budgets.get(budgetKey('workers-ai-backup', DAY1_BUCKET)) ?? 0).toBe(0);
    expect(executor.refundCalls).toBe(3);
    // Auth failures never move ANY breaker counter: the PRIMARY row exists
    // only from its two transient failures (count 2, closed); the BACKUP
    // (auth_failed) never wrote a row at all.
    expect(
      JSON.parse(executor.settings.get(aiCircuitBreakerSettingsKey('workers-ai')) ?? '{}'),
    ).toMatchObject({ consecutive_failures: 2, state: 'closed' });
    expect(executor.settings.has(aiCircuitBreakerSettingsKey('workers-ai-backup'))).toBe(false);
  });

  it('Tehran midnight rollover → the primary cap replenishes and the ladder uses primary again', async () => {
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 114);
    backupPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const day1 = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(day1.kind).toBe('draft');
    expect(backupPort.calls).toHaveLength(1); // day 1: failover to backup

    clock.setNow(DAY2); // Tehran 2025-10-07 00:01 — a fresh budget day
    primaryPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const day2 = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(day2.kind).toBe('draft');
    if (day2.kind === 'draft') {
      expect(day2.usage[0]?.provider).toBe('workers-ai');
    }
    expect(primaryPort.calls).toHaveLength(1); // day 2: primary again
    expect(executor.budgets.get(budgetKey('workers-ai', DAY2_BUCKET))).toBe(1);
    expect(executor.budgets.get(budgetKey('workers-ai-backup', DAY2_BUCKET))).toBeUndefined();
  });

  it('breaker open on the PRIMARY → typed circuit_open with ZERO failover and zero charges', async () => {
    openBreaker(executor, 'workers-ai', aiCircuitBreakerSettingsKey, DAY1 - 1_000);
    const portCallsBefore = backupPort.calls.length;
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toEqual({ kind: 'deferred', reason: 'circuit_open', attempts: [] });
    expect(primaryPort.calls).toHaveLength(0);
    expect(backupPort.calls).toHaveLength(portCallsBefore); // NO failover
    expect(executor.batchCalls).toBe(0); // ZERO charges
  });

  it('breaker open on the BACKUP → only the backup candidates skip; the ladder still works the primary', async () => {
    openBreaker(executor, 'workers-ai-backup', aiCircuitBreakerSettingsKey, DAY1 - 1_000);
    // The primary fails transiently so the ladder WALKS to the backup
    // candidates — both are then skipped by the backup's own breaker.
    primaryPort.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    expect(backupPort.calls).toHaveLength(0); // backup breaker open → skipped
    expect(primaryPort.calls).toHaveLength(2);
    const attempts = outcome.kind === 'deferred' ? outcome.attempts : [];
    // BOTH backup candidates (gemma + qwen) are ledgered as breaker skips.
    expect(attempts.filter((attempt) => attempt.provider === 'workers-ai-backup')).toHaveLength(2);
    expect(attempts.find((attempt) => attempt.provider === 'workers-ai-backup')).toMatchObject({
      outcome: 'skipped_circuit_open',
    });
  });

  it('transient failures across BOTH accounts refund their OWN rows and count their OWN breakers', async () => {
    primaryPort.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    backupPort.setOutcomes([{ kind: 'transient' }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    expect(executor.refundCalls).toBe(3);
    expect(executor.budgets.get(budgetKey('workers-ai', DAY1_BUCKET)) ?? 0).toBe(0);
    expect(executor.budgets.get(budgetKey('workers-ai-backup', DAY1_BUCKET)) ?? 0).toBe(0);
    // Per-account breaker counters: primary 2, backup 1 — never mixed.
    expect(
      JSON.parse(executor.settings.get(aiCircuitBreakerSettingsKey('workers-ai')) ?? '{}'),
    ).toMatchObject({ consecutive_failures: 2, state: 'closed' });
    expect(
      JSON.parse(executor.settings.get(aiCircuitBreakerSettingsKey('workers-ai-backup')) ?? '{}'),
    ).toMatchObject({ consecutive_failures: 1, state: 'closed' });
  });

  it('the kill switch OFF keeps the ladder v2.2-exact even with the backup port wired', async () => {
    const service = createAiDraftService({
      executor,
      ports: { 'workers-ai': primaryPort, 'workers-ai-backup': backupPort },
      clock,
      logger: silentLogger,
      config: {
        aiEnabled: true,
        geminiEnabled: false,
        failoverEnabled: false,
        workersAiBindingPresent: true,
        geminiApiKeyPresent: false,
      },
    });
    primaryPort.setOutcomes([{ kind: 'transient' }, { kind: 'transient' }]);
    const outcome = await service.generateNewsDraft(VALID_REQUEST);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'provider_unavailable' });
    expect(primaryPort.calls).toHaveLength(2);
    expect(backupPort.calls).toHaveLength(0); // the backup never ran
  });

  it('missing primary binding + failover on → the ladder starts at the backup (graceful degradation)', async () => {
    const service = createAiDraftService({
      executor,
      ports: { 'workers-ai-backup': backupPort },
      clock,
      logger: silentLogger,
      config: {
        aiEnabled: true,
        geminiEnabled: false,
        failoverEnabled: true,
        workersAiBindingPresent: false,
        geminiApiKeyPresent: false,
      },
    });
    backupPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const outcome = await service.generateNewsDraft(VALID_REQUEST);
    expect(outcome.kind).toBe('draft');
    if (outcome.kind === 'draft') {
      expect(outcome.usage[0]?.provider).toBe('workers-ai-backup');
    }
    expect(backupPort.calls).toHaveLength(1);
  });
});

describe('draft service — budget pressure governance (ai-policy-v2.3)', () => {
  let executor: StatefulFake;
  let clock: ReturnType<typeof createFakeClock>;
  let primaryPort: FakePort & AiProviderPort;
  let backupPort: FakePort & AiProviderPort;
  const logLines: string[] = [];
  const capturingLogger = createLogger({
    level: 'warn',
    sink: (level: unknown, line: string) => {
      logLines.push(line);
    },
  });

  beforeEach(() => {
    executor = createStatefulExecutor();
    clock = createFakeClock();
    primaryPort = createFakePort('workers-ai');
    backupPort = createFakePort('workers-ai-backup');
    logLines.length = 0;
  });

  function buildService() {
    return createAiDraftService({
      executor,
      ports: { 'workers-ai': primaryPort, 'workers-ai-backup': backupPort },
      clock,
      logger: capturingLogger,
      config: {
        aiEnabled: true,
        geminiEnabled: false,
        failoverEnabled: true,
        workersAiBindingPresent: true,
        geminiApiKeyPresent: false,
      },
    });
  }

  it('the WARNING fires once at the 96 crossing — counts only, never key material', async () => {
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 95); // next grant lands on 96
    primaryPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    const outcome = await buildService().generateNewsDraft(VALID_REQUEST);
    expect(outcome.kind).toBe('draft');
    const warnings = logLines.filter((line) => line.includes('ai.budget.pressure_warning'));
    expect(warnings).toHaveLength(1);
    const parsed = JSON.parse(warnings[0] ?? '{}') as {
      provider?: string;
      chargedAttempts?: number;
    };
    expect(parsed.provider).toBe('workers-ai');
    expect(parsed.chargedAttempts).toBe(96);
  });

  it('a charge below the warning threshold never warns', async () => {
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 10);
    primaryPort.setOutcomes([{ kind: 'ok', rawText: VALID_DRAFT_JSON }]);
    await buildService().generateNewsDraft(VALID_REQUEST);
    expect(logLines.filter((line) => line.includes('ai.budget.pressure_warning'))).toHaveLength(0);
  });
});

describe('event-relation service — breaker + refund hooks (ai-policy-v2.3 gap a)', () => {
  let executor: StatefulFake;
  let clock: ReturnType<typeof createFakeClock>;
  let primaryPort: FakePort & AiProviderPort;
  let backupPort: FakePort & AiProviderPort;

  beforeEach(() => {
    executor = createStatefulExecutor();
    clock = createFakeClock();
    primaryPort = createFakePort('workers-ai');
    backupPort = createFakePort('workers-ai-backup');
  });

  function buildService() {
    return createEventRelationService({
      executor,
      ports: { 'workers-ai': primaryPort, 'workers-ai-backup': backupPort },
      clock,
      logger: silentLogger,
      config: {
        eventRelationEnabled: true,
        aiEnabled: true,
        geminiEnabled: false,
        failoverEnabled: true,
        workersAiBindingPresent: true,
        geminiApiKeyPresent: false,
      },
    });
  }

  function pairRequest(pairId: 'erp-1' | 'erp-2'): unknown {
    return {
      pairId,
      sideA: {
        evidenceId: 'ev-a',
        text: 'متن A',
        storyId: 'st-1',
        sourceItemId: 'si-1',
        contentHash: 'a'.repeat(64),
      },
      sideB: {
        evidenceId: 'ev-b',
        text: 'متن B',
        storyId: 'st-2',
        sourceItemId: 'si-2',
        contentHash: 'b'.repeat(64),
      },
      canonicalInputHash: 'c'.repeat(64),
    };
  }

  function relationOk(pairId: 'erp-1' | 'erp-2'): string {
    return JSON.stringify({
      pairId,
      verdict: 'different_event_proposed',
      reasons: ['دلیل'],
      references: [
        { side: 'A', evidenceId: 'ev-a' },
        { side: 'B', evidenceId: 'ev-b' },
      ],
      conflicts: [],
    });
  }

  it('a deadline_exceeded attempt is REFUNDED and counts THIS account breaker only', async () => {
    primaryPort.setOutcomes([{ kind: 'deadline_exceeded' }]);
    const outcome = await buildService().evaluateEventRelations({ pairs: [pairRequest('erp-1')] });
    expect(outcome).toMatchObject({ kind: 'decisions' });
    const pair = outcome.kind === 'decisions' ? outcome.pairs[0] : undefined;
    expect(pair).toMatchObject({ kind: 'deferred', reason: 'step_deadline' });
    expect(executor.budgets.get(budgetKey('workers-ai', DAY1_BUCKET)) ?? 0).toBe(0);
    expect(executor.refundCalls).toBe(1);
    expect(
      JSON.parse(executor.settings.get(aiCircuitBreakerSettingsKey('workers-ai')) ?? '{}'),
    ).toMatchObject({ consecutive_failures: 1, state: 'closed' });
    expect(executor.settings.has(aiCircuitBreakerSettingsKey('workers-ai-backup'))).toBe(false);
  });

  it('breaker open on the PRIMARY → the pair is circuit_open with ZERO failover', async () => {
    openBreaker(executor, 'workers-ai', aiCircuitBreakerSettingsKey, DAY1 - 1_000);
    const outcome = await buildService().evaluateEventRelations({ pairs: [pairRequest('erp-1')] });
    const pair = outcome.kind === 'decisions' ? outcome.pairs[0] : undefined;
    expect(pair).toMatchObject({ kind: 'deferred', reason: 'circuit_open' });
    expect(primaryPort.calls).toHaveLength(0);
    expect(backupPort.calls).toHaveLength(0);
    expect(executor.batchCalls).toBe(0);
  });

  it('primary denied → the pair defers; the NEXT pair reaches the backup account', async () => {
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 114);
    backupPort.setOutcomes([{ kind: 'ok', rawText: relationOk('erp-2') }]);
    const outcome = await buildService().evaluateEventRelations({
      pairs: [pairRequest('erp-1'), pairRequest('erp-2')],
    });
    expect(outcome.kind).toBe('decisions');
    if (outcome.kind === 'decisions') {
      expect(outcome.pairs[0]).toMatchObject({ kind: 'deferred', reason: 'budget_pressure' });
      // The second pair walks past the skipped primary bucket to the backup.
      expect(outcome.pairs[1]?.kind).toBe('evaluated');
      if (outcome.pairs[1]?.kind === 'evaluated') {
        expect(outcome.pairs[1].usage.provider).toBe('workers-ai-backup');
      }
    }
    expect(backupPort.calls).toHaveLength(1);
  });

  it('a success closes THIS account breaker and keeps the charge', async () => {
    executor.settings.set(
      aiCircuitBreakerSettingsKey('workers-ai'),
      JSON.stringify({
        state: 'closed',
        consecutive_failures: 2,
        opened_at_ms: null,
        updated_at_ms: DAY1,
      }),
    );
    primaryPort.setOutcomes([{ kind: 'ok', rawText: relationOk('erp-1') }]);
    const outcome = await buildService().evaluateEventRelations({ pairs: [pairRequest('erp-1')] });
    expect(outcome.kind).toBe('decisions');
    if (outcome.kind === 'decisions') {
      expect(outcome.pairs[0]?.kind).toBe('evaluated');
    }
    expect(executor.budgets.get(budgetKey('workers-ai', DAY1_BUCKET))).toBe(1);
    expect(executor.refundCalls).toBe(0);
    expect(
      JSON.parse(executor.settings.get(aiCircuitBreakerSettingsKey('workers-ai')) ?? '{}'),
    ).toMatchObject({ state: 'closed', consecutive_failures: 0 });
  });
});

describe('inbound rewriter — failover + pressure (ai-policy-v2.3)', () => {
  let executor: StatefulFake;
  let clock: ReturnType<typeof createFakeClock>;
  let primaryPort: FakePort & AiProviderPort;
  let backupPort: FakePort & AiProviderPort;

  beforeEach(() => {
    executor = createStatefulExecutor();
    clock = createFakeClock();
    primaryPort = createFakePort('workers-ai');
    backupPort = createFakePort('workers-ai-backup');
  });

  function buildService() {
    return createAiInboundRewriter({
      executor,
      ports: { 'workers-ai': primaryPort, 'workers-ai-backup': backupPort },
      clock,
      logger: silentLogger,
      config: {
        aiEnabled: true,
        geminiEnabled: false,
        failoverEnabled: true,
        workersAiBindingPresent: true,
        geminiApiKeyPresent: false,
      },
    });
  }

  it('primary denied → the rewrite succeeds on the backup account', async () => {
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 114);
    backupPort.setOutcomes([{ kind: 'ok', rawText: 'متن بازنویسی‌شده.' }]);
    const outcome = await buildService().rewrite(REWRITE_INPUT);
    expect(outcome).toMatchObject({ kind: 'ok', attempts: 1 });
    expect(primaryPort.calls).toHaveLength(0);
    expect(backupPort.calls).toHaveLength(1);
    expect(executor.budgets.get(budgetKey('workers-ai-backup', DAY1_BUCKET))).toBe(1);
  });

  it('reserve-window denial on the only reachable account → typed budget_pressure', async () => {
    seedBudgets(executor, 'workers-ai', DAY1_BUCKET, 114);
    const service = createAiInboundRewriter({
      executor,
      ports: { 'workers-ai': primaryPort },
      clock,
      logger: silentLogger,
      config: {
        aiEnabled: true,
        geminiEnabled: false,
        failoverEnabled: false, // backup unreachable in this deployment
        workersAiBindingPresent: true,
        geminiApiKeyPresent: false,
      },
    });
    const outcome = await service.rewrite(REWRITE_INPUT);
    expect(outcome).toMatchObject({ kind: 'deferred', reason: 'budget_pressure' });
    expect(primaryPort.calls).toHaveLength(0);
  });
});

describe('per-account breaker cooldown semantics (ai-policy-v2.3)', () => {
  it('a half-open probe after the cooldown uses the same per-provider key', async () => {
    const executor = createStatefulExecutor();
    openBreaker(executor, 'workers-ai-backup', aiCircuitBreakerSettingsKey, DAY1);
    // Inside the cooldown: denied.
    const inside = await import('../../src/application/ai/ai-circuit-breaker').then((mod) =>
      mod.checkAiCircuitBreaker(
        executor,
        DAY1 + AI_CIRCUIT_BREAKER_COOLDOWN_MS - 1,
        'workers-ai-backup',
      ),
    );
    expect(inside.allow).toBe(false);
    // The PRIMARY stays untouched by the backup's open breaker.
    const primary = await import('../../src/application/ai/ai-circuit-breaker').then((mod) =>
      mod.checkAiCircuitBreaker(executor, DAY1 + AI_CIRCUIT_BREAKER_COOLDOWN_MS - 1, 'workers-ai'),
    );
    expect(primary.allow).toBe(true);
    // After the cooldown the BACKUP admits its probe.
    const probe = await import('../../src/application/ai/ai-circuit-breaker').then((mod) =>
      mod.checkAiCircuitBreaker(
        executor,
        DAY1 + AI_CIRCUIT_BREAKER_COOLDOWN_MS,
        'workers-ai-backup',
      ),
    );
    expect(probe).toMatchObject({ allow: true, probe: true });
  });
});
