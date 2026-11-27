/**
 * AI IMAGE generation service (ADR-0072) — the application composition
 * over the image adapter port.
 *
 * The SAME guard discipline as the text draft service, on SEPARATE
 * books (never the text budget, never the text breaker):
 * - Gate 1: the `AI_IMAGE_ENABLED` flag is the FIRST decision, before
 *   any work — off = the typed deferred `ai_disabled` with ZERO
 *   provider calls, ZERO budget writes, ZERO binding access.
 * - Gate 2: bounded request validation (fail closed, zero side effects).
 * - Gate 3: the persistent IMAGE circuit breaker (`ai.image_circuit_
 *   breaker`) — consulted BEFORE any authorization, so an open breaker
 *   means ZERO provider calls and ZERO charges. A failed breaker READ
 *   fails open (closed): the provider path still has its own
 *   budget/deadline guards, and a settings outage must not block
 *   generation by itself.
 * - EVERY potential provider attempt is charged through the image
 *   budget BEFORE the call (attempt + neuron estimate, atomic); an
 *   attempt that ends WITHOUT a provider completion is REFUNDED
 *   best-effort (charge-on-success). A provider ANSWER keeps the
 *   charge — success, safety refusal, and invalid prompt alike (the
 *   provider did the work or judged the input; a quota denial refunds
 *   because no work was done).
 * - The ladder walks the versioned image allowlist in order. A safety
 *   refusal is TERMINAL (never hop models to bypass safety); an
 *   invalid prompt stops the ladder (the prompt is the same for every
 *   model); an auth failure stops it (binding-wide); a deadline stops
 *   it (no wall left). Transient / model-unavailable / quota failures
 *   continue to the next model.
 * - EVERY attempt that actually ran is recorded in `ai_runs`
 *   (task `image_generation`) best-effort: a failed record never fails
 *   the run. A never-attempted run is never recorded.
 * - An image failure NEVER fails the caller: the outcome is a typed
 *   deferred and the post goes out as text (the scheduler owns that
 *   fallback). Prompts are NEVER logged.
 */
import type { SoulCategoryEmoji } from '../../domain/ai/types';
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  authorizeAiRequestAttempt,
  refundAiRequestAttempt,
  AI_IMAGE_BUDGET_KEY,
} from '../../adapters/db/ai-budget-store';
import { recordImageAiRun } from '../../adapters/db/ai-image-run-store';
import {
  checkAiCircuitBreaker,
  recordAiCircuitBreakerFailure,
  recordAiCircuitBreakerSuccess,
  AI_IMAGE_CIRCUIT_BREAKER_SCOPE,
} from './ai-circuit-breaker';
import {
  AI_IMAGE_DAILY_ATTEMPT_CAP,
  AI_IMAGE_DAILY_NEURON_CAP,
  AI_IMAGE_GENERATION_DEADLINE_MS,
  AI_IMAGE_MODEL_ALLOWLIST,
  AI_IMAGE_POLICY_VERSION,
  AI_IMAGE_PROMPT_VERSION,
} from '../../domain/ai/image-policy';
import { buildImagePrompt } from '../../domain/ai/image-prompt';
import type {
  GeneratedImage,
  ImageDeferredReason,
  ImageGenerationAttemptRecord,
  ImageGenerationOutcome,
  ImageGeneratorPort,
} from '../../domain/ai/image-types';
import { randomToken } from '../../domain/admin-post/fingerprint';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';

export interface ImageGenerationServiceDeps {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The image adapter port; absent = no provider path at all. */
  readonly port?: ImageGeneratorPort;
  readonly config: {
    readonly imageEnabled: boolean;
    readonly bindingPresent: boolean;
  };
}

export interface ImageGenerationService {
  generateImage(input: {
    readonly headline: string;
    readonly categoryEmoji?: SoulCategoryEmoji;
  }): Promise<ImageGenerationOutcome>;
}

/** SHA-256 hex of UTF-8 text (input identity for ai_runs). */
async function sha256HexText(text: string): Promise<string> {
  // Bare `crypto` — the Workers convention used across src/ (fingerprint,
  // publication-identity, timing-safe); `globalThis.crypto` is not typed.
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
    return fallbackHashHex(text);
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hexOfBytes(new Uint8Array(digest));
}

/** SHA-256 hex of raw bytes (the media_assets content hash). */
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
    throw new Error('webcrypto_unavailable');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return hexOfBytes(new Uint8Array(digest));
}

