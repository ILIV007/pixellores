/**
 * Fact-guard RE-EVALUATION (ADR-0074) — the missing path ADR-0066 named
 * and never built.
 *
 * THE PROBLEM: the bridge reads STORED fact-guard reports only. PR #27
 * (ADR-0066) fixed the numbers lens (Persian/Arabic-Indic digits fold to
 * Latin for MATCHING only) but deliberately left FACT_GUARD_VERSION at 1
 * and noted the stored pre-fix reports "are NOT retroactively
 * re-evaluated" — the 20 held drafts keep their false
 * `number_not_observed_in_evidence` findings forever. The auto-gate is
 * TOTAL and deterministic over stored bytes, so the five oldest ready
 * drafts — all failing on Persian-digit tokens that exist in the stored
 * excerpt only as Latin digits — fail the gate on EVERY bridge pass and
 * head-block the whole queue: the bridge never reaches the drafts
 * behind them and the channel stalls indefinitely.
 *
 * WHAT THIS SERVICE DOES (and nothing more): for ONE ready draft, it
 * rebuilds the fact-guard report from the draft's OWN stored claims +
 * the stored source item's OWN stored fields, with the CURRENT folded
 * lens, and replaces the stored report when — and ONLY when — the
 * rebuild validates:
 *  - the stored report is a well-formed v1 report with at least one
 *    `number_not_observed_in_evidence` finding (the fold family — the
 *    ONLY family the lens change can clear; every other lens evaluates
 *    identically under current code, so re-running it would be a no-op
 *    write);
 *  - the source item still exists AND its `content_hash` still equals
 *    the stored report's snapshot hash (a changed item can never
 *    produce a report claiming an identity it does not have);
 *  - the rebuilt excerpt's `truncated` flag still equals the stored
 *    report's (the excerpt composition is the mapper's own function —
 *    any drift means the stored basis moved and the report stays);
 *  - the rebuilt report reads back as a valid v1 report (the reader's
 *    own contract — a rebuild that cannot validate is never stored).
 * The replacement is the compare-and-swap update: it applies ONLY when
 * the draft is still `ready` AND its document is byte-identical to the
 * one evaluated. ONE system audit event records the rebuild (ids and
 * counts only). A re-evaluation that cannot be validated leaves the
 * stored report untouched — fail-closed, never a guessed report.
 *
 * WHAT IT NEVER DOES: it never touches model claims, excerpts, titles
 * or claim `status` (only the DERIVED guard report moves); it never
 * loosens grounding (the folded lens is the approved fix, nothing more);
 * it never invents an excerpt (the excerpt is rebuilt from the stored
 * item's own fields with the mapper's own function — no stored excerpt
 * text exists to drift from); it never re-evaluates a report whose
 * identity is invalid (those claims carry only `identity_inconsistent`
 * findings, so the numbers trigger never fires for them).
 *
 * PURE where it counts: the rebuild itself (`buildFactGuardReport`) is
 * the domain's TOTAL deterministic evaluator — same inputs, same report.
 * The service is the thin durable shell around it (one item read, one
 * fenced write, one audit row), invoked by the bridge exactly when the
 * gate fails on a numbers finding.
 */
import {
  buildFactGuardReport,
  readFactGuardReport,
  FACT_GUARD_VERSION,
} from '../../domain/editorial/fact-guard';
import { buildTraceableExcerpt } from '../../domain/editorial/mapper';
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  findSourceItemForReevaluation,
  insertFactGuardReevaluationAudit,
  replaceDraftFactGuardReport,
} from '../../adapters/db/editorial-store';
import type { Logger } from '../../observability/logger';

export type FactGuardReevaluationOutcome =
  | {
      readonly kind: 'not_applicable';
      readonly reason:
        'report_absent' | 'report_not_v1' | 'no_numbers_findings' | 'claims_malformed';
    }
  | {
      readonly kind: 'skipped';
      readonly reason:
        | 'source_item_missing'
        | 'content_hash_mismatch'
        | 'excerpt_truncated_mismatch'
        | 'rebuilt_report_invalid';
    }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'updated';
      /** The NEW document_json (same document, rebuilt factGuard). */
      readonly documentJson: string;
      /** The rebuilt report requires review on ZERO claims. */
      readonly cleared: boolean;
      readonly claimsRequiringReviewBefore: number;
      readonly claimsRequiringReviewAfter: number;
    }
  | { readonly kind: 'concurrent_change' };

interface StoredModelClaim {
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

function readStoredModelClaims(
  document: Record<string, unknown>,
): readonly StoredModelClaim[] | null {
  const modelClaims = document['modelClaims'];
  if (!Array.isArray(modelClaims)) {
    return null;
  }
  const claims: StoredModelClaim[] = [];
  for (const entry of modelClaims) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    const claim = entry as Record<string, unknown>;
    const text = claim['text'];
    const evidenceIds = claim['evidenceIds'];
    if (
      typeof text !== 'string' ||
      !Array.isArray(evidenceIds) ||
      !evidenceIds.every((id) => typeof id === 'string')
    ) {
      return null;
    }
    claims.push({ text, evidenceIds: evidenceIds as readonly string[] });
  }
  return claims;
}

