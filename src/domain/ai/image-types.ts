/**
 * AI IMAGE domain types (ADR-0072) — pure, provider-agnostic contracts.
 *
 * The image surface mirrors the text AI surface (./types.ts) but is
 * deliberately SEPARATE: different budget key, different breaker key,
 * different prompt version, different outcome vocabulary. An image
 * failure is never a text failure and never blocks a post.
 */

import type { SoulCategoryEmoji } from './types';

/** One image-generation provider call outcome (adapter boundary). */
export type ImageGenerationCallOutcome =
  | {
      readonly kind: 'ok';
      /** The decoded image bytes (never a data URI, never base64). */
      readonly bytes: Uint8Array;
      readonly contentType: string;
      /**
       * The seed the provider actually used, or null when the model
       * takes no seed (flux-1-schnell: null — its typed input has no
       * seed parameter). Never invented.
       */
      readonly seedUsed: number | null;
    }
  | { readonly kind: 'refused' }
  | { readonly kind: 'model_unavailable'; readonly retryAfterMs?: number }
  | { readonly kind: 'quota_denied'; readonly retryAfterMs?: number }
  | { readonly kind: 'transient'; readonly retryAfterMs?: number }
  | { readonly kind: 'auth_failed' }
  | { readonly kind: 'invalid_prompt' }
  | { readonly kind: 'deadline_exceeded' };

/**
 * Provider port implemented by the native image adapter (Workers AI
 * binding). Implementations MUST honor the bounded wall deadline to the
 * best of the runtime's ability and MUST classify native failures into
 * the stable kinds above without leaking raw payloads. `width`/`height`
 * are the REQUESTED size; an implementation passes them only when the
 * model's typed input accepts them (flux-1-schnell: ignored).
 */
export interface ImageGeneratorPort {
  readonly provider: 'workers-ai';
  generate(input: {
    readonly modelId: string;
    readonly prompt: string;
    readonly width: number;
    readonly height: number;
    readonly deadlineAtMs: number;
  }): Promise<ImageGenerationCallOutcome>;
}

/** One successfully generated image with its durable provenance. */
export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly modelId: string;
  readonly prompt: string;
  /** The seed actually used, or null when the model takes none. */
  readonly seed: number | null;
  /** Estimated neurons charged for this image (policy table). */
  readonly neurons: number;
  /** SHA-256 hex of the bytes (the media_assets content hash). */
  readonly sha256Hex: string;
}

/** One attempt's sanitized record — safe for logs and caller inspection. */
export interface ImageGenerationAttemptRecord {
  readonly modelId: string;
  readonly outcome:
    | 'succeeded'
    | 'refused'
    | 'transient_failure'
    | 'model_unavailable'
    | 'quota_denied'
    | 'auth_failed'
    | 'deadline_exceeded'
    | 'invalid_prompt';
  readonly durationMs: number;
  readonly neurons: number;
}

/** Stable deferred reasons for the image surface. */
export type ImageDeferredReason =
  | 'ai_disabled'
  | 'input_invalid'
  | 'budget_denied'
  | 'circuit_open'
  | 'quota_denied'
  | 'provider_unavailable'
  | 'deadline_exceeded'
  | 'auth_failed'
  | 'invalid_prompt'
  | 'refused'
  | 'no_free_path';

/** The complete outcome surface of the image-generation service. */
export type ImageGenerationOutcome =
  | {
      readonly kind: 'generated';
      readonly image: GeneratedImage;
      readonly attempts: readonly ImageGenerationAttemptRecord[];
    }
  | {
      readonly kind: 'deferred';
      readonly reason: ImageDeferredReason;
      readonly attempts: readonly ImageGenerationAttemptRecord[];
    };

/** The narrow service port the scheduler consumes (no D1, no binding). */
export interface ImageGenerationServicePort {
  generateImage(input: {
    readonly headline: string;
    readonly categoryEmoji?: SoulCategoryEmoji;
  }): Promise<ImageGenerationOutcome>;
}
