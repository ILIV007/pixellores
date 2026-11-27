import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createAiRewriteService } from '../../src/application/ai/rewrite-service';
import { createEditorialRewriteDraftHandler } from '../../src/application/editorial/rewrite-draft-handler';
import { bridgeReadyDrafts } from '../../src/application/publishing/auto-publish-bridge';
import { findDraftById } from '../../src/adapters/db/editorial-store';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import { buildDraftDocument, EDITORIAL_DRAFT_LAYOUT } from '../../src/domain/editorial/mapper';
import { buildEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';
import { buildCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { buildCandidateAssessmentReport } from '../../src/domain/editorial/candidate-assessment';
import { emptyEntityMentionsReport } from '../../src/domain/editorial/entity-mentions';
import { disabledEventRelationReport } from '../../src/domain/editorial/event-relation-decision';
import { tehranBudgetDay, msUntilNextTehranMidnight } from '../../src/shared/time/tehran-day';

/**
 * ADR-0070 — the rewrite stage over REAL workerd D1, with the ONLY
 * artificial piece being the Gemini PORT (zero network, zero live
 * inference):
 *
 *   REAL draft row -> REAL rewrite handler (fenced atomic commit:
 *   rewritten document + news_rewrite ai_runs row, rowcount is the
 *   authority) -> REAL bridge seam (rewriteRequired defers raw drafts,
 *   never bridges failed ones).
 *
 * The honesty boundary pinned here:
 *  - a fenced document update is atomic: a non-ready draft refuses
 *    with ZERO writes, and a second execution of the same job writes
 *    nothing twice (no second rewrite, no second ai_runs row);
 *  - quota_denied defers to the next Tehran midnight WITHOUT
 *    consuming a rewrite attempt (no document write);
 *  - a safety refusal marks the draft rewrite.failed and the bridge
 *    never auto-publishes it.
 */

const NOW = 1_700_000_000_000;
const STORY_ID = 'edst_rewrite_test';
const DRAFT_ID = 'edd_rewrite_test';
const JOB_ID = 'edrw_test_job';
const DESTINATION = '@pixel_channel_rewrite_test';

const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });

const ITEM_ID = 'item-0001';
const HASH = 'a'.repeat(64);

const GUARD_REPORT = buildEvidenceGuardReport({
  snapshot: { sourceItemId: ITEM_ID, contentHash: HASH },
  evidence: { evidenceId: ITEM_ID, excerptText: 'متن شاهد آزمایشی', excerptTruncated: false },
  draftClaims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
  draftHeadlineFa: 'تیتر خام',
  draftSummaryFa: 'خلاصهٔ خام',
  draftSourceItemId: ITEM_ID,
});
const NO_CANDIDATES_REPORT = buildCandidateDiscoveryReport({
  snapshot: { sourceItemId: ITEM_ID, contentHash: HASH },
  storyId: STORY_ID,
  lookups: [],
  matches: [],
});
const NO_CANDIDATES_ASSESSMENT = buildCandidateAssessmentReport({
  discovery: NO_CANDIDATES_REPORT,
});
const NO_MENTIONS_REPORT = emptyEntityMentionsReport({ sourceItemId: ITEM_ID, contentHash: HASH });
const DISABLED_EVENT_RELATION_REPORT = disabledEventRelationReport({
  sourceItemId: ITEM_ID,
  contentHash: HASH,
});

function buildRawDraftJson(): string {
  // The REAL stored shape: the bare inner document, exactly what the
  // prepare-draft handler stores (canonicalizeJson(document.document)).
  return JSON.stringify(
    buildDraftDocument({
      sourceItemId: ITEM_ID,
      sourceName: 'منبع رسمی',
      excerpt: { id: ITEM_ID, text: 'متن شاهد آزمایشی', truncated: false, stance: 'mentions' },
      semanticDraft: {
        headlineFa: 'تیتر خام',
        summaryFa: 'خلاصهٔ خام',
        claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
      },
      evidenceGuard: GUARD_REPORT,
      candidateDiscovery: NO_CANDIDATES_REPORT,
      candidateAssessment: NO_CANDIDATES_ASSESSMENT,
      entityMentions: NO_MENTIONS_REPORT,
      eventRelation: DISABLED_EVENT_RELATION_REPORT,
    }).document,
  );
}

const VALID_REWRITE_JSON = JSON.stringify({
  headlineFa: 'تیتر بازنویسی‌شده',
  summaryFa: 'خلاصهٔ بازنویسی‌شده',
  categoryEmoji: '🔵',
  trustLabel: '#گزارش‌شده',
});

