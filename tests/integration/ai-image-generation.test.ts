import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { AI_IMAGE_BUDGET_KEY, readAiBudget } from '../../src/adapters/db/ai-budget-store';
import { createImageGenerationService } from '../../src/application/ai/image-generation-service';
import type {
  ImageGenerationCallOutcome,
  ImageGeneratorPort,
} from '../../src/domain/ai/image-types';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * AI IMAGE generation service (ADR-0072) over REAL disposable workerd
 * D1: the flag gate, the separate image budget (attempts + neurons,
 * never the text budget), the separate image breaker, charge-on-success
 * + refund, and the ai_runs bookkeeping. The provider is a scripted
 * fake port — no binding, no network.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 2026-11-27 10:00 — a fresh Tehran-day budget bucket. */
const NOW = Date.UTC(2026, 10, 27, 6, 30, 0);

let clock: MutableClock;

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 10, 20, 30]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makePort(
  outcomes: readonly ImageGenerationCallOutcome[],
): ImageGeneratorPort & { calls: number } {
  let index = 0;
  let calls = 0;
  return {
    provider: 'workers-ai',
    get calls() {
      return calls;
    },
    async generate() {
      calls += 1;
      const outcome = outcomes[Math.min(index, outcomes.length - 1)]!;
      index += 1;
      return outcome;
    },
  };
}

function okPort(): ImageGeneratorPort & { calls: number } {
  return makePort([{ kind: 'ok', bytes: IMAGE_BYTES, contentType: 'image/jpeg', seedUsed: null }]);
}

function buildService(port: ImageGeneratorPort | undefined, imageEnabled: boolean) {
  return createImageGenerationService({
    executor,
    clock,
    logger: silentLogger(),
    port,
    config: { imageEnabled, bindingPresent: port !== undefined },
  });
}

async function imageBudget(): Promise<{ requests: number; neurons: number }> {
  const row = await executor.first<{ requests: number; input_tokens: number }>({
    sql: `SELECT requests, input_tokens FROM budgets WHERE scope = 'ai' AND budget_key = ? AND bucket_date = '2026-11-27'`,
    params: [AI_IMAGE_BUDGET_KEY],
  });
  return { requests: row?.requests ?? 0, neurons: row?.input_tokens ?? 0 };
}

async function textBudget(): Promise<number> {
  return readAiBudget(executor, { provider: 'workers-ai', nowMs: NOW });
}

async function aiRuns(): Promise<
  readonly { task: string; model: string; status: string; error_code: string | null }[]
> {
  const result = await executor.query<{
    task: string;
    model: string;
    status: string;
    error_code: string | null;
  }>({
    sql: `SELECT task, model, status, error_code FROM ai_runs ORDER BY created_at, id`,
  });
  return result.rows;
}

async function imageBreakerFailures(): Promise<number> {
  const row = await executor.first<{ value_json: string }>({
    sql: `SELECT value_json FROM settings WHERE key = 'ai.circuit_breaker.image'`,
  });
  if (row === null) return 0;
  const parsed = JSON.parse(row.value_json) as { consecutive_failures: number };
  return parsed.consecutive_failures;
}

beforeEach(async () => {
  await applyMigrations(db);
  await executor.run({ sql: `DELETE FROM budgets WHERE scope = 'ai'` });
  await executor.run({ sql: `DELETE FROM ai_runs` });
  await executor.run({ sql: `DELETE FROM settings WHERE key LIKE 'ai.%'` });
  clock = fixedClock(NOW);
});

