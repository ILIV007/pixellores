import { describe, expect, it } from 'vitest';
import { evaluateAutoPublishGate } from '../../src/domain/publishing/auto-gate';
import {
  buildFactGuardReport,
  FACT_GUARD_LIMITATIONS,
  FACT_GUARD_VERSION,
} from '../../src/domain/editorial/fact-guard';

/**
 * The AUTO-publish candidate gate (plan slice 3, `ag1`) — the PURE verdict
 * matrix over a stored editorial draft's OWN data. The gate decides whether
 * a ready draft may ride AUTOMATED publishing (the final AUTO stage's
 * per-candidate decision) from MEASURABLE data only, never prose:
 *
 *  - the stored document re-read through the SAME strict reader discipline
 *    the send path uses (a stored shape the renderer refuses can never be
 *    AUTO-approved — a doomed publication is never created quietly);
 *  - the fact-guard report MUST be present, well-formed, version-supported
 *    and evaluated over a CONSISTENT snapshot identity (its absence is the
 *    fail-closed refusal — no measurable basis, never a pass);
 *  - the report must be TOTAL over the document's own model claims;
 *  - ANY non-benign finding (reviewRequired=true) on ANY claim ⇒ the human
 *    review path (the machine never publishes a claim it cannot ground);
 *  - zero findings on every claim ⇒ eligible_auto with the report's own
 *    limitation labels carried verbatim (the honesty is IN the verdict —
 *    "do not equate references alone with semantic proof").
 *
 * The gate NEVER reads the database, calls a provider, publishes anything
 * or mints an approval: it is a TOTAL pure function over the stored bytes.
 */

/** The mapper-shaped document (schemaVersion 1, unverified claims). */
function docWithClaims(
  claims: readonly { text: string; evidenceIds: readonly string[] }[],
  factGuard: unknown = undefined,
  overrides: Record<string, unknown> = {},
): string {
  const document: Record<string, unknown> = {
    schemaVersion: 1,
    headlineFa: 'تیتر آزمون گیت',
    summaryFa: 'خلاصهٔ آزمون گیت برای خوانندهٔ فارسی‌زبان.',
    modelClaims: claims.map((claim) => ({
      text: claim.text,
      evidenceIds: [...claim.evidenceIds],
      claimType: 'source_report',
      status: 'unverified',
    })),
    ...(factGuard !== undefined ? { factGuard } : {}),
    ...overrides,
  };
  return JSON.stringify(document);
}

/** A clean report (zero findings, zero review) for the given claim count.
 *  The identity gate binds evidenceId === snapshot.sourceItemId ===
 *  draftSourceItemId — the ONE snapshot every side must name. */
const FIXTURE_ITEM_ID = 'src-item-1';

function cleanReport(claimCount: number): unknown {
  const draftClaims = Array.from({ length: claimCount }, (_unused, index) => ({
    text: `ادعای آزمون ${index} بر پایهٔ شواهد ثبت‌شده ارائه شد.`,
    evidenceIds: [FIXTURE_ITEM_ID],
  }));
  return buildFactGuardReport({
    snapshot: { sourceItemId: FIXTURE_ITEM_ID, contentHash: 'a'.repeat(64) },
    evidence: {
      evidenceId: FIXTURE_ITEM_ID,
      excerptText: draftClaims.map((claim) => claim.text).join(' '),
      excerptTruncated: false,
    },
    draftClaims,
    draftHeadlineFa: 'تیتر آزمون گیت',
    draftSummaryFa: 'خلاصهٔ آزمون گیت.',
    draftSourceItemId: FIXTURE_ITEM_ID,
  });
}

