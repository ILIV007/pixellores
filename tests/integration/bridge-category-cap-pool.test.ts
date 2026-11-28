import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { bridgeReadyDrafts } from '../../src/application/publishing/auto-publish-bridge';
import { buildFactGuardReport } from '../../src/domain/editorial/fact-guard';
import { createLogger } from '../../src/observability/logger';

/**
 * ADR-0076 — the category cap's single-category-pool exemption.
 *
 * The live Nov-27 stall: a 2-post `mainstream_industry` published
 * trail plus an all-`industry` ready queue. The 40%-of-rolling-six
 * cap deferred every draft on every pass (`deferredCategoryCap: 5`,
 * confirmed in the worker logs at 02:30/02:35 Tehran) — and the
 * trail could never dilute, because no publication could ever
 * happen. The cap is a MIX-SHAPING rule: it defers the
 * over-represented category so ANOTHER category can take its place.
 * When the pool holds no alternative there is no mix to shape, so
 * the cap admits the candidate — at the bridge AND at the scheduler
 * backstop (both thread the same pool fact).
 *
 * The eligible documents are built with the REAL fact-guard builder
 * (one number-free claim witnessed verbatim in the excerpt), so the
 * gate passes and ONLY the cap decides.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15. */
const NOW = 1_700_029_800_000;
const DESTINATION = '@pixel_channel_bridge_cap_pool';
const CLAIM_TEXTS = [
  'استودیو بازی تازه را معرفی کرد',
  'جزئیات بیشتری منتشر شد',
  'بخش داستانی تازه هم معرفی شد',
];
const EXCERPT =
  'استودیو بازی تازه را معرفی کرد و جزئیات بیشتری منتشر شد؛ بخش داستانی تازه هم معرفی شد.';

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

function eligibleDocument(itemId: string, contentHash: string): string {
  // ADR-0079 §3.7a: the substance gate needs ≥3 grounded claims, so
  // the eligible document carries three — each witnessed verbatim in
  // the excerpt — and ONLY the cap decides.
  const report = buildFactGuardReport({
    snapshot: { sourceItemId: itemId, contentHash },
    evidence: { evidenceId: itemId, excerptText: EXCERPT, excerptTruncated: false },
    draftClaims: CLAIM_TEXTS.map((text) => ({ text, evidenceIds: [itemId] })),
    draftHeadlineFa: 'تیتر خبر گیمینگ',
    draftSummaryFa: 'خلاصهٔ خبر',
    draftSourceItemId: itemId,
  });
  return JSON.stringify({
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر',
    modelClaims: CLAIM_TEXTS.map((text) => ({ text, status: 'unverified' })),
    factGuard: report,
  });
}

async function seedSoulPointer(): Promise<void> {
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES ('soul.current_version', '{"version": 1}', 1, NULL, ?)`,
    params: [NOW],
  });
}

async function seedReadyDraft(input: {
  readonly storyId: string;
  readonly draftId: string;
  readonly itemId: string;
  readonly articleUrl: string;
  readonly contentType?: string;
  readonly createdAt: number;
}): Promise<void> {
  const contentHash = `hash-${input.itemId}`;
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', ?, 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [
      input.storyId,
      `key-${input.storyId}`,
      input.contentType ?? 'industry',
      NOW,
      NOW,
      NOW,
      NOW,
    ],
  });
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, 'src-bridge', ?, ?, 'Bridge item', ?, NULL, ?, ?, ?, '{}', 'processed')`,
    params: [input.itemId, `ext-${input.itemId}`, input.articleUrl, EXCERPT, NOW, NOW, contentHash],
  });
  await executor.run({
    sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
            normalized_value, confidence, status, created_at, updated_at)
          VALUES (?, ?, 'source_report', 'game', 'announced', 'a game', NULL, 80, 'supported', ?, ?)`,
    params: [`claim-${input.itemId}`, input.storyId, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
          VALUES (?, ?, ?, 'supports', 80, NULL, ?)`,
    params: [`ev-${input.itemId}`, `claim-${input.itemId}`, input.itemId, NOW],
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'ready', 'fa', 'standard', 'تیتر خبر گیمینگ', ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [
      input.draftId,
      input.storyId,
      eligibleDocument(input.itemId, contentHash),
      input.createdAt,
      input.createdAt,
    ],
  });
}

async function seedPublished(input: {
  readonly pubId: string;
  readonly storyId: string;
  readonly draftId: string;
  readonly publishedAtMs: number;
}): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'published', 'official', 'industry', 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [input.storyId, `key-${input.storyId}`, NOW, NOW, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'approved', 'fa', 'standard', 'تیتر خبر گیمینگ', '{}', '[]', '[]', 1, 'test', ?, ?)`,
    params: [input.draftId, input.storyId, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
            scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
            max_attempts, idempotency_key, last_error, created_at, updated_at, soul_version)
          VALUES (?, ?, ?, 'published', 80, 'auto', NULL, ?, NULL, NULL, ?, 1, 3, ?, NULL, ?, ?, 1)`,
    params: [
      input.pubId,
      input.storyId,
      input.draftId,
      NOW,
      input.publishedAtMs,
      `key-${input.pubId}`,
      NOW,
      NOW,
    ],
  });
}