async function freshDb(executor: DbExecutor): Promise<void> {
  await applyMigrations(env.DB);
  for (const table of [
    'publication_messages',
    'publications',
    'audit_events',
    'admin_post_publications',
    'admin_post_approvals',
    'admin_post_preview_sessions',
    'admin_post_versions',
    'admin_post_drafts',
    'admin_action_tokens',
    'settings',
    'souls',
    'telegram_updates',
    'admins',
    'draft_revisions',
    'drafts',
    'ai_runs',
    'evidence',
    'claims',
    'story_fingerprints',
    'stories',
    'source_items',
    'sources',
    'jobs',
    'budgets',
  ]) {
    await executor.run({ sql: `DELETE FROM ${table}` });
  }
}

async function seedStoryAndDraft(
  executor: DbExecutor,
  input: { draftId?: string; status?: string; documentJson?: string } = {},
): Promise<void> {
  const draftId = input.draftId ?? DRAFT_ID;
  const documentJson = input.documentJson ?? buildRawDraftJson();
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type,
            priority, confidence, first_seen_at, last_evidence_at, version, created_at, updated_at)
          VALUES (?, ?, 'draftable', 'reported', 'official_news', 50, 0, ?, ?, 1, ?, ?)`,
    params: [STORY_ID, `story-key-${draftId}`, NOW, NOW, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, ai_run_id, version, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'fa', ?, 'تیتر خام', ?, '[]', '[]', NULL, 1, 'test', ?, ?)`,
    params: [
      draftId,
      STORY_ID,
      input.status ?? 'ready',
      EDITORIAL_DRAFT_LAYOUT,
      documentJson,
      NOW,
      NOW,
    ],
  });
}

async function seedSoulPointer(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES ('soul.current_version', '{"version": 1}', 1, NULL, ?)`,
    params: [NOW],
  });
}

/**
 * The rewrite commit (and the standalone ai_runs record) is fenced on
 * job ownership: a `claimed` jobs row with attempts = generation and a
 * live lease. Without it the fenced batch writes zero rows and the
 * handler honestly retries — so the harness claims the job first,
 * exactly like the engine's atomic claim would.
 */
async function seedClaimedJob(
  executor: DbExecutor,
  jobId: string,
  generation: number,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO jobs (id, type, status, priority, run_after, attempts, max_attempts,
            lease_until, idempotency_key, payload_json, created_at, updated_at)
          VALUES (?, 'editorial.rewrite_draft', 'claimed', 50, ?, ?, 10, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = 'claimed', attempts = excluded.attempts,
            lease_until = excluded.lease_until, updated_at = excluded.updated_at`,
    params: [
      jobId,
      NOW,
      generation,
      NOW + 60_000,
      `test-${jobId}`,
      JSON.stringify({ draftId: DRAFT_ID }),
      NOW,
      NOW,
    ],
  });
}

function createFakeGeminiPort(outcomes: readonly AiCallOutcome[]): AiProviderPort {
  const queue = [...outcomes];
  return {
    provider: 'gemini',
    async complete(input) {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('fake port exhausted its scripted outcomes');
      }
      return next;
    },
  };
}

interface RewriteHarness {
  readonly executor: DbExecutor;
  readonly clock: MutableClock;
  runHandler: (overrides?: {
    portOutcomes?: readonly AiCallOutcome[];
    rewriteEnabled?: boolean;
    jobId?: string;
    generation?: number;
    draftId?: string;
  }) => Promise<{ kind: string; reasonCode?: string; retryAfterMs?: number }>;
  readDraft: () => Promise<{ status: string; documentJson: string; title: string } | null>;
  countAiRuns: (task?: string) => Promise<number>;
}

async function createHarness(): Promise<RewriteHarness> {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(env.DB, { clock });
  await freshDb(executor);
  return {
    executor,
    clock,
    async runHandler(overrides = {}) {
      const jobId = overrides.jobId ?? JOB_ID;
      const generation = overrides.generation ?? 1;
      await seedClaimedJob(executor, jobId, generation);
      const port = createFakeGeminiPort(
        overrides.portOutcomes ?? [{ kind: 'ok', rawText: VALID_REWRITE_JSON }],
      );
      // A manual deadline scheduler that never fires (the slice09
      // pattern): the fake clock sits in 2023 while real time is 2026,
      // so a real setTimeout would see the 60 s wall deadline as
      // already expired and fail every call as skipped_deadline.
      const live = new Set<() => void>();
      const service = createAiRewriteService({
        config: {
          aiEnabled: true,
          geminiEnabled: true,
          rewriteEnabled: true,
          geminiApiKeyPresent: true,
        },
        executor,
        ports: { gemini: port },
        clock,
        logger,
        deadlineScheduler: (callback) => {
          live.add(callback);
          return () => {
            live.delete(callback);
          };
        },
      });
      const handler = createEditorialRewriteDraftHandler({
        executor,
        rewriteService: service,
        rewriteEnabled: overrides.rewriteEnabled ?? true,
        nowMs: () => clock.now(),
        logger,
      });
      const outcome = await handler.execute({
        jobId,
        generation,
        payload: { draftId: overrides.draftId ?? DRAFT_ID },
      });
      return outcome as { kind: string; reasonCode?: string; retryAfterMs?: number };
    },
    async readDraft() {
      const draft = await findDraftById(executor, DRAFT_ID);
      if (draft === null) {
        return null;
      }
      const row = await executor.first<{ title: string }>({
        sql: `SELECT title FROM drafts WHERE id = ?`,
        params: [DRAFT_ID],
      });
      return { status: draft.status, documentJson: draft.document_json, title: row?.title ?? '' };
    },
    async countAiRuns(task = 'news_rewrite') {
      const row = await executor.first<{ n: number }>({
        sql: `SELECT COUNT(*) AS n FROM ai_runs WHERE task = ?`,
        params: [task],
      });
      return row?.n ?? 0;
    },
  };
}