/** A report with ONE review-required finding on the given claim index. */
function reportWithNumberFinding(claimCount: number, targetIndex: number): unknown {
  const draftClaims = Array.from({ length: claimCount }, (_unused, index) => ({
    text: `ادعای آزمون ${index} بر پایهٔ شواهد ثبت‌شده ارائه شد.`,
    evidenceIds: [FIXTURE_ITEM_ID],
  }));
  draftClaims[targetIndex] = {
    ...draftClaims[targetIndex],
    text: `ادعای آزمون ${targetIndex} دقیقا ۱۲۰ هزار کاربر دارد.`,
    evidenceIds: [FIXTURE_ITEM_ID],
  };
  // The target claim's number is NOT in the excerpt (the excerpt keeps the
  // grounded versions) — the numbers lens must flag it review-required.
  const grounded = draftClaims
    .filter((_claim, index) => index !== targetIndex)
    .map((claim) => claim.text)
    .join(' ');
  const excerptText = grounded.length > 0 ? grounded : 'متن شاهد بدون هیچ عددی.';
  return buildFactGuardReport({
    snapshot: { sourceItemId: FIXTURE_ITEM_ID, contentHash: 'a'.repeat(64) },
    evidence: { evidenceId: FIXTURE_ITEM_ID, excerptText, excerptTruncated: false },
    draftClaims,
    draftHeadlineFa: 'تیتر آزمون گیت',
    draftSummaryFa: 'خلاصهٔ آزمون گیت.',
    draftSourceItemId: FIXTURE_ITEM_ID,
  });
}

const GROUNDED_CLAIM_A: { readonly text: string; readonly evidenceIds: readonly string[] } = {
  text: 'ادعای آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.',
  evidenceIds: ['ev-0'],
};
const ONE_GROUNDED_CLAIM: readonly {
  readonly text: string;
  readonly evidenceIds: readonly string[];
}[] = [GROUNDED_CLAIM_A];

describe('auto-gate ag1 — the fail-closed refusal family', () => {
  it('refuses report_absent when the factGuard key was never written (flag-off shape)', () => {
    const verdict = evaluateAutoPublishGate(docWithClaims(ONE_GROUNDED_CLAIM));
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('report_absent');
    }
  });

  it('refuses report_malformed when the stored report is not a well-formed v1 report', () => {
    // A v1-CLAIMING payload that violates the v1 shape (missing every
    // required field) — not a version drift, a malformed report.
    const verdict = evaluateAutoPublishGate(
      docWithClaims(ONE_GROUNDED_CLAIM, { factGuardVersion: 1 }),
    );
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('report_malformed');
    }
  });

  it('refuses report_version_unsupported on a non-v1 factGuardVersion', () => {
    const report = cleanReport(1) as { factGuardVersion: number };
    const verdict = evaluateAutoPublishGate(
      docWithClaims(ONE_GROUNDED_CLAIM, { ...report, factGuardVersion: 99 }),
    );
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('report_version_unsupported');
    }
  });

  it('refuses snapshot_identity_invalid when the evaluation could not bind the snapshot', () => {
    const report = cleanReport(1) as { evaluationStatus: string };
    const verdict = evaluateAutoPublishGate(
      docWithClaims(ONE_GROUNDED_CLAIM, {
        ...report,
        evaluationStatus: 'invalid_snapshot_identity',
      }),
    );
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('snapshot_identity_invalid');
    }
  });

  it('refuses no_claims on a schema-valid document with zero model claims', () => {
    const report = cleanReport(0);
    const verdict = evaluateAutoPublishGate(docWithClaims([], report, { modelClaims: [] }));
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('no_claims');
    }
  });

  it('refuses report_claims_incomplete when the report does not cover every claim index', () => {
    // 2 stored claims, the report only evaluated claim 0.
    const twoClaims = [
      GROUNDED_CLAIM_A,
      { text: 'ادعای دوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-1'] },
    ];
    const verdict = evaluateAutoPublishGate(docWithClaims(twoClaims, cleanReport(1)));
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('report_claims_incomplete');
    }
  });

  it('refuses document_unreadable on unparseable stored bytes', () => {
    const verdict = evaluateAutoPublishGate('not-json-at-all{{{');
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('document_unreadable');
    }
  });

  it('does NOT refuse on a non-unverified claim status anymore (ADR-0071): the render accepts the claim on its text alone, and the fact-guard report decides', () => {
    // ADR-0071 (owner order 2026-11-22): the claim `status` is no longer
    // a render contract — the unverified line is gone from posts and the
    // internal gate is the fact-guard report, not the status field. With
    // a clean report over the same claims, the gate reaches eligible_auto.
    // ADR-0079 §3.7a: the document needs 3 claims now (the substance
    // minimum) — one thin claim no longer reaches eligible_auto.
    const document: Record<string, unknown> = {
      schemaVersion: 1,
      headlineFa: 'تیتر آزمون گیت',
      summaryFa: 'خلاصهٔ آزمون گیت.',
      modelClaims: [
        {
          text: 'ادعای آزمون 0 بر پایهٔ شواهد ثبت‌شده ارائه شد.',
          evidenceIds: ['ev-0'],
          claimType: 'source_report',
          status: 'confirmed',
        },
        {
          text: 'ادعای آزمون 1 بر پایهٔ شواهد ثبت‌شده ارائه شد.',
          evidenceIds: ['ev-1'],
          claimType: 'source_report',
          status: 'unverified',
        },
        {
          text: 'ادعای آزمون 2 بر پایهٔ شواهد ثبت‌شده ارائه شد.',
          evidenceIds: ['ev-2'],
          claimType: 'source_report',
          status: 'unverified',
        },
      ],
      factGuard: cleanReport(3),
    };
    const verdict = evaluateAutoPublishGate(JSON.stringify(document));
    expect(verdict.kind).toBe('eligible_auto');
  });

  it('refuses composition_not_sendable when the strict composition exceeds the send caps', () => {
    const document: Record<string, unknown> = {
      schemaVersion: 1,
      headlineFa: 'ت'.repeat(5000),
      summaryFa: 'خلاصهٔ آزمون گیت.',
      modelClaims: [
        {
          text: 'ادعای آزمون.',
          evidenceIds: ['ev-0'],
          claimType: 'source_report',
          status: 'unverified',
        },
      ],
      factGuard: cleanReport(1),
    };
    const verdict = evaluateAutoPublishGate(JSON.stringify(document));
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('composition_not_sendable');
    }
  });
});

