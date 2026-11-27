/**
 * Zod-validated inbound rewrite output contract (ADR-0073 §3).
 *
 * The inbound rewrite output is ONE field: the complete rewritten post
 * text, carrying form #4 markup (`**…**` bold spans, `> …` blockquote
 * lines) that the deterministic marker converter turns into Telegram
 * entities. Provider output is parsed with this schema BEFORE any use:
 * unknown/unexpected fields are rejected (`.strict()`), an empty or
 * oversized text is rejected, malformed/truncated JSON never parses.
 */

import { z } from 'zod';
import type { AiInboundRewriteOutput } from './inbound-rewrite-prompt';

/** Shape Gemini must emit for the inbound-rewrite task (versioned v1). */
export const aiInboundRewriteOutputSchema = z
  .object({
    text: z.string().min(1).max(4096),
  })
  .strict();

/** Stable rejection codes for inbound rewrite output failures (never raw payloads). */
export type AiInboundRewriteOutputRejectCode =
  'malformed_json' | 'schema_mismatch' | 'empty_output';

/** Classify one raw provider completion into a parsed rewrite or a stable code. */
export function parseAiInboundRewriteOutputJson(rawText: string):
  | {
      ok: true;
      rewrite: AiInboundRewriteOutput;
    }
  | {
      ok: false;
      code: AiInboundRewriteOutputRejectCode;
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
  const parsed = aiInboundRewriteOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, code: 'schema_mismatch' };
  }
  return { ok: true, rewrite: parsed.data };
}
