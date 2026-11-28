import { describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryMeta, DbRows } from '../../src/adapters/db/db-executor';
import {
  reevaluateDraftFactGuard,
  type FactGuardReevaluationOutcome,
} from '../../src/application/editorial/fact-guard-reevaluation';
import { readFactGuardReport } from '../../src/domain/editorial/fact-guard';

/**
 * ADR-0082 — the flag-off backfill over INJECTED FAKES: a draft whose
 * report was never written gets one BUILT from its own stored claims +
 * the stored source item (same builder/validation/CAS/audit as the
 * numbers path), never `not_applicable`. Fully offline; no native
 * binding, no network, no real D1. The bridge trigger (a `refused` /
 * `report_absent` verdict reaching this service) is covered by
 * tests/integration/fact-guard-backfill.test.ts over real workerd D1.
 */

const NOW = 1_796_000_000_000;
const ITEM_ID = '2d09ebcc-b246-4410-806a-077798b8ed73';

const ITEM = {
  id: ITEM_ID,
  title: 'Goodbye Seoul launches in early 2027',
  body_excerpt:
    'Pixel narrative puzzle adventure game Goodbye Seoul will launch for PC via Steam in early …',
  content_hash: '0daaabef9230c3d0e966356b0823275198761c206ee147f3fcf21b51ab07df9b',
};

/** A flag-off stored document: claims + sourceReport, NO factGuard key. */
function absentDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    locale: 'fa',
    headlineFa: 'Goodbye Seoul در اوایل ۲۰۲۷ منتشر می‌شود',
    summaryFa: 'بازی پازل روایی Goodbye Seoul برای PC عرضه می‌شود.',
    sourceReport: {
      sourceItemId: ITEM_ID,
      sourceName: 'Gematsu',
      stance: 'mentions',
      excerptText:
        'Goodbye Seoul launches in early 2027\n\nPixel narrative puzzle adventure game Goodbye Seoul will launch for PC via Steam in early …',
      truncated: false,
    },
    evidenceGuard: {
      snapshot: { sourceItemId: ITEM_ID, contentHash: ITEM.content_hash },
    },
    modelClaims: [
      {
        text: 'بازی Goodbye Seoul در اوایل سال ۲۰۲۷ منتشر می‌شود.',
        evidenceIds: [ITEM_ID],
        status: 'unverified',
      },
      {
        text: 'این بازی یک اثر ماجراجویی، پازل و روایی با گرافیک پیکسلی است که برای رایانه‌های شخصی (PC) از طریق استیم عرضه می‌شود.',
        evidenceIds: [ITEM_ID],
        status: 'unverified',
      },
    ],
    ...overrides,
  });
}

interface FakeState {
  /** The item row `first()` returns for the source_items lookup. */
  itemRow: typeof ITEM | null;
  /** CAS write succeeds (changes 1) when true, loses the race when false. */
  casWins: boolean;
  readonly runCalls: { sql: string; params: readonly unknown[] }[];
}

function createFakeExecutor(state: FakeState): DbExecutor {
  return {
    async query<T>(): Promise<DbRows<T>> {
      return { rows: [] as T[], meta: { durationMs: 0, changes: 0 } };
    },
    async first<T>(statement: { sql: string }): Promise<T | null> {
      if (statement.sql.includes('FROM source_items')) {
        return (state.itemRow ?? null) as unknown as T | null;
      }
      return null;
    },
    async run(statement: { sql: string; params?: readonly unknown[] }): Promise<DbQueryMeta> {
      state.runCalls.push({ sql: statement.sql, params: statement.params ?? [] });
      const isCas = statement.sql.includes('UPDATE drafts SET document_json');
      return { durationMs: 0, changes: isCas && !state.casWins ? 0 : 1 };
    },
    async batch(): Promise<readonly DbQueryMeta[]> {
      return [];
    },
  };
}

async function run(state: FakeState, documentJson: string): Promise<FactGuardReevaluationOutcome> {
  return reevaluateDraftFactGuard({
    executor: createFakeExecutor(state),
    draftId: 'draft-backfill',
    documentJson,
    nowMs: NOW,
  });
}