function parseStoredDocument(documentJson: string): Record<string, unknown> {
  return JSON.parse(documentJson) as Record<string, unknown>;
}

describe('rewrite_draft over real D1 (ADR-0070 §4/§5)', () => {
  let harness: RewriteHarness;

  beforeEach(async () => {
    harness = await createHarness();
    await seedStoryAndDraft(harness.executor);
  });

  it('rewrites a ready draft: fenced document + news_rewrite ai_runs row', async () => {
    const outcome = await harness.runHandler();
    expect(outcome.kind).toBe('success');

    const draft = await harness.readDraft();
    expect(draft?.status).toBe('ready');
    expect(draft?.title).toBe('تیتر بازنویسی‌شده');
    const document = parseStoredDocument(draft?.documentJson ?? '');
    expect(document['headlineFa']).toBe('تیتر بازنویسی‌شده');
    expect(document['summaryFa']).toBe('خلاصهٔ بازنویسی‌شده');
    expect(document['rawHeadlineFa']).toBe('تیتر خام');
    expect(document['rawSummaryFa']).toBe('خلاصهٔ خام');
    expect(document['soulForm']).toEqual({ categoryEmoji: '🔵', trustLabel: '#گزارش‌شده' });
    const rewrite = document['rewrite'] as Record<string, unknown>;
    expect(rewrite['status']).toBe('rewritten');
    expect(rewrite['model']).toBe('gemini-3.5-flash-lite');
    expect(rewrite['promptVersion']).toBe('pixel-news-rewrite-v1');
    expect(rewrite['soulVersion']).toBe('v1');
    expect(rewrite['attempts']).toBe(1);
    // Claims are untouched: the rewrite re-voices, it never re-extracts.
    const claims = document['modelClaims'] as readonly { text: string }[];
    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).toBe('ادعای مدل');

    expect(await harness.countAiRuns('news_rewrite')).toBe(1);
    const run = await harness.executor.first<{
      status: string;
      model: string;
      prompt_version: string;
      error_code: string | null;
    }>({
      sql: `SELECT status, model, prompt_version, error_code FROM ai_runs WHERE task = 'news_rewrite'`,
    });
    expect(run?.status).toBe('succeeded');
    expect(run?.model).toBe('gemini-3.5-flash-lite');
    expect(run?.prompt_version).toBe('pixel-news-rewrite-v1');
    expect(run?.error_code).toBeNull();
  });

  it('a second execution writes nothing twice (idempotent retry)', async () => {
    expect((await harness.runHandler()).kind).toBe('success');
    const afterFirst = await harness.readDraft();
    expect((await harness.runHandler({ generation: 2 })).kind).toBe('success');
    const afterSecond = await harness.readDraft();
    expect(afterSecond?.documentJson).toBe(afterFirst?.documentJson);
    expect(afterSecond?.title).toBe(afterFirst?.title);
    expect(await harness.countAiRuns('news_rewrite')).toBe(1);
  });

  it('a non-ready draft refuses with zero writes', async () => {
    await harness.executor.run({
      sql: `UPDATE drafts SET status = 'auto_approved' WHERE id = ?`,
      params: [DRAFT_ID],
    });
    const outcome = await harness.runHandler();
    expect(outcome.kind).toBe('success');
    const draft = await harness.readDraft();
    expect(draft?.status).toBe('auto_approved');
    expect(draft?.documentJson).toBe(buildRawDraftJson());
    expect(await harness.countAiRuns('news_rewrite')).toBe(0);
  });

  it('a missing draft is permanent, with zero provider calls', async () => {
    const outcome = await harness.runHandler({
      draftId: 'edd_does_not_exist',
      portOutcomes: [{ kind: 'ok', rawText: VALID_REWRITE_JSON }],
    });
    expect(outcome.kind).toBe('permanent');
    expect(outcome.reasonCode).toBe('editorial_rewrite_draft_missing');
    expect(await harness.countAiRuns('news_rewrite')).toBe(0);
  });

  it('an unparsable document is permanent, with zero provider calls', async () => {
    await harness.executor.run({
      sql: `UPDATE drafts SET document_json = ? WHERE id = ?`,
      params: ['{not json', DRAFT_ID],
    });
    const outcome = await harness.runHandler();
    expect(outcome.kind).toBe('permanent');
    expect(outcome.reasonCode).toBe('editorial_rewrite_document_invalid');
    expect(await harness.countAiRuns('news_rewrite')).toBe(0);
  });

  it('flag off at execution does zero work', async () => {
    const outcome = await harness.runHandler({ rewriteEnabled: false });
    expect(outcome.kind).toBe('success');
    const draft = await harness.readDraft();
    expect(draft?.documentJson).toBe(buildRawDraftJson());
    expect(await harness.countAiRuns('news_rewrite')).toBe(0);
  });

  it('quota_denied defers to the next Tehran midnight without consuming an attempt', async () => {
    await harness.executor.run({
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens,
              output_tokens, bytes_transferred, updated_at)
            VALUES ('ai', 'gemini', ?, 40, 0, 0, 0, ?)`,
      params: [tehranBudgetDay(NOW), NOW],
    });
    const outcome = await harness.runHandler();
    expect(outcome.kind).toBe('retry');
    expect(outcome.retryAfterMs).toBe(msUntilNextTehranMidnight(NOW));
    // NO document write: the spent count does not move.
    const draft = await harness.readDraft();
    expect(draft?.documentJson).toBe(buildRawDraftJson());
    expect(draft?.title).toBe('تیتر خام');
    // The denial IS observed: one failed news_rewrite row.
    expect(await harness.countAiRuns('news_rewrite')).toBe(1);
    const run = await harness.executor.first<{ status: string; error_code: string }>({
      sql: `SELECT status, error_code FROM ai_runs WHERE task = 'news_rewrite'`,
    });
    expect(run?.status).toBe('failed');
    expect(run?.error_code).toBe('budget_denied');
  });

  it('a safety refusal marks the draft failed and the bridge never bridges it', async () => {
    const outcome = await harness.runHandler({ portOutcomes: [{ kind: 'refused' }] });
    expect(outcome.kind).toBe('success');
    const draft = await harness.readDraft();
    const document = parseStoredDocument(draft?.documentJson ?? '');
    const rewrite = document['rewrite'] as Record<string, unknown>;
    expect(rewrite['status']).toBe('failed');
    expect(rewrite['reason']).toBe('provider_safety_refusal');
    expect(document['headlineFa']).toBe('تیتر خام'); // failed: raw text untouched

    await seedSoulPointer(harness.executor);
    const report = await bridgeReadyDrafts({
      executor: harness.executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      rewriteRequired: true,
      logger,
    });
    expect(report.kind).toBe('bridged');
    if (report.kind === 'bridged') {
      expect(report.failedRewrite).toBe(1);
      expect(report.deferredRewrite).toBe(0);
      expect(report.enqueued).toBe(0);
    }
    expect((await harness.readDraft())?.status).toBe('ready');
  });
});

describe('bridge rewrite seam over real D1 (ADR-0070 §4)', () => {
  let harness: RewriteHarness;

  beforeEach(async () => {
    harness = await createHarness();
    await seedStoryAndDraft(harness.executor);
    await seedSoulPointer(harness.executor);
  });

  async function bridge(): Promise<{ deferredRewrite: number; failedRewrite: number }> {
    const report = await bridgeReadyDrafts({
      executor: harness.executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      rewriteRequired: true,
      logger,
    });
    expect(report.kind).toBe('bridged');
    if (report.kind !== 'bridged') {
      return { deferredRewrite: -1, failedRewrite: -1 };
    }
    return { deferredRewrite: report.deferredRewrite, failedRewrite: report.failedRewrite };
  }

  it('defers an un-rewritten draft and leaves it ready', async () => {
    const counts = await bridge();
    expect(counts.deferredRewrite).toBe(1);
    expect(counts.failedRewrite).toBe(0);
    expect((await harness.readDraft())?.status).toBe('ready');
  });

  it('a rewritten draft passes the seam (no longer deferred)', async () => {
    expect((await harness.runHandler()).kind).toBe('success');
    const counts = await bridge();
    expect(counts.deferredRewrite).toBe(0);
    expect(counts.failedRewrite).toBe(0);
  });

  it('flag off behaves exactly as today: the raw draft is not deferred', async () => {
    const report = await bridgeReadyDrafts({
      executor: harness.executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger,
    });
    expect(report.kind).toBe('bridged');
    if (report.kind === 'bridged') {
      expect(report.deferredRewrite).toBe(0);
      expect(report.failedRewrite).toBe(0);
    }
  });
});
