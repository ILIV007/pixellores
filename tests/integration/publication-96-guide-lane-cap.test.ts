import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { bridgeReadyDrafts } from '../../src/application/publishing/auto-publish-bridge';
import { buildFactGuardReport } from '../../src/domain/editorial/fact-guard';
import { createLogger } from '../../src/observability/logger';

/**
 * ADR-0068 — the bridge's lane + cap (quality fix #5):
 * - GUIDE LANE: at most ONE guide per pass, at P2 priority (60);
 *   further guides stay `ready` (deferred, never dropped).
 * - CATEGORY CAP: the arp1 40%-of-rolling-six cap runs in the
 *   bridge, over the published trail PLUS this pass's approvals;
 *   an over-cap draft stays `ready` (deferred, never rejected).
 *
 * The eligible documents are built with the REAL fact-guard builder
 * (one number-free claim witnessed verbatim in the excerpt), so the
 * gate passes and ONLY the lane/cap decide.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15. */
const NOW = 1_700_029_800_000;
const DESTINATION = '@pixel_channel_bridge96';
const CLAIM_TEXT = 'استودیو بازی تازه را معرفی کرد';
const EXCERPT = 'استودیو بازی تازه را معرفی کرد و جزئیات بیشتری منتشر شد.';

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

function eligibleDocument(itemId: string, contentHash: string): string {
  const report = buildFactGuardReport({
    snapshot: { sourceItemId: itemId, contentHash },
    evidence: { evidenceId: itemId, excerptText: EXCERPT, excerptTruncated: false },
    draftClaims: [{ text: CLAIM_TEXT, evidenceIds: [itemId] }],
    draftHeadlineFa: 'تیتر خبر گیمینگ',
    draftSummaryFa: 'خلاصهٔ خبر',
    draftSourceItemId: itemId,
  });
  return JSON.stringify({
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر',
    modelClaims: [{ text: CLAIM_TEXT, status: 'unverified' }],
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
    sql: 'SELECT id, status FROM drafts ORDER BY created_at ASC',
  });
  return rows.rows;
}

async function listPublicationPriorities(): Promise<readonly number[]> {
  const rows = await executor.query<{ priority: number }>({
    sql: 'SELECT priority FROM publications ORDER BY created_at ASC',
  });
  return rows.rows.map((row) => row.priority);
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  for (const table of [
    'publication_messages',
    'publications',
    'audit_events',
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

describe('bridge guide lane + category cap (ADR-0068)', () => {
  it('enqueues at most one guide per pass, at P2 priority; the second guide stays ready', async () => {
    await seedReadyDraft({
      storyId: 's-g1',
      draftId: 'd-g1',
      itemId: 'item-g1',
      articleUrl: 'https://www.videogameschronicle.com/guide/gta-6-all-safe-locations/',
      createdAt: NOW - 2000,
    });
    await seedReadyDraft({
      storyId: 's-g2',
      draftId: 'd-g2',
      itemId: 'item-g2',
      articleUrl: 'https://www.videogameschronicle.com/guide/gta-6-all-mission-list/',
      createdAt: NOW - 1000,
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
      scanned: 2,
      approved: 1,
      enqueued: 1,
      duplicates: 0,
      requiresReview: 0,
      refused: 0,
      deferredGuideLane: 1,
      deferredCategoryCap: 0,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });
    // The one guide that rode the pass is P2 (60); the other stays ready.
    expect(await listPublicationPriorities()).toEqual([60]);
    expect(await listDraftStatuses()).toEqual([
      { id: 'd-g1', status: 'auto_approved' },
      { id: 'd-g2', status: 'ready' },
    ]);
  });

  it('defers the third same-category draft in one pass (the 40% cap, pass-local)', async () => {
    await seedReadyDraft({
      storyId: 's-c1',
      draftId: 'd-c1',
      itemId: 'item-c1',
      articleUrl: 'https://www.videogameschronicle.com/news/one/',
      createdAt: NOW - 3000,
    });
    await seedReadyDraft({
      storyId: 's-c2',
      draftId: 'd-c2',
      itemId: 'item-c2',
      articleUrl: 'https://www.videogameschronicle.com/news/two/',
      createdAt: NOW - 2000,
    });
    await seedReadyDraft({
      storyId: 's-c3',
      draftId: 'd-c3',
      itemId: 'item-c3',
      articleUrl: 'https://www.videogameschronicle.com/news/three/',
      createdAt: NOW - 1000,
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
      scanned: 3,
      approved: 2,
      enqueued: 2,
      duplicates: 0,
      requiresReview: 0,
      refused: 0,
      deferredGuideLane: 0,
      deferredCategoryCap: 1,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });
    expect(await listPublicationPriorities()).toEqual([80, 80]);
    expect(await listDraftStatuses()).toEqual([
      { id: 'd-c1', status: 'auto_approved' },
      { id: 'd-c2', status: 'auto_approved' },
      { id: 'd-c3', status: 'ready' },
    ]);
  });

  it('defers a same-category draft when the published trail already holds two', async () => {
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
    await seedReadyDraft({
      storyId: 's-c4',
      draftId: 'd-c4',
      itemId: 'item-c4',
      articleUrl: 'https://www.videogameschronicle.com/news/four/',
      createdAt: NOW - 1000,
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
      scanned: 1,
      approved: 0,
      enqueued: 0,
      duplicates: 0,
      requiresReview: 0,
      refused: 0,
      deferredGuideLane: 0,
      deferredCategoryCap: 1,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });
    expect(await listDraftStatuses()).toEqual([
      { id: 'd-c4', status: 'ready' },
      { id: 'd-h1', status: 'approved' },
      { id: 'd-h2', status: 'approved' },
    ]);
  });
});
