/**
 * Workers AI IMAGE adapter (ADR-0072): the image provider port over the
 * native `env.AI.run(modelId, inputs)` binding. No Cloudflare API token,
 * account id, REST inference proxy, AI Gateway, or extra resource — the
 * binding IS the account access for this path.
 *
 * Verified call shapes (installed `@cloudflare/workers-types` +
 * official model pages, 2026-11-27):
 * - `@cf/black-forest-labs/flux-1-schnell`: inputs `{ prompt, steps? }`
 *   (NO seed, NO width/height — the typed input has neither; the docs
 *   examples passing `seed` are stale), output `{ image?: string }`
 *   (base64 JPEG). The adapter passes `{ prompt, steps: 4 }` only.
 * - SD-family models return a `ReadableStream` of PNG bytes instead;
 *   the interpreter accepts that shape too, so a future allowlisted
 *   model with a stream output needs no adapter change.
 *
 * Deadline honesty (the same documented limitation as the text
 * adapter): the Workers AI binding offers NO guaranteed native
 * cancellation, so this adapter races the call against the wall
 * deadline and returns `deadline_exceeded` on timeout while the
 * in-flight call MAY still be computing server-side. The service
 * accounts for that: a timed-out attempt is refunded best-effort
 * (charge-on-success) and can never start new work after the deadline.
 *
 * Error mapping is deliberately conservative and code-only: thrown
 * binding errors are classified by bounded message-name patterns into
 * the stable kinds. Raw error text, provider payloads, headers and
 * URLs NEVER cross this boundary (they are not logged and not
 * returned — only the sanitized kind is).
 */
import { AI_IMAGE_FLUX_CONTENT_TYPE, AI_IMAGE_MAX_BYTES } from '../../../domain/ai/image-policy';
import type {
  ImageGenerationCallOutcome,
  ImageGeneratorPort,
} from '../../../domain/ai/image-types';
import { classifyBindingError } from '../workers-ai-adapter';

/** Conservative bounded classification patterns (never emitted verbatim). */
const REFUSED_PATTERN =
  /(content.*(policy|safety|blocked)|safety.*(block|refus)|blocked.*content|inappropriate content)/;
const INVALID_PROMPT_PATTERN =
  /(invalid prompt|prompt.*(too long|exceeds|empty)|validation.*(failed|error)|invalid.*(input|parameter|steps))/;

/** Flux steps pinned by the policy (cost predictability). */
const FLUX_STEPS = 4;

export class WorkersAiImageAdapter implements ImageGeneratorPort {
  readonly provider = 'workers-ai' as const;

  constructor(private readonly binding: Ai) {}

  async generate(input: {
    readonly modelId: string;
    readonly prompt: string;
    readonly width: number;
    readonly height: number;
    readonly deadlineAtMs: number;
  }): Promise<ImageGenerationCallOutcome> {
    const remainingMs = input.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return { kind: 'deadline_exceeded' };
    }
    if (
      typeof input.prompt !== 'string' ||
      input.prompt.length === 0 ||
      input.prompt.length > 2048
    ) {
      return { kind: 'invalid_prompt' };
    }

    // The call shape is per-model: flux-1-schnell takes { prompt, steps }
    // only (typed input — no seed, no dimensions). Future allowlisted
    // models with a typed dimension/seed input extend this switch; an
    // unknown model id is never called with a guessed shape.
    const inputs: Record<string, unknown> =
      input.modelId === '@cf/black-forest-labs/flux-1-schnell'
        ? { prompt: input.prompt, steps: FLUX_STEPS }
        : { prompt: input.prompt };

    let runPromise: Promise<unknown>;
    try {
      runPromise = this.binding.run(input.modelId, inputs);
    } catch (error) {
      return classifyImageBindingError(error);
    }
    // A late rejection after the deadline race is resolved must never
    // become an unhandled rejection; the outcome is already decided.
    void runPromise.catch(() => undefined);