function hexOfBytes(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Deterministic non-cryptographic fallback (FNV-1a) when WebCrypto is
 * unavailable — an input identity only, never presented as SHA-256.
 * Used for the ai_runs input hash only; the bytes content hash has no
 * fallback (a generation without a real SHA-256 cannot be stored).
 */
function fallbackHashHex(text: string): string {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createImageGenerationService(
  deps: ImageGenerationServiceDeps,
): ImageGenerationService {
  async function generateImage(input: {
    readonly headline: string;
    readonly categoryEmoji?: SoulCategoryEmoji;
  }): Promise<ImageGenerationOutcome> {
    // ---- Gate 1: the master flag is the FIRST decision, before any work.
    if (!deps.config.imageEnabled) {
      return { kind: 'deferred', reason: 'ai_disabled', attempts: [] };
    }
    // ---- Gate 2: bounded request validation (fail closed, zero side effects).
    if (
      typeof input.headline !== 'string' ||
      input.headline.trim().length === 0 ||
      input.headline.length > 4096
    ) {
      return { kind: 'deferred', reason: 'input_invalid', attempts: [] };
    }
    if (deps.port === undefined || !deps.config.bindingPresent) {
      return { kind: 'deferred', reason: 'no_free_path', attempts: [] };
    }

    const startedAt = deps.clock.now();
    const deadlineAtMs = startedAt + AI_IMAGE_GENERATION_DEADLINE_MS;
    const built = buildImagePrompt({
      headline: input.headline,
      categoryEmoji: input.categoryEmoji,
    });
    const inputHash = await sha256HexText(built.prompt);

    // ---- Gate 3: the persistent IMAGE circuit breaker (own scope,
    // `ai.circuit_breaker.image` — separate from every text breaker).
    try {
      const breaker = await checkAiCircuitBreaker(
        deps.executor,
        startedAt,
        AI_IMAGE_CIRCUIT_BREAKER_SCOPE,
      );
      if (!breaker.allow) {
        deps.logger.info('ai.image.circuit_open', {
          consecutiveFailures: breaker.snapshot.consecutiveFailures,
          openedAtMs: breaker.snapshot.openedAtMs,
        });
        return { kind: 'deferred', reason: 'circuit_open', attempts: [] };
      }
    } catch {
      deps.logger.warn('ai.image.circuit_breaker_check_failed');
    }

    const refundAttempt = async (neurons: number): Promise<void> => {
      try {
        await refundAiRequestAttempt(deps.executor, {
          provider: 'workers-ai',
          budgetKey: AI_IMAGE_BUDGET_KEY,
          neuronCost: neurons,
          nowMs: deps.clock.now(),
        });
      } catch {
        deps.logger.warn('ai.image.refund_failed', { provider: 'workers-ai' });
      }
    };
    const noteBreakerFailure = async (): Promise<void> => {
      try {
        await recordAiCircuitBreakerFailure(
          deps.executor,
          deps.clock.now(),
          AI_IMAGE_CIRCUIT_BREAKER_SCOPE,
        );
      } catch {
        deps.logger.warn('ai.image.circuit_breaker_record_failed');
      }
    };
    const noteBreakerSuccess = async (): Promise<void> => {
      try {
        await recordAiCircuitBreakerSuccess(
          deps.executor,
          deps.clock.now(),
          AI_IMAGE_CIRCUIT_BREAKER_SCOPE,
        );
      } catch {
        deps.logger.warn('ai.image.circuit_breaker_record_failed');
      }
    };
    const recordRun = async (record: {
      readonly model: string;
      readonly status: 'succeeded' | 'failed' | 'invalid';
      readonly latencyMs: number | null;
      readonly errorCode: string | null;
    }): Promise<void> => {
      try {
        await recordImageAiRun(deps.executor, {
          id: `air:${randomToken()}`,
          model: record.model,
          promptVersion: AI_IMAGE_PROMPT_VERSION,
          inputHash,
          status: record.status,
          latencyMs: record.latencyMs,
          errorCode: record.errorCode,
          createdAt: deps.clock.now(),
          completedAt: deps.clock.now(),
        });
      } catch {
        deps.logger.warn('ai.image.run_record_failed', { model: record.model });
      }
    };

    const attempts: ImageGenerationAttemptRecord[] = [];
    let lastReason: ImageDeferredReason = 'provider_unavailable';

    for (const model of AI_IMAGE_MODEL_ALLOWLIST) {
      // ---- Authorize BEFORE the call (attempt + neuron estimate).
      let authorized: { kind: string };
      try {
        authorized = await authorizeAiRequestAttempt(deps.executor, {
          provider: 'workers-ai',
          budgetKey: AI_IMAGE_BUDGET_KEY,
          cap: AI_IMAGE_DAILY_ATTEMPT_CAP,
          neuronCost: model.neuronsPerImage,
          neuronCap: AI_IMAGE_DAILY_NEURON_CAP,
          nowMs: deps.clock.now(),
        });
      } catch {
        return { kind: 'deferred', reason: 'provider_unavailable', attempts };
      }
      if (authorized.kind !== 'authorized') {
        return { kind: 'deferred', reason: 'budget_denied', attempts };
      }

      const attemptStartedAt = deps.clock.now();
      const outcome = await deps.port.generate({
        modelId: model.modelId,
        prompt: built.prompt,
        width: built.width,
        height: built.height,
        deadlineAtMs,
      });
      const durationMs = deps.clock.now() - attemptStartedAt;

      if (outcome.kind === 'ok') {
        let sha256Hex: string;
        try {
          sha256Hex = await sha256HexBytes(outcome.bytes);
        } catch {
          // The bytes are good but unhashable — unusable without their
          // content identity. Refund, record, stop: a retry cannot fix
          // a local hashing failure.
          await refundAttempt(model.neuronsPerImage);
          await recordRun({
            model: model.modelId,
            status: 'failed',
            latencyMs: durationMs,
            errorCode: 'content_hash_failed',
          });
          attempts.push({
            modelId: model.modelId,
            outcome: 'transient_failure',
            durationMs,
            neurons: model.neuronsPerImage,
          });
          return { kind: 'deferred', reason: 'provider_unavailable', attempts };
        }
        const image: GeneratedImage = {
          bytes: outcome.bytes,
          contentType: outcome.contentType,
          modelId: model.modelId,
          prompt: built.prompt,
          seed: outcome.seedUsed,
          neurons: model.neuronsPerImage,
          sha256Hex,
        };
        attempts.push({
          modelId: model.modelId,
          outcome: 'succeeded',
          durationMs,
          neurons: model.neuronsPerImage,
        });
        deps.logger.info('ai.image.attempt', {
          modelId: model.modelId,
          policyVersion: AI_IMAGE_POLICY_VERSION,
          outcome: 'succeeded',
          durationMs,
          neurons: model.neuronsPerImage,
        });
        await recordRun({
          model: model.modelId,
          status: 'succeeded',
          latencyMs: durationMs,
          errorCode: null,
        });
        await noteBreakerSuccess();
        return { kind: 'generated', image, attempts };
      }

      // ---- Failure mapping (charge-on-success + breaker rules).
      const recordOutcome: ImageGenerationAttemptRecord['outcome'] =
        outcome.kind === 'refused'
          ? 'refused'
          : outcome.kind === 'model_unavailable'
            ? 'model_unavailable'
            : outcome.kind === 'quota_denied'
              ? 'quota_denied'
              : outcome.kind === 'auth_failed'
                ? 'auth_failed'
                : outcome.kind === 'invalid_prompt'
                  ? 'invalid_prompt'
                  : outcome.kind === 'deadline_exceeded'
                    ? 'deadline_exceeded'
                    : 'transient_failure';
      attempts.push({
        modelId: model.modelId,
        outcome: recordOutcome,
        durationMs,
        neurons: model.neuronsPerImage,
      });
      deps.logger.info('ai.image.attempt', {
        modelId: model.modelId,
        policyVersion: AI_IMAGE_POLICY_VERSION,
        outcome: recordOutcome,
        durationMs,
        neurons: model.neuronsPerImage,
      });
      await recordRun({
        model: model.modelId,
        status: outcome.kind === 'invalid_prompt' ? 'invalid' : 'failed',
        latencyMs: durationMs,
        errorCode:
          outcome.kind === 'refused'
            ? 'provider_safety_refusal'
            : outcome.kind === 'quota_denied'
              ? 'quota_denied'
              : outcome.kind === 'auth_failed'
                ? 'auth_failed'
                : outcome.kind === 'model_unavailable'
                  ? 'model_unavailable'
                  : outcome.kind === 'deadline_exceeded'
                    ? 'deadline_exceeded'
                    : outcome.kind === 'invalid_prompt'
                      ? 'invalid_prompt'
                      : 'transient',
      });

      if (outcome.kind === 'refused') {
        // TERMINAL: never hop models to bypass a safety refusal. The
        // provider answered — the charge stays, the breaker is untouched.
        lastReason = 'refused';
        break;
      }
      if (outcome.kind === 'invalid_prompt') {
        // The prompt is the same for every model — hopping cannot help.
        // No provider work was done, so the attempt is refunded.
        await refundAttempt(model.neuronsPerImage);
        lastReason = 'invalid_prompt';
        break;
      }
      if (outcome.kind === 'auth_failed') {
        // Binding-wide: no other model on this binding can succeed.
        await refundAttempt(model.neuronsPerImage);
        lastReason = 'auth_failed';
        break;
      }
      if (outcome.kind === 'deadline_exceeded') {
        await refundAttempt(model.neuronsPerImage);
        await noteBreakerFailure();
        lastReason = 'deadline_exceeded';
        break;
      }
      // transient / model_unavailable / quota_denied: refund, and the
      // breaker counts ONLY the provider-failure classes (never quota).
      await refundAttempt(model.neuronsPerImage);
      if (outcome.kind === 'transient' || outcome.kind === 'model_unavailable') {
        await noteBreakerFailure();
      }
      lastReason = outcome.kind === 'quota_denied' ? 'quota_denied' : 'provider_unavailable';
    }

    return { kind: 'deferred', reason: lastReason, attempts };
  }

  return { generateImage };
}
