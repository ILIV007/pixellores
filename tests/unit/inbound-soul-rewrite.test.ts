import { describe, expect, it } from 'vitest';
import { createSoulInboundRewriter } from '../../src/application/inbound/soul-rewriter';
import type {
  AiInboundRewriteOutcome,
  AiRewriteService,
} from '../../src/application/ai/rewrite-service';
import type { AiAttemptRecord } from '../../src/domain/ai/types';

/**
 * Soul adapter (ADR-0073 §1): a thin mapping over the rewrite service's
 * `rewriteInboundPost` — no gates of its own. A deferred or refused
 * outcome falls back to the cleaned text in the pipeline, never
 * fabricating.
 */
describe('inbound Soul rewriter adapter', () => {
  const ATTEMPT: AiAttemptRecord = {
    provider: 'gemini',
    modelId: 'gemini-3.5-flash-lite',
    promptVersion: 'pixel-inbound-soul-rewrite-v1',
    outcome: 'succeeded',
    durationMs: 10,
  };

  function fakeService(outcome: AiInboundRewriteOutcome): AiRewriteService {
    return {
      rewriteNewsDraft: async () => {
        throw new Error('rewriteNewsDraft is unused in the inbound adapter');
      },
      rewriteInboundPost: async () => outcome,
    };
  }

  const INPUT = { text: 'متن خام', category: 'news' as const, isCaption: false };

  it('maps a rewritten outcome to ok with the text', async () => {
    const service = fakeService({
      kind: 'rewritten',
      text: '**تیتر**\nمتن بازنویسی‌شده.',
      modelId: 'gemini-3.5-flash-lite',
      usage: [
        {
          provider: 'gemini',
          modelId: 'gemini-3.5-flash-lite',
          promptVersion: 'pixel-inbound-soul-rewrite-v1',
        },
      ],
      attempts: [ATTEMPT],
    });
    const outcome = await createSoulInboundRewriter({ rewriteService: service }).rewrite(INPUT);
    expect(outcome).toEqual({
      kind: 'ok',
      text: '**تیتر**\nمتن بازنویسی‌شده.',
      attempts: 1,
    });
  });

  it('passes a deferred reason through unchanged', async () => {
    const service = fakeService({
      kind: 'deferred',
      reason: 'ai_disabled',
      attempts: [],
    });
    const outcome = await createSoulInboundRewriter({ rewriteService: service }).rewrite(INPUT);
    expect(outcome).toEqual({ kind: 'deferred', reason: 'ai_disabled', attempts: 0 });
  });

  it('passes provider_unavailable through unchanged', async () => {
    const service = fakeService({
      kind: 'deferred',
      reason: 'provider_unavailable',
      attempts: [ATTEMPT],
    });
    const outcome = await createSoulInboundRewriter({ rewriteService: service }).rewrite(INPUT);
    expect(outcome).toEqual({ kind: 'deferred', reason: 'provider_unavailable', attempts: 1 });
  });

  it('maps a safety refusal to refused', async () => {
    const service = fakeService({
      kind: 'refusal',
      provider: 'gemini',
      modelId: 'gemini-3.5-flash-lite',
      reason: 'provider_safety_refusal',
      attempts: [ATTEMPT],
    });
    const outcome = await createSoulInboundRewriter({ rewriteService: service }).rewrite(INPUT);
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'provider_safety_refusal',
      attempts: 1,
    });
  });
});
