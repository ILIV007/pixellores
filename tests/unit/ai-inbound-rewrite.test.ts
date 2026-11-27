import { describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryMeta, DbRows } from '../../src/adapters/db/db-executor';
import { AI_INBOUND_REWRITE_MAX_OUTPUT_TOKENS } from '../../src/domain/ai/policy';
import { AI_INBOUND_REWRITE_PROMPT_VERSION } from '../../src/domain/ai/inbound-rewrite-prompt';
import { createAiRewriteService } from '../../src/application/ai/rewrite-service';
import type { AiCallOutcome, AiChatMessage, AiProviderPort } from '../../src/domain/ai/types';
import { createLogger } from '../../src/observability/logger';

/**
 * Inbound Soul rewrite (ADR-0073 §1–§2): the same Gemini-only service as
 * the news rewrite stage, with its own prompt, output schema, and
 * preservation guard — and deliberately NO dependency on the
 * AI_GEMINI_REWRITE_ENABLED stage flag, so the cron bridge never
 * requires pipeline rewrites because of this. Fully offline; injected
 * fakes, same pattern as ai-rewrite-stage.test.ts.
 */

const silentLogger = createLogger({ level: 'error', sink: () => undefined });
const NOW = 1_700_000_000_000;

function createFakeClock(start = NOW): { now(): number } & { setNow(value: number): void } {
  let current = start;
  return {
    now: () => current,
    setNow(value: number) {
      current = value;
    },
  };
}

function createFakeExecutor(): DbExecutor {
  return {
    async query<T>(): Promise<DbRows<T>> {
      return { rows: [] as T[], meta: { durationMs: 0, changes: 0 } };
    },
    async first<T>(): Promise<T | null> {
      return null;
    },
    async run(): Promise<DbQueryMeta> {
      return { durationMs: 0, changes: 1 };
    },
    async batch(statements: readonly { sql: string }[]): Promise<readonly DbQueryMeta[]> {
      return statements.map(() => ({ durationMs: 0, changes: 1 }));
    },
  };
}

type FakeGeminiPort = {
  readonly calls: {
    modelId: string;
    maxOutputTokens: number;
    messages: readonly AiChatMessage[];
  }[];
  setOutcomes(next: readonly AiCallOutcome[]): void;
} & AiProviderPort;

function createFakeGeminiPort(outcomes: readonly AiCallOutcome[] = []): FakeGeminiPort {
  const calls: FakeGeminiPort['calls'] = [];
  const queue = [...outcomes];
  return {
    provider: 'gemini',
    calls,
    setOutcomes(next: readonly AiCallOutcome[]) {
      queue.length = 0;
      queue.push(...next);
    },
    async complete(input) {
      calls.push({
        modelId: input.modelId,
        maxOutputTokens: input.maxOutputTokens,
        messages: input.messages,
      });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('fake port exhausted its scripted outcomes');
      }
      return next;
    },
  } as FakeGeminiPort;
}

const VALID_INBOUND_JSON = JSON.stringify({
  text: '**تریلر جدید GTA VI**\nفروش به 3.79 میلیارد دلار رسید.\n\n> Best trailer of the year\n> — IGN',
});

const INBOUND_REQUEST = {
  text: 'تریلر جدید GTA VI منتشر شد؛ فروش به ۳٫۷۹ میلیارد دلار رسید. «Best trailer of the year» — IGN',
  category: 'news' as const,
  isCaption: false,
};

function baseInboundRewriteService(
  overrides: {
    port?: FakeGeminiPort;
    aiEnabled?: boolean;
    geminiEnabled?: boolean;
    rewriteEnabled?: boolean;
    geminiApiKeyPresent?: boolean;
  } = {},
): { service: ReturnType<typeof createAiRewriteService>; port: FakeGeminiPort } {
  const port =
    overrides.port ?? createFakeGeminiPort([{ kind: 'ok', rawText: VALID_INBOUND_JSON }]);
  const service = createAiRewriteService({
    config: {
      aiEnabled: overrides.aiEnabled ?? true,
      geminiEnabled: overrides.geminiEnabled ?? true,
      rewriteEnabled: overrides.rewriteEnabled ?? false,
      geminiApiKeyPresent: overrides.geminiApiKeyPresent ?? true,
      workersAiBindingPresent: false,
    },
    executor: createFakeExecutor(),
    ports: { gemini: port },
    clock: createFakeClock(NOW),
    logger: silentLogger,
  });
  return { service, port };
}