describe('auto-gate ag1 — the measurable review family', () => {
  it('requires_review with the per-claim finding codes when ANY claim is ungrounded', () => {
    const verdict = evaluateAutoPublishGate(
      docWithClaims(ONE_GROUNDED_CLAIM, reportWithNumberFinding(1, 0)),
    );
    expect(verdict.kind).toBe('requires_review');
    if (verdict.kind === 'requires_review') {
      expect(verdict.claims).toHaveLength(1);
      expect(verdict.claims[0]?.claimIndex).toBe(0);
      expect(verdict.claims[0]?.findings).toContain('number_not_observed_in_evidence');
    }
  });

  it('requires_review isolates the offending claim and never flags the grounded ones', () => {
    const twoClaims = [
      GROUNDED_CLAIM_A,
      { text: 'ادعای دوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-1'] },
    ];
    const verdict = evaluateAutoPublishGate(
      docWithClaims(twoClaims, reportWithNumberFinding(2, 1)),
    );
    expect(verdict.kind).toBe('requires_review');
    if (verdict.kind === 'requires_review') {
      expect(verdict.claims).toHaveLength(1);
      expect(verdict.claims[0]?.claimIndex).toBe(1);
    }
  });

  it('the verdict carries the report limitation labels verbatim (no semantic-proof claim)', () => {
    const verdict = evaluateAutoPublishGate(
      docWithClaims(ONE_GROUNDED_CLAIM, reportWithNumberFinding(1, 0)),
    );
    expect(verdict.kind).toBe('requires_review');
    if (verdict.kind === 'requires_review') {
      expect(verdict.limitationLabels).toEqual(FACT_GUARD_LIMITATIONS);
    }
  });
});

