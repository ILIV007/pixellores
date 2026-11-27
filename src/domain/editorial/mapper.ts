/**
 * Pure editorial mapping (Phase 5A — ADR-0042 §2): conservative evidence /
 * claim / draft shapes derived from stored source items and the validated
 * AI output. NO SQL, NO provider SDK, NO clock — every function is
 * deterministic and unit-testable offline.
 *
 * Conservatism contract (Posidon R1.11 §4–§7):
 * - The model output NEVER raises confidence and NEVER confirms a claim.
 * - Model-proposed claims live inside draft `document_json`/`facts_json`
 *   with status `unverified` — they are NOT rows in `claims` and carry no
 *   editorial trust. The full Fact Guard remains a later phase.
 * - The only durable `claims` row is the SOURCE REPORT: "source X reported
 *   this text" — `claim_type='source_report'`, `status='unverified'`,
 *   `confidence=0`, with `object_text` traceable to the SAME source item.
 * - Evidence links the report to its item with `stance='mentions'` and
 *   `confidence=0`: the existence of a link/text is NOT `supports` and
 *   NOT confirmation.
 * - The saved draft is `status='ready'`: "a draft is stored" — never
 *   validated / auto_approved / published.
 * - The Persian output of the model is a demo fixture of THIS offline
 *   path; no live-model Persian quality is claimed.
 */

import type { AiSemanticDraft } from '../ai/types';
import { EDITORIAL_DRAFT_VERSION } from './identity';
import type { EvidenceGuardReport } from './evidence-guard';
import type { CandidateDiscoveryReport } from './candidate-discovery';
import type { CandidateAssessmentReport } from './candidate-assessment';
import type { CandidateMatchingReport } from './candidate-matching';
import type { CandidateAdjudicationReport } from './candidate-adjudication';
import type { FactGuardReport } from './fact-guard';
import type { EntityMentionsReport } from './entity-mentions';
import type { EventRelationDecisionReport } from './event-relation-decision';

/** Fixed draft layout id for this phase's renderer contract. */
export const EDITORIAL_DRAFT_LAYOUT = 'news_v1' as const;

/** Actor recorded on drafts created by this pipeline. */
export const EDITORIAL_CREATED_BY = 'editorial.prepare_draft' as const;

/** Stable evidence identifier for the AI request: the source_item id itself. */
export interface EditorialEvidenceInput {
  readonly id: string;
  readonly text: string;
}

/** Bounded, traceable excerpt built from the stored item's own fields. */
export interface TraceableExcerpt {
  readonly text: string;
  readonly truncated: boolean;
}

/** Hard bound for the traceable excerpt (UTF-16 code units; D1 TEXT). */
export const EDITORIAL_EXCERPT_MAX_CHARS = 4000;

/** Maximum traceable snippet text handed to the AI service (see 16 KiB check). */
export const EDITORIAL_AI_SNIPPET_MAX_CHARS = 8000;

/**
 * The FULL evidence input text for one item (title + body composed),
 * BEFORE ANY truncation (R1.11.1 — Posidon correctness review): this is
 * the "defined evidence input" the AI input-limit byte cap applies to.
 * The single composition source for both this measure and the traceable
 * excerpt, so the two can never drift apart.
 */
export function buildFullEvidenceText(item: {
  readonly title: string;
  readonly body_excerpt: string | null;
}): string {
  const body = item.body_excerpt?.trim() ?? '';
  return body.length > 0 ? `${item.title.trim()}\n\n${body}` : item.title.trim();
}

/**
 * Build the traceable excerpt from the item's OWN stored fields (title +
 * body_excerpt). `truncated` marks an excerpt cut at the bound — never
 * silently: the marker lands in draft warnings.
 *
 * R1.11.1 ordering contract: the byte cap on the FULL evidence input is
 * checked by the CALLER on `buildFullEvidenceText` BEFORE this excerpt
 * (or any other text) is cut — truncation may never smuggle an oversized
 * input past the AI input limit.
 */