describe('ai-image-generation service (ADR-0072)', () => {
  it('flag off: ai_disabled with ZERO provider calls, ZERO budget writes, ZERO ai_runs', async () => {
    const port = okPort();
    const outcome = await buildService(port, false).generateImage({
      headline: 'تریلر GTA VI منتشر شد',
      categoryEmoji: '🎮',
    });
    expect(outcome).toEqual({ kind: 'deferred', reason: 'ai_disabled', attempts: [] });
    expect(port.calls).toBe(0);
    expect(await imageBudget()).toEqual({ requests: 0, neurons: 0 });
    expect(await aiRuns()).toEqual([]);
  });

  it('flag on without a port: no_free_path with ZERO writes', async () => {
    const outcome = await buildService(undefined, true).generateImage({
      headline: 'تریلر GTA VI منتشر شد',
    });
    expect(outcome).toEqual({ kind: 'deferred', reason: 'no_free_path', attempts: [] });
    expect(await imageBudget()).toEqual({ requests: 0, neurons: 0 });
    expect(await aiRuns()).toEqual([]);
  });

  it('empty headline: input_invalid with ZERO provider calls and ZERO writes', async () => {
    const port = okPort();
    const outcome = await buildService(port, true).generateImage({ headline: '   ' });
    expect(outcome).toEqual({ kind: 'deferred', reason: 'input_invalid', attempts: [] });
    expect(port.calls).toBe(0);
    expect(await imageBudget()).toEqual({ requests: 0, neurons: 0 });
  });

  it('success: generated image, 58-neuron charge kept, ai_runs row, text budget untouched', async () => {
    const port = okPort();
    const outcome = await buildService(port, true).generateImage({
      headline: 'تریلر GTA VI منتشر شد',
      categoryEmoji: '🎮',
    });
    expect(outcome.kind).toBe('generated');
    if (outcome.kind !== 'generated') return;
    expect(outcome.image.bytes).toEqual(IMAGE_BYTES);
    expect(outcome.image.contentType).toBe('image/jpeg');
    expect(outcome.image.modelId).toBe('@cf/black-forest-labs/flux-1-schnell');
    expect(outcome.image.neurons).toBe(58);
    expect(outcome.image.seed).toBeNull();
    expect(outcome.image.sha256Hex).toBe(await sha256Hex(IMAGE_BYTES));
    expect(outcome.image.prompt).toContain('GTA VI');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]?.outcome).toBe('succeeded');
    expect(port.calls).toBe(1);
    // The charge stays (provider answered): 1 attempt, 58 neurons.
    expect(await imageBudget()).toEqual({ requests: 1, neurons: 58 });
    // The TEXT budget is a different key — untouched.
    expect(await textBudget()).toBe(0);
    const runs = await aiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      task: 'image_generation',
      model: '@cf/black-forest-labs/flux-1-schnell',
      status: 'succeeded',
      error_code: null,
    });
    expect(await imageBreakerFailures()).toBe(0);
  });

  it('safety refusal: deferred refused, charge KEPT, breaker untouched', async () => {
    const port = makePort([{ kind: 'refused' }]);
    const outcome = await buildService(port, true).generateImage({
      headline: 'خبر مهم',
    });
    expect(outcome).toEqual({
      kind: 'deferred',
      reason: 'refused',
      attempts: [
        {
          modelId: '@cf/black-forest-labs/flux-1-schnell',
          outcome: 'refused',
          durationMs: 0,
          neurons: 58,
        },
      ],
    });
    expect(port.calls).toBe(1);
    // The provider answered — the charge stays.
    expect(await imageBudget()).toEqual({ requests: 1, neurons: 58 });
    const runs = await aiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error_code).toBe('provider_safety_refusal');
    expect(await imageBreakerFailures()).toBe(0);
  });

  it('quota denial: deferred quota_denied, REFUNDED, breaker untouched', async () => {
    const port = makePort([{ kind: 'quota_denied' }]);
    const outcome = await buildService(port, true).generateImage({
      headline: 'خبر مهم',
    });
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind !== 'deferred') return;
    expect(outcome.reason).toBe('quota_denied');
    expect(port.calls).toBe(1);
    // No work was done — the attempt + neurons are refunded.
    expect(await imageBudget()).toEqual({ requests: 0, neurons: 0 });
    const runs = await aiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.error_code).toBe('quota_denied');
    // Quota denials never move the breaker counter.
    expect(await imageBreakerFailures()).toBe(0);
  });

  it('deadline: deferred deadline_exceeded, REFUNDED, breaker failure recorded', async () => {
    const port = makePort([{ kind: 'deadline_exceeded' }]);
    const outcome = await buildService(port, true).generateImage({
      headline: 'خبر مهم',
    });
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind !== 'deferred') return;
    expect(outcome.reason).toBe('deadline_exceeded');
    expect(await imageBudget()).toEqual({ requests: 0, neurons: 0 });
    expect(await imageBreakerFailures()).toBe(1);
  });

  it('invalid prompt: deferred invalid_prompt, REFUNDED, ai_runs status invalid', async () => {
    const port = makePort([{ kind: 'invalid_prompt' }]);
    const outcome = await buildService(port, true).generateImage({
      headline: 'خبر مهم',
    });
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind !== 'deferred') return;
    expect(outcome.reason).toBe('invalid_prompt');
    expect(await imageBudget()).toEqual({ requests: 0, neurons: 0 });
    const runs = await aiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('invalid');
  });

  it('five transient failures open the image breaker; the next call is circuit_open with ZERO provider calls', async () => {
    const port = makePort([{ kind: 'transient' }]);
    const service = buildService(port, true);
    for (let i = 0; i < 5; i += 1) {
      const outcome = await service.generateImage({ headline: 'خبر مهم' });
      expect(outcome.kind).toBe('deferred');
    }
    expect(port.calls).toBe(5);
    expect(await imageBreakerFailures()).toBe(5);
    const open = await service.generateImage({ headline: 'خبر مهم' });
    expect(open).toEqual({ kind: 'deferred', reason: 'circuit_open', attempts: [] });
    expect(port.calls).toBe(5);
    // Every failed attempt was refunded: the budget holds nothing.
    expect(await imageBudget()).toEqual({ requests: 0, neurons: 0 });
  });

  it('the attempt cap binds at 10: the 11th generation is budget_denied with ZERO provider calls', async () => {
    const port = okPort();
    const service = buildService(port, true);
    for (let i = 0; i < 10; i += 1) {
      const outcome = await service.generateImage({ headline: `خبر ${i}` });
      expect(outcome.kind).toBe('generated');
    }
    expect(port.calls).toBe(10);
    expect(await imageBudget()).toEqual({ requests: 10, neurons: 580 });
    const denied = await service.generateImage({ headline: 'خبر یازدهم' });
    expect(denied).toEqual({ kind: 'deferred', reason: 'budget_denied', attempts: [] });
    expect(port.calls).toBe(10);
    // The text budget never moved while the image budget filled.
    expect(await textBudget()).toBe(0);
  });
});