describe('rewrite service — inbound Soul rewrite (ADR-0073 §1–§2)', () => {
  it('rewrites with Gemini only, prompt v1, the inbound token cap, markers intact', async () => {
    const { service, port } = baseInboundRewriteService();
    const outcome = await service.rewriteInboundPost(INBOUND_REQUEST);
    expect(outcome.kind).toBe('rewritten');
    if (outcome.kind === 'rewritten') {
      expect(outcome.text).toContain('**تریلر جدید GTA VI**');
      expect(outcome.text).toContain('3.79 میلیارد دلار');
      expect(outcome.text).toContain('> Best trailer of the year');
      expect(outcome.modelId).toBe('gemini-3.5-flash-lite');
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0]?.promptVersion).toBe('pixel-inbound-soul-rewrite-v1');
    }
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.maxOutputTokens).toBe(AI_INBOUND_REWRITE_MAX_OUTPUT_TOKENS);
    expect(AI_INBOUND_REWRITE_MAX_OUTPUT_TOKENS).toBe(2048);
    expect(AI_INBOUND_REWRITE_PROMPT_VERSION).toBe('pixel-inbound-soul-rewrite-v1');
    expect(
      port.calls[0]?.messages.some((message) =>
        message.content.includes('pixel-inbound-soul-rewrite-v1'),
      ),
    ).toBe(true);
  });

  it('rewrites even when the pipeline-draft stage flag is off (ADR-0073 §2)', async () => {
    const { service, port } = baseInboundRewriteService({ rewriteEnabled: false });
    const outcome = await service.rewriteInboundPost(INBOUND_REQUEST);
    expect(outcome.kind).toBe('rewritten');
    expect(port.calls).toHaveLength(1);
  });

  it('gates defer with zero calls: ai off → ai_disabled, Gemini off → no_free_path, no key → key_missing', async () => {
    const cases = [
      { overrides: { aiEnabled: false }, reason: 'ai_disabled' },
      { overrides: { geminiEnabled: false }, reason: 'no_free_path' },
      { overrides: { geminiApiKeyPresent: false }, reason: 'key_missing' },
    ] as const;
    for (const { overrides, reason } of cases) {
      const { service, port } = baseInboundRewriteService(overrides);
      const outcome = await service.rewriteInboundPost(INBOUND_REQUEST);
      expect(outcome.kind).toBe('deferred');
      if (outcome.kind === 'deferred') {
        expect(outcome.reason).toBe(reason);
        expect(outcome.attempts).toHaveLength(0);
      }
      expect(port.calls).toHaveLength(0);
    }
  });

  it('malformed JSON on every model → provider_unavailable with invalid_output attempts', async () => {
    const port = createFakeGeminiPort([
      { kind: 'ok', rawText: 'not json at all' },
      { kind: 'ok', rawText: '{"text": 42}' },
      { kind: 'ok', rawText: '{"other": "field"}' },
    ]);
    const { service } = baseInboundRewriteService({ port });
    const outcome = await service.rewriteInboundPost(INBOUND_REQUEST);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('provider_unavailable');
      expect(outcome.attempts).toHaveLength(3);
      expect(outcome.attempts.every((attempt) => attempt.outcome === 'invalid_output')).toBe(true);
    }
    expect(port.calls).toHaveLength(3);
  });

  it('a rewritten number not in the raw text is refused on every model', async () => {
    const invented = JSON.stringify({
      text: '**تریلر جدید GTA VI**\nفروش به 3.80 میلیارد دلار رسید.',
    });
    const port = createFakeGeminiPort([
      { kind: 'ok', rawText: invented },
      { kind: 'ok', rawText: invented },
      { kind: 'ok', rawText: invented },
    ]);
    const { service } = baseInboundRewriteService({ port });
    const outcome = await service.rewriteInboundPost(INBOUND_REQUEST);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('provider_unavailable');
      expect(outcome.attempts).toHaveLength(3);
      expect(outcome.attempts.every((attempt) => attempt.outcome === 'invalid_output')).toBe(true);
    }
  });

  it('a safety refusal is terminal and never retried on another model', async () => {
    const { service, port } = baseInboundRewriteService({
      port: createFakeGeminiPort([{ kind: 'refused' }]),
    });
    const outcome = await service.rewriteInboundPost(INBOUND_REQUEST);
    expect(outcome.kind).toBe('refusal');
    if (outcome.kind === 'refusal') {
      expect(outcome.reason).toBe('provider_safety_refusal');
    }
    expect(port.calls).toHaveLength(1);
  });
});