export function buildTraceableExcerpt(item: {
  readonly title: string;
  readonly body_excerpt: string | null;
}): TraceableExcerpt {
  const full = buildFullEvidenceText(item);
  if (full.length <= EDITORIAL_EXCERPT_MAX_CHARS) {
    return { text: full, truncated: false };
  }
  return {
    text: `${full.slice(0, EDITORIAL_EXCERPT_MAX_CHARS)}…`,
    truncated: true,
  };
}

/** The AI request evidence list: exactly one snippet — the item's own text. */
export function buildAiEvidenceInput(
  sourceItemId: string,
  excerpt: TraceableExcerpt,
): {
  readonly snippet: EditorialEvidenceInput;
  readonly rejected: 'oversized' | null;
} {
  if (excerpt.text.length > EDITORIAL_AI_SNIPPET_MAX_CHARS) {
    return { snippet: { id: sourceItemId, text: excerpt.text }, rejected: 'oversized' };
  }
  return { snippet: { id: sourceItemId, text: excerpt.text }, rejected: null };
}

/** The conservative `source_report` claim shape (pure data, no id/timestamps). */
export function buildSourceReportClaim(input: {
  readonly sourceName: string;
  readonly excerpt: TraceableExcerpt;
}): {
  readonly claimType: 'source_report';
  readonly subject: string;
  readonly predicate: 'reported';
  readonly objectText: string;
  readonly confidence: 0;
  readonly status: 'unverified';
} {
  return {
    claimType: 'source_report',
    subject: input.sourceName,
    predicate: 'reported',
    objectText: input.excerpt.text,
    confidence: 0,
    status: 'unverified',
  };
}

/** The conservative `mentions` evidence shape (pure data). */
export function buildMentionsEvidence(input: { readonly excerpt: TraceableExcerpt }): {
  readonly stance: 'mentions';
  readonly confidence: 0;
  readonly excerpt: string;
} {
  return {
    stance: 'mentions',
    confidence: 0,
    excerpt: input.excerpt.text,
  };
}

/** Stable, safe warning labels persisted in `drafts.warnings_json`. */
export const EDITORIAL_DRAFT_WARNINGS = [
  'model_output_unverified',
  'single_source_report',
  'fact_guard_pending',
] as const;

