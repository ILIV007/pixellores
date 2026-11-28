/**
 * Zod-validated AI contracts (Phase 6 — ADR-0041).
 *
 * The blueprint defers schema-heavy validation to Zod "in its own phase";
 * the AI adapter round is that phase. Provider output is parsed with these
 * schemas BEFORE any semantic use:
 * - unknown/unexpected fields are rejected (`.strict()`);
 * - empty or oversized fields are rejected;
 * - malformed/truncated JSON never parses.
 * Cross-checks that need the REQUEST (e.g. evidenceIds ⊆ request evidence)
 * stay in the application service — they are not provider-shape checks.
 */

import { z } from 'zod';

/** Maximum generated claims per draft (bounded output contract). */
export const AI_DRAFT_CLAIMS_MAX = 10;

/** Maximum figures per draft — mirrors EDITORIAL_POST_MAX_FIGURES (the render's cap). */
export const AI_DRAFT_FIGURES_MAX = 8;

/** Maximum evidence ids referenced by one claim. */
export const AI_DRAFT_CLAIM_EVIDENCE_MAX = 8;

/** Shape the model must emit for the news-draft task (versioned).
 * Prompt v4 (ADR-0080 §3.8ii, raw extraction + the four structured
 * fields): the model emits a plain factual headline + summary + claims —
 * NO categoryEmoji, NO trustLabel — PLUS the OPTIONAL figures / quote /
 * verdict / gameName. The bounds mirror the render's defensive readers
 * (label ≤120, value ≤40, quote text ≤600, attribution ≤120, verdict
 * ≤300, gameName ≤120, at most one main figure is enforced by the
 * render): a model answer the schema accepts is one the render can
 * compose. A v2-shaped output (with categoryEmoji/trustLabel) still
 * fails this strict schema as invalid_output. */
export const aiSemanticDraftSchema = z
  .object({
    headlineFa: z.string().min(1).max(200),
    summaryFa: z.string().min(1).max(1000),
    claims: z
      .array(
        z
          .object({
            text: z.string().min(1).max(500),
            evidenceIds: z.array(z.string().min(1).max(64)).min(1).max(AI_DRAFT_CLAIM_EVIDENCE_MAX),
          })
          .strict(),
      )
      .max(AI_DRAFT_CLAIMS_MAX),
    figures: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            value: z.string().min(1).max(40),
            significance: z.enum(['headline', 'context']).optional(),
            main: z.boolean().optional(),
          })
          .strict(),
      )
      .max(AI_DRAFT_FIGURES_MAX)
      .optional(),
    quote: z
      .object({
        text: z.string().min(1).max(600),
        attribution: z.string().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
    verdict: z.string().min(1).max(300).optional(),
    gameName: z.string().min(1).max(120).optional(),
  })
  .strict();

export type ParsedAiSemanticDraft = z.infer<typeof aiSemanticDraftSchema>;

/** Stable rejection codes for provider output failures (never raw payloads). */
export type AiOutputRejectCode =
  'malformed_json' | 'schema_mismatch' | 'unknown_evidence_id' | 'empty_output';

/** Classify one raw provider completion into a parsed draft or a stable code. */
export function parseAiSemanticDraftJson(rawText: string):
  | {
      ok: true;
      draft: ParsedAiSemanticDraft;
    }
  | {
      ok: false;
      code: AiOutputRejectCode;
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
  const parsed = aiSemanticDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, code: 'schema_mismatch' };
  }
  return { ok: true, draft: parsed.data };
}
