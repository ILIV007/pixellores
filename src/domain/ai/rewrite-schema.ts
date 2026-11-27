/**
 * Zod-validated rewrite output contract (ADR-0070 §3).
 *
 * The rewrite output carries NO claims: the service keeps the stored
 * `modelClaims` byte-identical, so claim preservation is structural, not
 * a promise. Provider output is parsed with this schema BEFORE any use:
 * unknown/unexpected fields are rejected (`.strict()`), empty or
 * oversized fields are rejected, malformed/truncated JSON never parses.
 */

import { z } from 'zod';
import { SOUL_CATEGORY_EMOJIS, SOUL_TRUST_LABELS } from './types';
import type { AiRewriteOutput } from './rewrite-prompt';

/** Shape Gemini must emit for the news-rewrite task (versioned v1). */
export const aiRewriteOutputSchema = z
  .object({
    headlineFa: z.string().min(1).max(200),
    summaryFa: z.string().min(1).max(1000),
    categoryEmoji: z.enum(SOUL_CATEGORY_EMOJIS),
    trustLabel: z.enum(SOUL_TRUST_LABELS),
  })
  .strict();

/** Stable rejection codes for rewrite output failures (never raw payloads). */
export type AiRewriteOutputRejectCode = 'malformed_json' | 'schema_mismatch' | 'empty_output';

/** Classify one raw provider completion into a parsed rewrite or a stable code. */
export function parseAiRewriteOutputJson(rawText: string):
  | {
      ok: true;
      rewrite: AiRewriteOutput;
    }
  | {
      ok: false;
      code: AiRewriteOutputRejectCode;
    } {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'empty_output' };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: 'malformed_json' };
  }
  const parsed = aiRewriteOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, code: 'schema_mismatch' };
  }
  return { ok: true, rewrite: parsed.data };
}
