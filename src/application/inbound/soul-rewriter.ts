/**
 * Soul rewriter for the inbound pipeline (ADR-0073 §1): a thin adapter
 * over the ADR-0070 rewrite service's `rewriteInboundPost` (Gemini ONLY
 * — Soul belongs only to Gemini; Workers AI never author the final
 * post). The old Workers-AI-first inbound rewriter
 * (`ai-rewriter.ts`, retired with this change) is replaced, not
 * wrapped: the pipeline's `InboundRewriter` contract is unchanged, so
 * the pipeline itself needs no rewrite-related change.
 *
 * The adapter adds no gates of its own: the service gates on
 * `AI_ENABLED && AI_GEMINI_ENABLED && key && eligibility` (ADR-0073
 * §2 — deliberately no `AI_GEMINI_REWRITE_ENABLED` stage gate). A
 * deferred or refused outcome falls back to the cleaned text in the
 * pipeline — never fabricate.
 */

import type { AiRewriteService } from '../ai/rewrite-service';
import type { AiDeferredReason } from '../../domain/ai/types';
import type { GamingCategory } from '../../domain/inbound/classifier';

export type InboundRewriteOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly attempts: number }
  | { readonly kind: 'deferred'; readonly reason: AiDeferredReason; readonly attempts: number }
  | {
      readonly kind: 'refused';
      readonly reason: 'provider_safety_refusal';
      readonly attempts: number;
    };

export interface InboundRewriter {
  rewrite(input: {
    readonly text: string;
    readonly category: GamingCategory;
    readonly isCaption: boolean;
  }): Promise<InboundRewriteOutcome>;
}

export interface SoulRewriterDeps {
  readonly rewriteService: AiRewriteService;
}

/** Build the inbound pipeline's rewriter over the Soul rewrite service. */
export function createSoulInboundRewriter(deps: SoulRewriterDeps): InboundRewriter {
  const { rewriteService } = deps;
  return {
    async rewrite(input) {
      const outcome = await rewriteService.rewriteInboundPost({
        text: input.text,
        category: input.category,
        isCaption: input.isCaption,
      });
      if (outcome.kind === 'rewritten') {
        return { kind: 'ok', text: outcome.text, attempts: outcome.attempts.length };
      }
      if (outcome.kind === 'refusal') {
        return {
          kind: 'refused',
          reason: 'provider_safety_refusal',
          attempts: outcome.attempts.length,
        };
      }
      return {
        kind: 'deferred',
        reason: outcome.reason,
        attempts: outcome.attempts.length,
      };
    },
  };
}