    let timerId: ReturnType<typeof setTimeout> | undefined;
    const deadlineRace = new Promise<'deadline'>((resolve) => {
      timerId = setTimeout(() => resolve('deadline'), remainingMs);
    });

    try {
      const result = (await Promise.race([
        runPromise.then((value) => ({ kind: 'result' as const, value })),
        deadlineRace,
      ])) as { kind: 'result'; value: unknown } | 'deadline';
      if (result === 'deadline') {
        return { kind: 'deadline_exceeded' };
      }
      return await interpretImageRunResult(result.value);
    } catch (error) {
      return classifyImageBindingError(error);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }
}

/** Conservative classification — emits ONLY the stable kind. */
export function classifyImageBindingError(error: unknown): ImageGenerationCallOutcome {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const haystack = `${name} ${message}`.toLowerCase();
  if (REFUSED_PATTERN.test(haystack)) {
    return { kind: 'refused' };
  }
  if (INVALID_PROMPT_PATTERN.test(haystack)) {
    return { kind: 'invalid_prompt' };
  }
  const textOutcome = classifyBindingError(error);
  switch (textOutcome.kind) {
    case 'quota_denied':
      return { kind: 'quota_denied' };
    case 'auth_failed':
      return { kind: 'auth_failed' };
    case 'model_unavailable':
      return { kind: 'model_unavailable' };
    case 'deadline_exceeded':
      return { kind: 'deadline_exceeded' };
    default:
      return { kind: 'transient' };
  }
}

/**
 * Defensive extraction of the binding's image output. Known shapes:
 * 1. `{ image: string }` — flux base64 JPEG (the v1 path).
 * 2. A `ReadableStream` of bytes — the SD-family shape (PNG).
 * 3. A raw `Uint8Array` / `ArrayBuffer` of bytes.
 * Anything else is uninterpretable at this boundary. Bytes must be
 * non-empty and within the Telegram 10 MB upload bound.
 */
export async function interpretImageRunResult(
  result: unknown,
): Promise<ImageGenerationCallOutcome> {
  if (typeof result === 'string') {
    return decodeBase64Image(result);
  }
  if (result instanceof Uint8Array) {
    return boundedBytes(result, 'image/png');
  }
  if (result instanceof ArrayBuffer) {
    return boundedBytes(new Uint8Array(result), 'image/png');
  }
  if (result !== null && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const image = record['image'];
    if (typeof image === 'string') {
      return decodeBase64Image(image);
    }
    if (
      image !== undefined &&
      typeof image === 'object' &&
      image !== null &&
      typeof (image as { getReader?: unknown })['getReader'] === 'function'
    ) {
      return readBoundedStream(image as ReadableStream<Uint8Array>);
    }
    if (result instanceof ReadableStream) {
      return readBoundedStream(result as ReadableStream<Uint8Array>);
    }
  }
  return { kind: 'transient' };
}

function decodeBase64Image(value: string): ImageGenerationCallOutcome {
  const cleaned = value.replace(/\s/g, '');
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return { kind: 'transient' };
  }
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    return { kind: 'transient' };
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return boundedBytes(bytes, AI_IMAGE_FLUX_CONTENT_TYPE);
}

function boundedBytes(bytes: Uint8Array, contentType: string): ImageGenerationCallOutcome {
  if (bytes.byteLength === 0 || bytes.byteLength > AI_IMAGE_MAX_BYTES) {
    return { kind: 'transient' };
  }
  return { kind: 'ok', bytes, contentType, seedUsed: null };
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ImageGenerationCallOutcome> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        return { kind: 'transient' };
      }
      total += value.byteLength;
      if (total > AI_IMAGE_MAX_BYTES) {
        return { kind: 'transient' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'transient' };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A released/cancelled reader is already done — nothing to do.
    }
  }
  if (total === 0) {
    return { kind: 'transient' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', bytes, contentType: 'image/png', seedUsed: null };
}

/** Factory for the production port (binding comes from the runtime env). */
export function createWorkersAiImageAdapter(binding: Ai): ImageGeneratorPort {
  return new WorkersAiImageAdapter(binding);
}
