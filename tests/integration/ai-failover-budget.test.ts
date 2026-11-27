import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  AI_BUDGET_SCOPE,
  authorizeAiRequestAttempt,
  readAiBudget,
  refundAiRequestAttempt,
} from '../../src/adapters/db/ai-budget-store';
import {
  checkAiCircuitBreaker,
  recordAiCircuitBreakerFailure,
  aiCircuitBreakerSettingsKey,
  AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
} from '../../src/application/ai/ai-circuit-breaker';
import { tehranBudgetDay } from '../../src/shared/time/tehran-day';

/**
 * Backup-account failover store semantics on REAL disposable workerd D1
 * (ai-policy-v2.3, ADR-0069): per-ACCOUNT budget rows without any
 * migration (the provider key IS the account), refund isolation across
 * provider keys, and per-account breaker settings keys. Fully offline —
 * no provider call happens anywhere here.
 */

const DAY1 = Date.UTC(2025, 9, 6, 12, 0, 0); // Tehran 2025-10-06 15:30
const DAY2 = Date.UTC(2025, 9, 6, 20, 31, 0); // Tehran 2025-10-07 00:01
const NOW = DAY1;

const executor: DbExecutor = createDbExecutor(env.DB);

beforeEach(async () => {
  await applyMigrations(env.DB);
  await executor.run({ sql: `DELETE FROM budgets WHERE scope = '${AI_BUDGET_SCOPE}'` });
  await executor.run({ sql: "DELETE FROM settings WHERE key LIKE 'ai.circuit_breaker%'" });
});

describe('per-account budget rows (no migration)', () => {
  it('the backup provider key gets its OWN Tehran-day row, independent of the primary', async () => {
    expect(
      await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 120, nowMs: NOW }),
    ).toMatchObject({ kind: 'authorized', bucketDate: '2025-10-06' });
    expect(
      await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 120, nowMs: NOW }),
    ).toMatchObject({ kind: 'authorized' });
    expect(
      await authorizeAiRequestAttempt(executor, {
        provider: 'workers-ai-backup',
        cap: 120,
        nowMs: NOW,
      }),
    ).toMatchObject({ kind: 'authorized' });
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: NOW })).toBe(2);
    expect(await readAiBudget(executor, { provider: 'workers-ai-backup', nowMs: NOW })).toBe(1);
  });

  it('each account denies under ITS OWN cap — the primary exhausting never denies the backup', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 3, nowMs: NOW }))
          .kind,
      ).toBe('authorized');
    }
    expect(
      (await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 3, nowMs: NOW }))
        .kind,
    ).toBe('denied'); // primary at ITS cap
    expect(
      (
        await authorizeAiRequestAttempt(executor, {
          provider: 'workers-ai-backup',
          cap: 3,
          nowMs: NOW,
        })
      ).kind,
    ).toBe('authorized'); // the backup's own row is untouched
  });

  it('refunds NEVER cross provider keys — a backup refund decrements only the backup row', async () => {
    await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 120, nowMs: NOW });
    await authorizeAiRequestAttempt(executor, {
      provider: 'workers-ai-backup',
      cap: 120,
      nowMs: NOW,
    });
    await authorizeAiRequestAttempt(executor, {
      provider: 'workers-ai-backup',
      cap: 120,
      nowMs: NOW,
    });
    expect(
      await refundAiRequestAttempt(executor, { provider: 'workers-ai-backup', nowMs: NOW }),
    ).toBe(true);
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: NOW })).toBe(1);
    expect(await readAiBudget(executor, { provider: 'workers-ai-backup', nowMs: NOW })).toBe(1);
    // A refund with no outstanding charge on a row is a floored no-op.
    expect(
      await refundAiRequestAttempt(executor, { provider: 'workers-ai-backup', nowMs: NOW }),
    ).toBe(true);
    expect(
      await refundAiRequestAttempt(executor, { provider: 'workers-ai-backup', nowMs: NOW }),
    ).toBe(false);
    expect(await readAiBudget(executor, { provider: 'workers-ai-backup', nowMs: NOW })).toBe(0);
  });

  it('the reserve boundary: authorizing against the effective cap (cap − reserve) denies past it while the row stays readable', async () => {
    // The services pass the EFFECTIVE cap (120 − 6 = 114); the row shape is
    // unchanged — the store's guarded SQL evaluates the cap it was given.
    for (let i = 0; i < 114; i += 1) {
      expect(
        (
          await authorizeAiRequestAttempt(executor, {
            provider: 'workers-ai',
            cap: 114,
            nowMs: NOW,
          })
        ).kind,
      ).toBe('authorized');
    }
    expect(
      (await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 114, nowMs: NOW }))
        .kind,
    ).toBe('denied');
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: NOW })).toBe(114);
    // The HARD cap is a separate decision: a caller passing the hard cap
    // can still spend past the reserve window (the reserve is caller policy).
    expect(
      (await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 120, nowMs: NOW }))
        .kind,
    ).toBe('authorized');
  });

  it('the Tehran-midnight rollover opens a fresh row per account — switch-back needs no switch state', async () => {
    for (let i = 0; i < 120; i += 1) {
      await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 120, nowMs: DAY1 });
    }
    expect(
      (await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 120, nowMs: DAY1 }))
        .kind,
    ).toBe('denied'); // day 1 exhausted
    expect(
      (await authorizeAiRequestAttempt(executor, { provider: 'workers-ai', cap: 120, nowMs: DAY2 }))
        .kind,
    ).toBe('authorized'); // Tehran 2025-10-07 — a fresh row
    expect(await readAiBudget(executor, { provider: 'workers-ai', nowMs: DAY2 })).toBe(1);
  });
});

