import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { bridgeReadyDrafts } from '../../src/application/publishing/auto-publish-bridge';
import { buildFactGuardReport } from '../../src/domain/editorial/fact-guard';
import { createLogger } from '../../src/observability/logger';

/**
 * ADR-0079 §3.3 — the freshness gate at the bridge: a stale `ready`
 * draft is RETIRED (a `quality_rejections` row + the draft leaves
 * `ready` for `rejected`), never enqueued, never deferred. The gate
 * runs BEFORE the auto gate, so a stale draft retires even when it
 * would also fail the substance gate — staleness is the terminal
 * verdict, not a deferral.
 *
 * The 48h source-age rule and the past-date rule are both covered:
 * a 72h-old source item retires on age alone; a fresh source whose
 * draft claims a past date retires on the claim date alone.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15. */
const NOW = 1_700_029_800_000;
const DESTINATION = '@pixel_channel_bridge_freshness';
const EXCERPT = 'استودیو بازی تازه را معرفی کرد؛ بازی دوم هم معرفی شد؛ و بازی سوم نیز معرفی شد.';
const CLAIM_TEXTS = [
  'استودیو بازی تازه را معرفی کرد',
  'بازی دوم هم معرفی شد',
  'بازی سوم نیز معرفی شد',
];

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

function eligibleDocument(
  itemId: string,
  contentHash: string,
  claimTexts: readonly string[] = CLAIM_TEXTS,
  excerptText: string = EXCERPT,
): string {
  const report = buildFactGuardReport({
    snapshot: { sourceItemId: itemId, contentHash },
    evidence: { evidenceId: itemId, excerptText, excerptTruncated: false },
    draftClaims: claimTexts.map((text) => ({ text, evidenceIds: [itemId] })),
    draftHeadlineFa: 'تیتر خبر گیمینگ',
    draftSummaryFa: 'خلاصهٔ خبر',
    draftSourceItemId: itemId,
  });
  return JSON.stringify({
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر',
    modelClaims: claimTexts.map((text) => ({ text, status: 'unverified' })),
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
  readonly publishedAtMs: number | null;
  readonly claimTexts?: readonly string[];
  readonly excerptText?: string;
  readonly createdAt?: number;
}): Promise<void> {
  const contentHash = `hash-${input.itemId}`;
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', 'industry', 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [input.storyId, `key-${input.storyId}`, NOW, NOW, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, 'src-bridge', ?, ?, 'Bridge item', ?, NULL, ?, ?, ?, '{}', 'processed')`,
    params: [
      input.itemId,
      `ext-${input.itemId}`,
      input.articleUrl,
      EXCERPT,
      input.publishedAtMs,
      NOW,
      contentHash,
    ],
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
      eligibleDocument(input.itemId, contentHash, input.claimTexts, input.excerptText ?? EXCERPT),
      input.createdAt ?? NOW,
      input.createdAt ?? NOW,
    ],
  });
}

async function readDraftStatus(draftId: string): Promise<string | null> {
  const rows = await executor.query<{ status: string }>({
    sql: 'SELECT status FROM drafts WHERE id = ?',
    params: [draftId],
  });
  return rows.rows[0]?.status ?? null;
}

async function readQualityRejections(): Promise<
  readonly { id: string; fingerprint: string; reason: string }[]
> {
  const rows = await executor.query<{ id: string; fingerprint: string; reason: string }>({
    sql: 'SELECT id, fingerprint, reason FROM quality_rejections ORDER BY id ASC',
  });
  return rows.rows;
}

async function countPublications(): Promise<number> {
  const rows = await executor.query<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM publications',
  });
  return rows.rows[0]?.n ?? 0;
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
    'quality_rejections',
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

describe('bridge freshness gate — stale drafts retire (ADR-0079 §3.3)', () => {
  it('retires a draft whose source item is 72h old (stale_source_age) and enqueues nothing', async () => {
    await seedReadyDraft({
      storyId: 's-stale-age',
      draftId: 'd-stale-age',
      itemId: 'item-stale-age',
      articleUrl: 'https://www.videogameschronicle.com/news/stale-age/',
      publishedAtMs: NOW - 72 * 3_600_000,
    });
    const bridged = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger: silentLogger(),
    });
    expect(bridged.kind).toBe('bridged');
    if (bridged.kind !== 'bridged') return;
    expect(bridged.scanned).toBe(1);
    expect(bridged.retiredStale).toBe(1);
    expect(bridged.enqueued).toBe(0);
    expect(bridged.approved).toBe(0);
    expect(await readDraftStatus('d-stale-age')).toBe('rejected');
    expect(await countPublications()).toBe(0);
    const rejections = await readQualityRejections();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.id).toBe('qr:stale:d-stale-age');
    expect(rejections[0]?.fingerprint).toBe('stale:hash-item-stale-age');
    expect(rejections[0]?.reason).toBe('stale_source_age');
  });

  it('retires a fresh-source draft whose claim names a past date (stale_past_date)', async () => {
    // NOW is 2023-11-15; the claim names 10 November — a past date in
    // the same calendar — so the draft is stale on its claim date even
    // though its source item is one hour old.
    await seedReadyDraft({
      storyId: 's-stale-date',
      draftId: 'd-stale-date',
      itemId: 'item-stale-date',
      articleUrl: 'https://www.videogameschronicle.com/news/stale-date/',
      publishedAtMs: NOW - 3_600_000,
      claimTexts: ['بازی ۱۰ نوامبر منتشر شد'],
      excerptText: 'بازی ۱۰ نوامبر منتشر شد و جزئیات بیشتری آمد.',
    });
    const bridged = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger: silentLogger(),
    });
    expect(bridged.kind).toBe('bridged');
    if (bridged.kind !== 'bridged') return;
    expect(bridged.retiredStale).toBe(1);
    expect(bridged.enqueued).toBe(0);
    expect(await readDraftStatus('d-stale-date')).toBe('rejected');
    const rejections = await readQualityRejections();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe('stale_past_date');
  });

  it('bridges a fresh 3-claim draft normally (retiredStale 0, enqueued 1)', async () => {
    await seedReadyDraft({
      storyId: 's-fresh',
      draftId: 'd-fresh',
      itemId: 'item-fresh',
      articleUrl: 'https://www.videogameschronicle.com/news/fresh/',
      publishedAtMs: NOW - 3_600_000,
    });
    const bridged = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger: silentLogger(),
    });
    expect(bridged.kind).toBe('bridged');
    if (bridged.kind !== 'bridged') return;
    expect(bridged.scanned).toBe(1);
    expect(bridged.retiredStale).toBe(0);
    expect(bridged.enqueued).toBe(1);
    expect(bridged.approved).toBe(1);
    expect(await readDraftStatus('d-fresh')).toBe('auto_approved');
    expect(await readQualityRejections()).toHaveLength(0);
  });
});