async function listDraftStatuses(): Promise<readonly { id: string; status: string }[]> {
  const rows = await executor.query<{ id: string; status: string }>({
    sql: 'SELECT id, status FROM drafts ORDER BY created_at ASC, id ASC',
  });
  return rows.rows;
}

async function listPublicationPriorities(): Promise<readonly number[]> {
  const rows = await executor.query<{ priority: number }>({
    sql: 'SELECT priority FROM publications ORDER BY created_at ASC, id ASC',
  });
  return rows.rows.map((row) => row.priority);
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  for (const table of [
    'publication_messages',
    'publications',
    'audit_events',
    'draft_gate_evaluations',
    'drafts',
    'evidence',
    'claims',
    'stories',
    'source_items',
    'sources',
    'settings',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES ('src-bridge', 'Bridge Source', 'rss', 'editorial', 30, 1, 3600, 50, 100, 'threshold', '{}', ?, ?)`,
    params: [NOW, NOW],
  });
  await seedSoulPointer();
});

describe('bridge category cap — single-category pool (ADR-0076)', () => {
  it('bridges the whole front five when the trail holds two and the pool holds nothing else (the live Nov-27 stall)', async () => {
    await seedPublished({
      pubId: 'pub-h1',
      storyId: 's-h1',
      draftId: 'd-h1',
      publishedAtMs: NOW - 2 * 3_600_000,
    });
    await seedPublished({
      pubId: 'pub-h2',
      storyId: 's-h2',
      draftId: 'd-h2',
      publishedAtMs: NOW - 1 * 3_600_000,
    });
    for (let index = 0; index < 5; index += 1) {
      await seedReadyDraft({
        storyId: `s-p${index}`,
        draftId: `d-p${index}`,
        itemId: `item-p${index}`,
        articleUrl: `https://www.videogameschronicle.com/news/live-${index}/`,
        createdAt: NOW - (5000 - index * 1000),
      });
    }
    const bridged = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger: silentLogger(),
    });
    expect(bridged).toEqual({
      kind: 'bridged',
      scanned: 5,
      approved: 5,
      enqueued: 5,
      duplicates: 0,
      requiresReview: 0,
      refused: 0,
      retiredStale: 0,
      reevaluated: 0,
      reevaluationSkipped: 0,
      deferredGuideLane: 0,
      deferredCategoryCap: 0,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });
    expect(await listPublicationPriorities()).toEqual([80, 80, 80, 80, 80, 80, 80]);
    expect(await listDraftStatuses()).toEqual([
      { id: 'd-p0', status: 'auto_approved' },
      { id: 'd-p1', status: 'auto_approved' },
      { id: 'd-p2', status: 'auto_approved' },
      { id: 'd-p3', status: 'auto_approved' },
      { id: 'd-p4', status: 'auto_approved' },
      { id: 'd-h1', status: 'approved' },
      { id: 'd-h2', status: 'approved' },
    ]);
  });

  it('still defers the over-represented category when the pool holds an alternative (the cap keeps shaping)', async () => {
    await seedPublished({
      pubId: 'pub-h1',
      storyId: 's-h1',
      draftId: 'd-h1',
      publishedAtMs: NOW - 2 * 3_600_000,
    });
    await seedPublished({
      pubId: 'pub-h2',
      storyId: 's-h2',
      draftId: 'd-h2',
      publishedAtMs: NOW - 1 * 3_600_000,
    });
    for (let index = 0; index < 4; index += 1) {
      await seedReadyDraft({
        storyId: `s-q${index}`,
        draftId: `d-q${index}`,
        itemId: `item-q${index}`,
        articleUrl: `https://www.videogameschronicle.com/news/mixed-${index}/`,
        createdAt: NOW - (5000 - index * 1000),
      });
    }
    await seedReadyDraft({
      storyId: 's-qm',
      draftId: 'd-qm',
      itemId: 'item-qm',
      articleUrl: 'https://www.videogameschronicle.com/news/mod-mixed/',
      contentType: 'mod',
      createdAt: NOW - 500,
    });
    const bridged = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger: silentLogger(),
    });
    expect(bridged).toEqual({
      kind: 'bridged',
      scanned: 5,
      approved: 1,
      enqueued: 1,
      duplicates: 0,
      requiresReview: 0,
      refused: 0,
      retiredStale: 0,
      reevaluated: 0,
      reevaluationSkipped: 0,
      deferredGuideLane: 0,
      deferredCategoryCap: 4,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });
    expect(await listPublicationPriorities()).toEqual([80, 80, 80]);
    expect(await listDraftStatuses()).toEqual([
      { id: 'd-q0', status: 'ready' },
      { id: 'd-q1', status: 'ready' },
      { id: 'd-q2', status: 'ready' },
      { id: 'd-q3', status: 'ready' },
      { id: 'd-qm', status: 'auto_approved' },
      { id: 'd-h1', status: 'approved' },
      { id: 'd-h2', status: 'approved' },
    ]);
  });
});