/**
 * Build the draft persistence shape from the validated AI output and the
 * traceable excerpt. Model claims are kept with `status:'unverified'` and
 * their evidence references — NEVER promoted into durable claims.
 *
 * R1.12 (Phase 5B): the caller MUST pass the Evidence Guard v1 report
 * computed by the pure evaluator for THIS draft — it is embedded as an
 * ADDITIVE versioned field of `document_json` (guardVersion inside;
 * `schemaVersion` stays 1) and stored by the SAME fenced atomic commit.
 * The report's `claims[i]` corresponds to `document.modelClaims[i]`
 * (and `facts[i]`) by index — the document holds the texts, the report
 * holds the honest per-claim outcomes.
 *
 * R1.13 (Phase 5C-1): the caller MUST also pass the candidate-discovery
 * report for THIS draft (possibly `no_candidates_observed`) — embedded as
 * another ADDITIVE versioned field (`discoveryVersion` inside;
 * `schemaVersion` stays 1) of the SAME `document_json`. It is a proposal
 * of possibly-related previously-indexed stories at the lookup moment —
 * candidate discovery ONLY, never a merge, never truth verification.
 *
 * R1.14 (Phase 5C-2): the caller MUST also pass the candidate-ASSESSMENT
 * report — the pure, deterministic, conservative classification derived
 * from THIS draft's OWN discovery report (possibly with zero entries and
 * `unrelatednessConcluded: false`) — embedded as one more ADDITIVE
 * versioned field (`assessmentVersion` inside; `schemaVersion` stays 1)
 * of the SAME `document_json` and the SAME fenced atomic commit. It says
 * what was actually OBSERVED about the candidates' relation — never a
 * same-event proof, never truth, never source independence, never a
 * merge.
 *
 * R1.16 (Phase 5D): the caller MUST also pass the controlled-entity
 * ALIAS mentions report for THIS draft (possibly an honest
 * `no_match_observed`) — embedded as one more ADDITIVE versioned field
 * (`mentionsVersion`/`policyVersion` inside; `schemaVersion` stays 1) of
 * the SAME `document_json` and the SAME fenced atomic commit. It records
 * which CONTROLLED catalog aliases the item's OWN full composed text
 * explicitly mentioned at the lookup moment — `mentioned` ONLY,
 * confidence 0, never a verification, never a merge, and NEVER catalog
 * enrichment of replayed/reused or historical drafts.
 *
 * R1.17 (Phase 5E-1): the caller MUST also pass the event-relation
 * DECISION ledger for THIS draft (possibly an honest `disabled` or
 * `no_candidates_observed` observation) — embedded as one more ADDITIVE
 * versioned field (`eventRelationVersion`/`policyVersion` inside;
 * `schemaVersion` stays 1) of the SAME `document_json` and the SAME
 * fenced atomic commit. It is the durable, evidence-referenced ledger of
 * the bounded relation step of THIS input — a MODEL PROPOSAL at most,
 * never a merge, never truth, and NEVER a backfill of replayed/reused or
 * historical drafts.
 *
 * Phase 5C-4 (V4 Phase 5.2): the caller MAY pass the deterministic
 * candidate-MATCHING report for THIS draft — an ADDITIVE versioned field
 * (`matchingVersion` inside; `schemaVersion` stays 1) of the SAME
 * `document_json` and the SAME fenced atomic commit, computed ONLY when
 * the independent EDITORIAL_MATCHING_ENABLED gate is ON. ABSENT is the
 * honest historical/flag-off shape: the key is simply not written (never
 * an empty placeholder), pre-slice drafts read `absent`, and the accepted
 * default path stays byte-identical. It is a pure zero-SQL/zero-cost
 * derivation of the discovery + assessment already carried by this
 * document — never a merge, never a threshold, never a publication effect.
 *
 * Phase 5.3 (V4 2026-11-10): the caller MAY pass the deterministic
 * candidate-ADJUDICATION report for THIS draft — one more ADDITIVE
 * versioned field (`adjudicationVersion` + `mergePolicyVersion` inside;
 * `schemaVersion` stays 1) of the SAME `document_json` and the SAME
 * fenced atomic commit, computed ONLY when BOTH the independent
 * EDITORIAL_ADJUDICATION_ENABLED gate AND its sibling
 * EDITORIAL_MATCHING_ENABLED gate are ON (the flags NEVER imply each
 * other). ABSENT is the honest shape: the key is simply not written. It
 * is a pure zero-SQL/zero-cost derivation of the matching report already
 * carried by this document — the identity-stance layer (exact composite
 * identity = the only reuse-locator support; every weaker similarity
 * defers to review) under the versioned `mp1` merge policy — never an
 * executed merge, never a threshold, never a publication effect.
 *
 * Prompt v2 (ADR-0066): the model's Soul v1 form choice (category emoji
 * + trust label, validated by the output schema) rides INSIDE the SAME
 * `document_json` as the ADDITIVE `soulForm` field (`schemaVersion`
 * stays 1). The RENDER does not consume it yet — a separate fix owns
 * the Soul form in the render; the draft only carries the choice.
 * Present on every draft built under prompt v2; absent is the honest
 * historical (prompt-v1) shape — never backfilled, never invented.
 *
 * Prompt v3 (ADR-0070): the draft prompt NO LONGER produces the Soul
 * form — Workers AI does raw extraction only. `soulForm` is now
 * OPTIONAL and written ONLY when the semantic draft carries BOTH fields
 * (a v2-shaped input); a v3 draft honestly has NO soulForm. The Gemini
 * rewrite writes it later (see `applyRewriteToDocument` below). Old
 * drafts are never backfilled.
 */