describe('auto-gate ag1 — the eligible family', () => {
  it('eligible_auto on a fully grounded document with a clean TOTAL report', () => {
    // ADR-0079 §3.7a: the substance minimum is 3 claims — the eligible
    // document carries three grounded claims, not one.
    const threeClaims = [
      GROUNDED_CLAIM_A,
      { text: 'ادعای دوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-1'] },
      { text: 'ادعای سوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-2'] },
    ];
    const verdict = evaluateAutoPublishGate(docWithClaims(threeClaims, cleanReport(3)));
    expect(verdict.kind).toBe('eligible_auto');
    if (verdict.kind === 'eligible_auto') {
      expect(verdict.claimCount).toBe(3);
      expect(verdict.factGuardVersion).toBe(FACT_GUARD_VERSION);
      expect(verdict.limitationLabels).toEqual(FACT_GUARD_LIMITATIONS);
    }
  });

  it('eligible_auto over multiple fully grounded claims', () => {
    const threeClaims = [
      GROUNDED_CLAIM_A,
      { text: 'ادعای دوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-1'] },
      { text: 'ادعای سوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-2'] },
    ];
    const verdict = evaluateAutoPublishGate(docWithClaims(threeClaims, cleanReport(3)));
    expect(verdict.kind).toBe('eligible_auto');
    if (verdict.kind === 'eligible_auto') {
      expect(verdict.claimCount).toBe(3);
    }
  });

  it('TOTAL and JSON-equal deterministic: the same bytes always yield the same verdict', () => {
    const bytes = docWithClaims(ONE_GROUNDED_CLAIM, cleanReport(1));
    const first = evaluateAutoPublishGate(bytes);
    const second = evaluateAutoPublishGate(bytes);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('auto-gate ag1 — the substance minimum (ADR-0079 §3.7a)', () => {
  it('a 1-claim draft with a clean report goes to human review (insufficient_claims), never auto-publish', () => {
    const verdict = evaluateAutoPublishGate(docWithClaims(ONE_GROUNDED_CLAIM, cleanReport(1)));
    expect(verdict.kind).toBe('requires_review');
    if (verdict.kind === 'requires_review') {
      expect(verdict.reason).toBe('insufficient_claims');
      expect(verdict.claims).toHaveLength(1);
      expect(verdict.claims[0]).toEqual({ claimIndex: 0, findings: [] });
      expect(verdict.limitationLabels).toEqual(FACT_GUARD_LIMITATIONS);
    }
  });

  it('a 2-claim draft with a clean report goes to human review too', () => {
    const twoClaims = [
      GROUNDED_CLAIM_A,
      { text: 'ادعای دوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-1'] },
    ];
    const verdict = evaluateAutoPublishGate(docWithClaims(twoClaims, cleanReport(2)));
    expect(verdict.kind).toBe('requires_review');
    if (verdict.kind === 'requires_review') {
      expect(verdict.reason).toBe('insufficient_claims');
    }
  });

  it('a 3-claim draft passes the substance rule (other rules unchanged)', () => {
    const threeClaims = [
      GROUNDED_CLAIM_A,
      { text: 'ادعای دوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-1'] },
      { text: 'ادعای سوم آزمون بر پایهٔ شواهد ثبت‌شده ارائه شد.', evidenceIds: ['ev-2'] },
    ];
    const verdict = evaluateAutoPublishGate(docWithClaims(threeClaims, cleanReport(3)));
    expect(verdict.kind).toBe('eligible_auto');
  });

  it('the substance rule sits LAST: a thin draft without a report is still refused (report_absent), not reviewed', () => {
    const verdict = evaluateAutoPublishGate(docWithClaims(ONE_GROUNDED_CLAIM));
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.reason).toBe('report_absent');
    }
  });

  it('the substance rule sits LAST: a thin draft with an ungrounded claim still reports its finding first', () => {
    const verdict = evaluateAutoPublishGate(
      docWithClaims(ONE_GROUNDED_CLAIM, reportWithNumberFinding(1, 0)),
    );
    expect(verdict.kind).toBe('requires_review');
    if (verdict.kind === 'requires_review') {
      expect(verdict.reason).toBe('fact_guard_findings');
    }
  });
});