export async function reevaluateDraftFactGuard(input: {
  readonly executor: DbExecutor;
  readonly draftId: string;
  readonly documentJson: string;
  readonly nowMs: number;
  readonly logger?: Logger;
}): Promise<FactGuardReevaluationOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.documentJson);
  } catch {
    return { kind: 'not_applicable', reason: 'report_not_v1' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'not_applicable', reason: 'report_not_v1' };
  }
  const document = parsed as Record<string, unknown>;
  const read = readFactGuardReport(parsed);
  if (read.kind === 'absent') {
    return { kind: 'not_applicable', reason: 'report_absent' };
  }
  if (read.kind !== 'fact_guard_v1') {
    return { kind: 'not_applicable', reason: 'report_not_v1' };
  }
  const stored = read.report;
  // The fold family ONLY: a numbers finding is the one finding the
  // ADR-0066 lens change can clear. Every other lens evaluates
  // identically under current code — re-running it would be a no-op
  // write, so the service does not attempt it.
  const hasNumbersFinding = stored.claims.some((claim) =>
    claim.findings.some((finding) => finding.code === 'number_not_observed_in_evidence'),
  );
  if (!hasNumbersFinding) {
    return { kind: 'not_applicable', reason: 'no_numbers_findings' };
  }
  const modelClaims = readStoredModelClaims(document);
  if (modelClaims === null || modelClaims.length === 0) {
    return { kind: 'not_applicable', reason: 'claims_malformed' };
  }

  // The stored basis, re-read: the item the report's snapshot names.
  const sourceItemId = stored.snapshot.sourceItemId;
  const item = await findSourceItemForReevaluation(input.executor, sourceItemId);
  if (item === null) {
    input.logger?.debug('editorial.fact_guard_reevaluation.skipped', {
      draftId: input.draftId,
      reason: 'source_item_missing',
    });
    return { kind: 'skipped', reason: 'source_item_missing' };
  }
  if (item.content_hash !== stored.snapshot.contentHash) {
    input.logger?.debug('editorial.fact_guard_reevaluation.skipped', {
      draftId: input.draftId,
      reason: 'content_hash_mismatch',
    });
    return { kind: 'skipped', reason: 'content_hash_mismatch' };
  }
  // The excerpt is rebuilt from the item's OWN stored fields with the
  // mapper's own composition — the same function the original build
  // used, so a matching item yields the identical excerpt text.
  const excerpt = buildTraceableExcerpt({ title: item.title, body_excerpt: item.body_excerpt });
  if (excerpt.truncated !== stored.evidence.excerptTruncated) {
    input.logger?.debug('editorial.fact_guard_reevaluation.skipped', {
      draftId: input.draftId,
      reason: 'excerpt_truncated_mismatch',
    });
    return { kind: 'skipped', reason: 'excerpt_truncated_mismatch' };
  }

  const rebuilt = buildFactGuardReport({
    snapshot: { sourceItemId: item.id, contentHash: item.content_hash },
    evidence: {
      evidenceId: item.id,
      excerptText: excerpt.text,
      excerptTruncated: excerpt.truncated,
    },
    draftClaims: modelClaims.map((claim) => ({
      text: claim.text,
      evidenceIds: claim.evidenceIds,
    })),
    draftHeadlineFa: typeof document['headlineFa'] === 'string' ? document['headlineFa'] : '',
    draftSummaryFa: typeof document['summaryFa'] === 'string' ? document['summaryFa'] : '',
    draftSourceItemId: item.id,
  });
  // The rebuilt report must read back as a valid v1 report — a rebuild
  // that cannot validate is never stored.
  if (readFactGuardReport({ factGuard: rebuilt }).kind !== 'fact_guard_v1') {
    input.logger?.debug('editorial.fact_guard_reevaluation.skipped', {
      draftId: input.draftId,
      reason: 'rebuilt_report_invalid',
    });
    return { kind: 'skipped', reason: 'rebuilt_report_invalid' };
  }
  if (JSON.stringify(rebuilt) === JSON.stringify(stored)) {
    return { kind: 'unchanged' };
  }

  const nextDocumentJson = JSON.stringify({ ...document, factGuard: rebuilt });
  const replaced = await replaceDraftFactGuardReport(input.executor, {
    draftId: input.draftId,
    expectedDocumentJson: input.documentJson,
    documentJson: nextDocumentJson,
    nowMs: input.nowMs,
  });
  if (!replaced) {
    // Another writer moved the document first — NOTHING was applied by
    // us; the next pass re-reads the new bytes.
    return { kind: 'concurrent_change' };
  }
  await insertFactGuardReevaluationAudit(input.executor, {
    draftId: input.draftId,
    nowMs: input.nowMs,
    metadata: {
      factGuardVersion: FACT_GUARD_VERSION,
      claimsRequiringReviewBefore: stored.counts.claimsRequiringReview,
      claimsRequiringReviewAfter: rebuilt.counts.claimsRequiringReview,
      snapshotSourceItemId: sourceItemId,
    },
  });
  input.logger?.debug('editorial.fact_guard_reevaluation.updated', {
    draftId: input.draftId,
    claimsRequiringReviewBefore: stored.counts.claimsRequiringReview,
    claimsRequiringReviewAfter: rebuilt.counts.claimsRequiringReview,
  });
  return {
    kind: 'updated',
    documentJson: nextDocumentJson,
    cleared: rebuilt.counts.claimsRequiringReview === 0,
    claimsRequiringReviewBefore: stored.counts.claimsRequiringReview,
    claimsRequiringReviewAfter: rebuilt.counts.claimsRequiringReview,
  };
}