export function buildDraftDocument(input: {
  readonly sourceItemId: string;
  readonly sourceName: string;
  readonly excerpt: TraceableExcerpt;
  readonly semanticDraft: AiSemanticDraft;
  readonly evidenceGuard: EvidenceGuardReport;
  /** R1.13: the versioned candidate-discovery report (required — every
   * new draft carries one, even an honest "nothing observed"). */
  readonly candidateDiscovery: CandidateDiscoveryReport;
  /** R1.14: the versioned candidate-ASSESSMENT derived from THIS draft's
   * discovery report (required — every new draft carries one). */
  readonly candidateAssessment: CandidateAssessmentReport;
  /** R1.16: the versioned controlled-alias mentions report (required —
   * every new draft carries one, even an honest "nothing observed"). */
  readonly entityMentions: EntityMentionsReport;
  /** R1.17: the versioned event-relation DECISION ledger (required —
   * every new draft carries one, even an honest "disabled" or "nothing
   * observed"). */
  readonly eventRelation: EventRelationDecisionReport;
  /** Phase 5C-4 (V4 5.2): the versioned candidate-MATCHING report —
   * OPTIONAL: computed ONLY under the independent
   * EDITORIAL_MATCHING_ENABLED gate; absent = the key is not written. */
  readonly candidateMatching?: CandidateMatchingReport;
  /** Phase 5.3 (V4): the versioned candidate-ADJUDICATION report —
   * OPTIONAL: computed ONLY under BOTH the independent
   * EDITORIAL_ADJUDICATION_ENABLED gate AND the sibling matching gate;
   * absent = the key is not written. */
  readonly candidateAdjudication?: CandidateAdjudicationReport;
  /** Phase 6.3 (V4): the versioned FACT-GUARD report — OPTIONAL:
   * computed ONLY under the independent EDITORIAL_FACT_GUARD_ENABLED
   * gate; absent = the key is not written. It rides INSIDE the SAME
   * fenced commit and NEVER rewrites a claim's stored `unverified`
   * status — a bounded lexical observation layer, not a truth engine. */
  readonly factGuard?: FactGuardReport;
}): {
  readonly layout: typeof EDITORIAL_DRAFT_LAYOUT;
  readonly title: string;
  readonly document: {
    readonly schemaVersion: 1;
    readonly locale: 'fa';
    readonly headlineFa: string;
    readonly summaryFa: string;
    readonly sourceReport: {
      readonly sourceItemId: string;
      readonly sourceName: string;
      readonly stance: 'mentions';
      readonly excerptText: string;
      readonly truncated: boolean;
    };
    readonly modelClaims: readonly {
      readonly text: string;
      readonly evidenceIds: readonly string[];
      readonly status: 'unverified';
    }[];
    readonly evidenceGuard: EvidenceGuardReport;
    readonly candidateDiscovery: CandidateDiscoveryReport;
    readonly candidateAssessment: CandidateAssessmentReport;
    readonly entityMentions: EntityMentionsReport;
    readonly eventRelation: EventRelationDecisionReport;
    /** Present ONLY when the matching gate is ON (never an empty key). */
    readonly candidateMatching?: CandidateMatchingReport;
    /** Present ONLY when BOTH the adjudication and matching gates are ON
     * (never an empty key). */
    readonly candidateAdjudication?: CandidateAdjudicationReport;
    /** Present ONLY when the fact-guard gate is ON (never an empty key). */
    readonly factGuard?: FactGuardReport;
    /**
     * The Soul v1 form choice (prompt v2; validated enums) — OPTIONAL
     * since ADR-0070: prompt-v3 raw drafts honestly carry NO soulForm
     * (Workers AI never chooses it); the Gemini rewrite writes it later.
     * Present on v2 drafts and on rewritten drafts; absent is the honest
     * raw shape — never backfilled, never invented. The render does not
     * consume it yet.
     */
    readonly soulForm?: {
      readonly categoryEmoji: string;
      readonly trustLabel: string;
    };
    /**
     * The Gemini rewrite block (ADR-0070) — OPTIONAL, additive, written
     * ONLY by the rewrite commit. Absent = the draft was never rewritten
     * (raw v3 shape). `status: 'rewritten'` is the bridge's proof the
     * Soul voice is Gemini's; `'failed'` excludes the draft from
     * auto-publish until a human reviews it.
     */
    readonly rewrite?: EditorialDraftRewriteBlock;
    /** Raw texts preserved for audit when a rewrite replaces them
     * (ADR-0070 §4) — additive, written ONLY by the rewrite commit. */
    readonly rawHeadlineFa?: string;
    readonly rawSummaryFa?: string;
  };
  readonly facts: readonly {
    readonly text: string;
    readonly evidenceIds: readonly string[];
    readonly status: 'unverified';
    readonly origin: 'model';
  }[];
  readonly warnings: readonly string[];
} {
  const modelClaims = input.semanticDraft.claims.map((claim) => ({
    text: claim.text,
    evidenceIds: claim.evidenceIds,
    status: 'unverified' as const,
  }));
  const warnings = [
    ...EDITORIAL_DRAFT_WARNINGS,
    ...(input.excerpt.truncated ? (['excerpt_truncated'] as const) : []),
  ];
  return {
    layout: EDITORIAL_DRAFT_LAYOUT,
    title: input.semanticDraft.headlineFa,
    document: {
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: input.semanticDraft.headlineFa,
      summaryFa: input.semanticDraft.summaryFa,
      sourceReport: {
        sourceItemId: input.sourceItemId,
        sourceName: input.sourceName,
        stance: 'mentions',
        excerptText: input.excerpt.text,
        truncated: input.excerpt.truncated,
      },
      modelClaims,
      evidenceGuard: input.evidenceGuard,
      candidateDiscovery: input.candidateDiscovery,
      candidateAssessment: input.candidateAssessment,
      entityMentions: input.entityMentions,
      eventRelation: input.eventRelation,
      ...(input.candidateMatching !== undefined
        ? { candidateMatching: input.candidateMatching }
        : {}),
      ...(input.candidateAdjudication !== undefined
        ? { candidateAdjudication: input.candidateAdjudication }
        : {}),
      ...(input.factGuard !== undefined ? { factGuard: input.factGuard } : {}),
      // ADR-0070: prompt-v3 raw drafts carry NO Soul form — the fields
      // are written ONLY when the semantic draft actually has both (a
      // v2-shaped input). Absent is the honest raw shape.
      ...(input.semanticDraft.categoryEmoji !== undefined &&
      input.semanticDraft.trustLabel !== undefined
        ? {
            soulForm: {
              categoryEmoji: input.semanticDraft.categoryEmoji,
              trustLabel: input.semanticDraft.trustLabel,
            },
          }
        : {}),
    },
    facts: modelClaims.map((claim) => ({
      text: claim.text,
      evidenceIds: claim.evidenceIds,
      status: 'unverified' as const,
      origin: 'model' as const,
    })),
    warnings,
  };
}