describe('ADR-0082 — fact-guard backfill from absent', () => {
  it('builds, validates and stores the report; the claims are untouched', async () => {
    const state: FakeState = { itemRow: ITEM, casWins: true, runCalls: [] };
    const outcome = await run(state, absentDocument());
    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') throw new Error('expected updated');
    expect(outcome.cleared).toBe(true);
    expect(outcome.claimsRequiringReviewBefore).toBe(0);
    expect(outcome.claimsRequiringReviewAfter).toBe(0);

    const stored = JSON.parse(outcome.documentJson) as Record<string, unknown>;
    const read = readFactGuardReport(stored);
    expect(read.kind).toBe('fact_guard_v1');
    if (read.kind !== 'fact_guard_v1') throw new Error('expected a v1 report');
    expect(read.report.snapshot.sourceItemId).toBe(ITEM_ID);
    expect(read.report.snapshot.contentHash).toBe(ITEM.content_hash);
    // The claims themselves are untouched — only the derived report moved.
    expect(stored['modelClaims']).toEqual(JSON.parse(absentDocument())['modelClaims']);

    const cas = state.runCalls.find((call) => call.sql.includes('UPDATE drafts SET document_json'));
    expect(cas).toBeDefined();
    expect(cas?.params[0]).toBe(outcome.documentJson);
    expect(cas?.params[2]).toBe('draft-backfill');
    const audit = state.runCalls.find((call) => call.sql.includes('INTO audit_events'));
    expect(audit).toBeDefined();
    expect(audit?.params[0]).toBe(`fact-guard-reeval:draft-backfill:${NOW}`);
  });

  it('malformed claims stay not_applicable and write nothing', async () => {
    const state: FakeState = { itemRow: ITEM, casWins: true, runCalls: [] };
    const outcome = await run(
      state,
      absentDocument({ modelClaims: [{ text: 42, evidenceIds: [ITEM_ID] }] }),
    );
    expect(outcome).toEqual({ kind: 'not_applicable', reason: 'claims_malformed' });
    expect(state.runCalls).toHaveLength(0);
  });

  it('an empty claims list stays not_applicable and writes nothing', async () => {
    const state: FakeState = { itemRow: ITEM, casWins: true, runCalls: [] };
    const outcome = await run(state, absentDocument({ modelClaims: [] }));
    expect(outcome).toEqual({ kind: 'not_applicable', reason: 'claims_malformed' });
    expect(state.runCalls).toHaveLength(0);
  });

  it('a missing source item is skipped and writes nothing', async () => {
    const state: FakeState = { itemRow: null, casWins: true, runCalls: [] };
    const outcome = await run(state, absentDocument());
    expect(outcome).toEqual({ kind: 'skipped', reason: 'source_item_missing' });
    expect(state.runCalls).toHaveLength(0);
  });

  it('a document naming no item is not_applicable and writes nothing', async () => {
    const state: FakeState = { itemRow: ITEM, casWins: true, runCalls: [] };
    const document = JSON.parse(absentDocument()) as Record<string, unknown>;
    delete document['sourceReport'];
    const outcome = await run(state, JSON.stringify(document));
    expect(outcome).toEqual({ kind: 'not_applicable', reason: 'source_item_unresolvable' });
    expect(state.runCalls).toHaveLength(0);
  });

  it('a document whose own records disagree names no item', async () => {
    const state: FakeState = { itemRow: ITEM, casWins: true, runCalls: [] };
    const outcome = await run(
      state,
      absentDocument({
        evidenceGuard: { snapshot: { sourceItemId: 'some-other-item', contentHash: 'x' } },
      }),
    );
    expect(outcome).toEqual({ kind: 'not_applicable', reason: 'source_item_unresolvable' });
    expect(state.runCalls).toHaveLength(0);
  });

  it('a lost CAS race reports concurrent_change and writes no audit row', async () => {
    const state: FakeState = { itemRow: ITEM, casWins: false, runCalls: [] };
    const outcome = await run(state, absentDocument());
    expect(outcome).toEqual({ kind: 'concurrent_change' });
    expect(state.runCalls).toHaveLength(1);
    expect(state.runCalls[0]?.sql).toContain('UPDATE drafts SET document_json');
  });
});