describe('per-account circuit breaker keys', () => {
  it('a breaker opened on the PRIMARY leaves the BACKUP closed (and vice versa)', async () => {
    for (let i = 0; i < AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await recordAiCircuitBreakerFailure(executor, NOW, 'workers-ai');
    }
    expect(await checkAiCircuitBreaker(executor, NOW, 'workers-ai')).toMatchObject({
      allow: false,
    });
    expect(await checkAiCircuitBreaker(executor, NOW, 'workers-ai-backup')).toMatchObject({
      allow: true,
      probe: false,
    });
    // The rows live under the distinct per-provider settings keys.
    const raw = await executor.first<{ value_json: string }>({
      sql: 'SELECT value_json FROM settings WHERE key = ?',
      params: [aiCircuitBreakerSettingsKey('workers-ai')],
    });
    expect(JSON.parse(raw?.value_json ?? '{}')).toMatchObject({ state: 'open' });
    expect(
      await executor.first<unknown>({
        sql: 'SELECT value_json FROM settings WHERE key = ?',
        params: [aiCircuitBreakerSettingsKey('workers-ai-backup')],
      }),
    ).toBeNull();
  });

  it('a half-open probe success closes exactly one account breaker', async () => {
    for (let i = 0; i < AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await recordAiCircuitBreakerFailure(executor, NOW, 'workers-ai-backup');
    }
    const probe = await checkAiCircuitBreaker(executor, NOW + 15 * 60 * 1000, 'workers-ai-backup');
    expect(probe).toMatchObject({ allow: true, probe: true });
    // A provider answer resets THAT account's counter and closes it.
    const { recordAiCircuitBreakerSuccess } =
      await import('../../src/application/ai/ai-circuit-breaker');
    await recordAiCircuitBreakerSuccess(executor, NOW + 15 * 60 * 1000, 'workers-ai-backup');
    expect(
      await checkAiCircuitBreaker(executor, NOW + 15 * 60 * 1000 + 1, 'workers-ai-backup'),
    ).toMatchObject({
      allow: true,
      probe: false,
    });
    expect(tehranBudgetDay(DAY1)).not.toBe(tehranBudgetDay(DAY2));
  });
});