/** Draft version this pipeline writes (re-exported for callers). */
export const DRAFT_VERSION = EDITORIAL_DRAFT_VERSION;

/**
 * ADR-0070 — the Gemini rewrite block carried additively in
 * `document_json`. `status: 'rewritten'` is the bridge's proof the Soul
 * voice is Gemini's; `'failed'` excludes the draft from auto-publish
 * until a human reviews it; `'pending'` (implementation addition: the
 * ADR names only rewritten/failed) records a failed invocation that has
 * NOT yet exhausted the 2-attempt budget, so the spent count survives
 * across job generations. Absent = never rewritten (raw v3 shape). The
 * bridge defers ANY status other than `'rewritten'`.
 */
export interface EditorialDraftRewriteBlock {
  readonly status: 'rewritten' | 'failed' | 'pending';
  /** Provider that authored the final text ('gemini' — never Workers AI). */
  readonly model: string;
  /** Rewrite prompt version (pixel-news-rewrite-v1). */
  readonly promptVersion: string;
  /** Soul version the rewrite prompt encodes (v1). */
  readonly soulVersion: string;
  /** Rewrite invocations spent on this draft (max 2 — ADR-0070 §5). */
  readonly attempts: number;
  /** Epoch ms of the successful rewrite (rewritten only). */
  readonly rewrittenAtMs?: number;
  /** Epoch ms the draft was marked failed (failed only). */
  readonly failedAtMs?: number;
  /** Stable failure reason code (failed only). */
  readonly reason?: string;
}

