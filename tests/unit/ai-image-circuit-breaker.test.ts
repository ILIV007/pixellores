import { describe, expect, it } from 'vitest';
import type { DbExecutor } from '../../src/adapters/db/db-executor';
import {
  AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  AI_IMAGE_CIRCUIT_BREAKER_SCOPE,
  aiCircuitBreakerSettingsKey,
  checkAiCircuitBreaker,
  recordAiCircuitBreakerFailure,
  recordAiCircuitBreakerSuccess,
} from '../../src/application/ai/ai-circuit-breaker';

/**
 * Image/text breaker separation (ADR-0072) — the SAME breaker code over
 * TWO scopes: image failures open ONLY the image breaker
 * (`ai.circuit_breaker.image`) and never the text breaker
 * (`ai.circuit_breaker.workers-ai`), and vice versa. Offline, over a
 * minimal settings-table fake (the breaker reads/writes one row per
 * scope).
 */

function createSettingsFake() {
  const rows = new Map<string, string>();
  const executor = {
    async first({ params }: { params?: readonly unknown[] }) {
      const key = String(params?.[0] ?? '');
      const value = rows.get(key);
      return value === undefined ? null : { value_json: value };
    },
    async run({ sql, params }: { sql: string; params?: readonly unknown[] }) {
      if (!sql.includes('INSERT INTO settings')) {
        throw new Error('unexpected sql');
      }
      rows.set(String(params?.[0] ?? ''), String(params?.[1] ?? ''));
      return { changes: 1 };
    },
  } as unknown as DbExecutor;
  return { executor, rows };
}

const NOW = 1_700_000_000_000;

describe('image/text circuit-breaker separation', () => {
  it('opening the image breaker leaves the text breaker closed', async () => {
    const { executor } = createSettingsFake();
    for (let i = 0; i < AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await recordAiCircuitBreakerFailure(executor, NOW, AI_IMAGE_CIRCUIT_BREAKER_SCOPE);
    }
    const image = await checkAiCircuitBreaker(executor, NOW, AI_IMAGE_CIRCUIT_BREAKER_SCOPE);
    expect(image.allow).toBe(false);
    expect(image.snapshot.state).toBe('open');
    const text = await checkAiCircuitBreaker(executor, NOW, 'workers-ai');
    expect(text.allow).toBe(true);
    expect(text.snapshot.state).toBe('closed');
    expect(text.snapshot.consecutiveFailures).toBe(0);
  });

  it('opening the text breaker leaves the image breaker closed', async () => {
    const { executor } = createSettingsFake();
    for (let i = 0; i < AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await recordAiCircuitBreakerFailure(executor, NOW, 'workers-ai');
    }
    const text = await checkAiCircuitBreaker(executor, NOW, 'workers-ai');
    expect(text.allow).toBe(false);
    const image = await checkAiCircuitBreaker(executor, NOW, AI_IMAGE_CIRCUIT_BREAKER_SCOPE);
    expect(image.allow).toBe(true);
    expect(image.snapshot.state).toBe('closed');
  });

  it('a success on one scope does not reset the other scope’s counter', async () => {
    const { executor } = createSettingsFake();
    await recordAiCircuitBreakerFailure(executor, NOW, AI_IMAGE_CIRCUIT_BREAKER_SCOPE);
    await recordAiCircuitBreakerFailure(executor, NOW, AI_IMAGE_CIRCUIT_BREAKER_SCOPE);
    await recordAiCircuitBreakerSuccess(executor, NOW, 'workers-ai');
    const image = await checkAiCircuitBreaker(executor, NOW, AI_IMAGE_CIRCUIT_BREAKER_SCOPE);
    expect(image.snapshot.consecutiveFailures).toBe(2);
    const text = await checkAiCircuitBreaker(executor, NOW, 'workers-ai');
    expect(text.snapshot.consecutiveFailures).toBe(0);
  });

  it('the two scopes resolve to distinct settings keys', () => {
    expect(aiCircuitBreakerSettingsKey(AI_IMAGE_CIRCUIT_BREAKER_SCOPE)).toBe(
      'ai.circuit_breaker.image',
    );
    expect(aiCircuitBreakerSettingsKey('workers-ai')).toBe('ai.circuit_breaker.workers-ai');
    expect(aiCircuitBreakerSettingsKey(AI_IMAGE_CIRCUIT_BREAKER_SCOPE)).not.toBe(
      aiCircuitBreakerSettingsKey('workers-ai'),
    );
  });
});
