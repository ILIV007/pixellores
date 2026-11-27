import { describe, expect, it } from 'vitest';
import {
  WorkersAiImageAdapter,
  classifyImageBindingError,
  interpretImageRunResult,
} from '../../src/adapters/ai/image/workers-ai-image-adapter';
import { AI_IMAGE_MAX_BYTES } from '../../src/domain/ai/image-policy';

/**
 * Workers AI IMAGE adapter (ADR-0072) — offline, over a fake `Ai`
 * binding. The flux call shape is pinned: { prompt, steps: 4 } only —
 * no seed, no dimensions (the typed input has neither).
 */

const FLUX = '@cf/black-forest-labs/flux-1-schnell';
const PROMPT =
  'Cinematic wide shot, dramatic breaking-news scene, no text in image, no logo, no watermark';

function base64Of(bytes: Uint8Array): string {
  // Chunked binary-string build + btoa (no Node `Buffer` — the Workers
  // types do not declare it). A single char-by-char loop over 10 MB
  // blew the 5 s test timeout (quadratic string growth); 32 KiB chunks
  // keep it linear.
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function makeBinding(run: (modelId: string, inputs: unknown) => Promise<unknown>) {
  const calls: { modelId: string; inputs: unknown }[] = [];
  // A PLAIN (non-async) passthrough, like the text adapter's fakeBinding:
  // the binding's `run` IS the scripted promise — no async wrapper
  // adopting it (an adoption layer surfaced as an unhandled rejection
  // under vitest even though the adapter handles the outcome).
  const binding = {
    run: (modelId: string, inputs: unknown) => {
      calls.push({ modelId, inputs });
      return run(modelId, inputs);
    },
  };
  return { binding: binding as unknown as Ai, calls };
}

describe('WorkersAiImageAdapter.generate — flux call shape', () => {
  it('calls flux with { prompt, steps: 4 } only and decodes the base64 JPEG', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const { binding, calls } = makeBinding(async () => ({ image: base64Of(bytes) }));
    const adapter = new WorkersAiImageAdapter(binding);
    const outcome = await adapter.generate({
      modelId: FLUX,
      prompt: PROMPT,
      width: 1344,
      height: 768,
      deadlineAtMs: Date.now() + 60_000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe(FLUX);
    expect(calls[0]?.inputs).toEqual({ prompt: PROMPT, steps: 4 });
    // No seed, no dimensions — the typed flux input has neither.
    expect(calls[0]?.inputs).not.toHaveProperty('seed');
    expect(calls[0]?.inputs).not.toHaveProperty('width');
    expect(calls[0]?.inputs).not.toHaveProperty('height');
    expect(outcome).toEqual({ kind: 'ok', bytes, contentType: 'image/jpeg', seedUsed: null });
  });

  it('returns deadline_exceeded without calling the binding when the deadline already passed', async () => {
    const { binding, calls } = makeBinding(async () => ({ image: 'AAAA' }));
    const adapter = new WorkersAiImageAdapter(binding);
    const outcome = await adapter.generate({
      modelId: FLUX,
      prompt: PROMPT,
      width: 1024,
      height: 1024,
      deadlineAtMs: Date.now() - 1,
    });
    expect(outcome).toEqual({ kind: 'deadline_exceeded' });
    expect(calls).toHaveLength(0);
  });

  it('returns deadline_exceeded when the binding never resolves in time', async () => {
    const { binding } = makeBinding(() => new Promise(() => undefined));
    const adapter = new WorkersAiImageAdapter(binding);
    const outcome = await adapter.generate({
      modelId: FLUX,
      prompt: PROMPT,
      width: 1024,
      height: 1024,
      deadlineAtMs: Date.now() + 25,
    });
    expect(outcome).toEqual({ kind: 'deadline_exceeded' });
  });

  it('classifies a thrown binding error through the shared classifier', async () => {
    const { binding } = makeBinding(async () => {
      throw new Error('quota exceeded: daily neuron budget');
    });
    const adapter = new WorkersAiImageAdapter(binding);
    const outcome = await adapter.generate({
      modelId: FLUX,
      prompt: PROMPT,
      width: 1024,
      height: 1024,
      deadlineAtMs: Date.now() + 60_000,
    });
    expect(outcome).toEqual({ kind: 'quota_denied' });
  });

  it('refuses an empty or over-long prompt without calling the binding', async () => {
    const { binding, calls } = makeBinding(async () => ({ image: 'AAAA' }));
    const adapter = new WorkersAiImageAdapter(binding);
    expect(
      await adapter.generate({
        modelId: FLUX,
        prompt: '',
        width: 1024,
        height: 1024,
        deadlineAtMs: Date.now() + 60_000,
      }),
    ).toEqual({ kind: 'invalid_prompt' });
    expect(
      await adapter.generate({
        modelId: FLUX,
        prompt: 'x'.repeat(2049),
        width: 1024,
        height: 1024,
        deadlineAtMs: Date.now() + 60_000,
      }),
    ).toEqual({ kind: 'invalid_prompt' });
    expect(calls).toHaveLength(0);
  });
});

describe('interpretImageRunResult — output shapes', () => {
  it('accepts a ReadableStream of PNG bytes (the SD-family shape)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const outcome = await interpretImageRunResult(stream);
    expect(outcome).toEqual({
      kind: 'ok',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]),
      contentType: 'image/png',
      seedUsed: null,
    });
  });

  it('accepts raw bytes directly', async () => {
    expect(await interpretImageRunResult(new Uint8Array([7, 8, 9]))).toEqual({
      kind: 'ok',
      bytes: new Uint8Array([7, 8, 9]),
      contentType: 'image/png',
      seedUsed: null,
    });
  });

  it('treats empty, malformed, and oversize outputs as transient (never a throw)', async () => {
    expect(await interpretImageRunResult({ image: '' })).toEqual({ kind: 'transient' });
    expect(await interpretImageRunResult({ image: 'not-base64!!!' })).toEqual({
      kind: 'transient',
    });
    expect(await interpretImageRunResult({ nope: true })).toEqual({ kind: 'transient' });
    expect(await interpretImageRunResult(null)).toEqual({ kind: 'transient' });
    expect(await interpretImageRunResult(new Uint8Array(0))).toEqual({ kind: 'transient' });
    const oversize = new Uint8Array(AI_IMAGE_MAX_BYTES + 1);
    expect(await interpretImageRunResult(oversize)).toEqual({ kind: 'transient' });
    expect(await interpretImageRunResult({ image: base64Of(oversize) })).toEqual({
      kind: 'transient',
    });
  });
});

describe('classifyImageBindingError — stable kinds only', () => {
  it('maps safety refusals to refused (terminal — never hop models to bypass)', () => {
    expect(classifyImageBindingError(new Error('content blocked by safety policy'))).toEqual({
      kind: 'refused',
    });
  });

  it('maps invalid prompts to invalid_prompt', () => {
    expect(classifyImageBindingError(new Error('prompt too long'))).toEqual({
      kind: 'invalid_prompt',
    });
  });

  it('maps a retired-model 410 to model_unavailable (the plan’s dead backups)', () => {
    expect(
      classifyImageBindingError(new Error('410 Gone: model retired, use flux-2-klein-9b')),
    ).toEqual({ kind: 'model_unavailable' });
  });

  it('maps quota and auth failures to their kinds, everything else to transient', () => {
    expect(classifyImageBindingError(new Error('429 quota exceeded'))).toEqual({
      kind: 'quota_denied',
    });
    expect(classifyImageBindingError(new Error('401 unauthorized'))).toEqual({
      kind: 'auth_failed',
    });
    expect(classifyImageBindingError(new Error('weird network flap'))).toEqual({
      kind: 'transient',
    });
    expect(classifyImageBindingError('not an error')).toEqual({ kind: 'transient' });
  });
});