/**
 * Minimal structural shape of a STORED draft document for the rewrite
 * path (ADR-0070). The index signature keeps every other additive report
 * (evidenceGuard, candidateDiscovery, factGuard, …) riding along
 * untouched through the rewrite's object spread — the rewrite replaces
 * ONLY headlineFa/summaryFa/soulForm/rewrite/raw* and never drops a
 * sibling field.
 */
export interface StoredDraftDocument {
  readonly schemaVersion: 1;
  readonly locale: 'fa';
  readonly headlineFa: string;
  readonly summaryFa: string;
  readonly sourceReport: {
    readonly sourceItemId: string;
    readonly sourceName: string;
    readonly stance: 'mentions';
    readonly excerptText: string;
    readonly truncated: boolean;
  };
  readonly modelClaims: readonly {
    readonly text: string;
    readonly evidenceIds: readonly string[];
    readonly status: 'unverified';
  }[];
  readonly soulForm?: {
    readonly categoryEmoji: string;
    readonly trustLabel: string;
  };
  readonly rewrite?: EditorialDraftRewriteBlock;
  readonly rawHeadlineFa?: string;
  readonly rawSummaryFa?: string;
  readonly [key: string]: unknown;
}

/** The validated input the rewrite service needs from a stored draft. */
export interface RewriteDraftInput {
  readonly document: StoredDraftDocument;
  /** Raw headline + summary + claim texts — the rewrite's fact basis. */
  readonly headlineFa: string;
  readonly summaryFa: string;
  readonly claimTexts: readonly string[];
  readonly sourceName: string;
  /** Rewrite invocations already spent on this draft (0 when absent). */
  readonly attemptsSpent: number;
  /** True when the document is already marked rewrite.failed. */
  readonly alreadyFailed: boolean;
  /** True when the document is already marked rewrite.rewritten. */
  readonly alreadyRewritten: boolean;
}

/**
 * Validate a stored `document_json` for the rewrite path. Returns null
 * for ANY structural problem (not an object, missing/empty headline or
 * summary, malformed claims/sourceReport) — the handler maps null to a
 * typed permanent outcome, never a guessed rewrite input. A present but
 * malformed `rewrite` block is also a rejection: a half-written block
 * must never decide the draft's fate.
 *
 * SHAPE NOTE (found by the rewrite-draft integration test, 2026-11-27):
 * the stored `document_json` is the BARE StoredDraftDocument — the
 * prepare-draft handler stores `canonicalizeJson(document.document)`,
 * not the `{title, document, facts, warnings}` build wrapper — and
 * every other reader (the auto-gate, the exact-content basis) reads it
 * bare. This parser reads the bare record directly; an earlier version
 * unwrapped a `document` key that never exists in stored JSON, which
 * would have rejected every real draft as invalid.
 */
export function parseDraftDocumentForRewrite(documentJson: string): RewriteDraftInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const doc = parsed as Record<string, unknown>;
  const headlineFa = doc['headlineFa'];
  const summaryFa = doc['summaryFa'];
  if (typeof headlineFa !== 'string' || headlineFa.trim().length === 0) {
    return null;
  }
  if (typeof summaryFa !== 'string' || summaryFa.trim().length === 0) {
    return null;
  }
  const modelClaims = doc['modelClaims'];
  if (!Array.isArray(modelClaims)) {
    return null;
  }
  const claimTexts: string[] = [];
  for (const claim of modelClaims) {
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      return null;
    }
    const text = (claim as Record<string, unknown>)['text'];
    if (typeof text !== 'string' || text.length === 0) {
      return null;
    }
    claimTexts.push(text);
  }
  const sourceReport = doc['sourceReport'];
  if (sourceReport === null || typeof sourceReport !== 'object' || Array.isArray(sourceReport)) {
    return null;
  }
  const sourceName = (sourceReport as Record<string, unknown>)['sourceName'];
  if (typeof sourceName !== 'string' || sourceName.length === 0) {
    return null;
  }
  const rewrite = doc['rewrite'];
  let attemptsSpent = 0;
  let alreadyFailed = false;
  let alreadyRewritten = false;
  if (rewrite !== undefined) {
    if (rewrite === null || typeof rewrite !== 'object' || Array.isArray(rewrite)) {
      return null;
    }
    const rewriteRecord = rewrite as Record<string, unknown>;
    const status = rewriteRecord['status'];
    if (status !== 'rewritten' && status !== 'failed' && status !== 'pending') {
      return null;
    }
    const attempts = rewriteRecord['attempts'];
    if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) {
      return null;
    }
    attemptsSpent = attempts;
    alreadyFailed = status === 'failed';
    alreadyRewritten = status === 'rewritten';
  }
  return {
    document: doc as unknown as StoredDraftDocument,
    headlineFa,
    summaryFa,
    claimTexts,
    sourceName,
    attemptsSpent,
    alreadyFailed,
    alreadyRewritten,
  };
}

/**
 * Apply a successful Gemini rewrite IN PLACE (ADR-0070 §4): the
 * rewritten headline/summary REPLACE the raw texts; the raw texts are
 * preserved for audit as `rawHeadlineFa`/`rawSummaryFa` (an existing
 * raw pair — a second rewrite — is kept, never overwritten with
 * already-rewritten text); the Soul form rides as `soulForm`; the
 * `rewrite` block records the proof. Claims and every sibling report
 * are untouched (object spread, not a rebuild).
 */
export function applyRewriteToDocument(
  document: StoredDraftDocument,
  rewrite: {
    readonly headlineFa: string;
    readonly summaryFa: string;
    readonly categoryEmoji: string;
    readonly trustLabel: string;
    readonly model: string;
    readonly promptVersion: string;
    readonly soulVersion: string;
    readonly attempts: number;
    readonly rewrittenAtMs: number;
  },
): StoredDraftDocument {
  return {
    ...document,
    headlineFa: rewrite.headlineFa,
    summaryFa: rewrite.summaryFa,
    rawHeadlineFa: document.rawHeadlineFa ?? document.headlineFa,
    rawSummaryFa: document.rawSummaryFa ?? document.summaryFa,
    soulForm: {
      categoryEmoji: rewrite.categoryEmoji,
      trustLabel: rewrite.trustLabel,
    },
    rewrite: {
      status: 'rewritten',
      model: rewrite.model,
      promptVersion: rewrite.promptVersion,
      soulVersion: rewrite.soulVersion,
      attempts: rewrite.attempts,
      rewrittenAtMs: rewrite.rewrittenAtMs,
    },
  };
}

/**
 * Record a FAILED rewrite invocation that has NOT yet exhausted the
 * 2-attempt budget (ADR-0070 §5): the raw texts stay exactly as they
 * are; only the `rewrite` block changes, to `pending` with the spent
 * count — so the next job generation knows one attempt is already gone.
 * The draft stays `ready` and the bridge keeps deferring it.
 */
export function markRewritePendingOnDocument(
  document: StoredDraftDocument,
  pending: {
    readonly promptVersion: string;
    readonly soulVersion: string;
    readonly attempts: number;
  },
): StoredDraftDocument {
  return {
    ...document,
    rewrite: {
      status: 'pending',
      model: 'gemini',
      promptVersion: pending.promptVersion,
      soulVersion: pending.soulVersion,
      attempts: pending.attempts,
    },
  };
}

/**
 * Mark a draft's rewrite FAILED (ADR-0070 §5): the raw texts stay
 * exactly as they are (no rewritten text exists to apply); only the
 * `rewrite` block changes. The draft stays `ready` in D1 — the BRIDGE
 * excludes it from auto-publish, never the handler.
 */
export function markRewriteFailedOnDocument(
  document: StoredDraftDocument,
  failure: {
    readonly reason: string;
    readonly promptVersion: string;
    readonly soulVersion: string;
    readonly attempts: number;
    readonly failedAtMs: number;
  },
): StoredDraftDocument {
  return {
    ...document,
    rewrite: {
      status: 'failed',
      model: 'gemini',
      promptVersion: failure.promptVersion,
      soulVersion: failure.soulVersion,
      attempts: failure.attempts,
      failedAtMs: failure.failedAtMs,
      reason: failure.reason,
    },
  };
}
