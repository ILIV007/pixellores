import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { bridgeReadyDrafts } from '../../src/application/publishing/auto-publish-bridge';
import front5Fixture from '../fixtures/bridge-livelock-front5.json';

/**
 * ADR-0082 — the flag-off backfill through the REAL bridge over REAL
 * workerd D1: a ready draft whose `factGuard` key was never written
 * (the PR #27-era shape with the flag off) is refused by the gate
 * with `report_absent` — and the bridge BUILDS the report from the
 * draft's own stored bytes instead of leaving it refused forever.
 * The stored document is the live bytes of the first livelock-front-5
 * draft (fixture), with its `factGuard` key stripped. The ONLY
 * artificial pieces are the seeded rows themselves and the logger sink.
 */

const NOW = 1_796_000_000_000;
const SOURCE_ID = 'src-livelock';
const DESTINATION = '@pixel_channel_backfill';

const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });

interface BackfillFixtureEntry {
  readonly draftId: string;
  readonly storyId: string;
  readonly storyKey: string;
  readonly createdAt: number;
  readonly documentJson: string;
  readonly item: {
    readonly id: string;
    readonly title: string;
    readonly bodyExcerpt: string | null;
    readonly contentHash: string;
  };
}

const ENTRY = (front5Fixture as readonly BackfillFixtureEntry[])[0]!;

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
    'draft_gate_evaluations',
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

async function seedSoulPointer(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES ('soul.current_version', '{"version": 1}', 1, NULL, ?)`,
    params: [NOW],
  });
}

async function seedSource(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'منبع آزمون بک‌فیل', 'rss', 'official', 96, 1, 300, 50, 300, 'threshold', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
}

async function seedStory(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, first_seen_at, last_evidence_at, created_at, updated_at)
          VALUES (?, ?, 'discovered', 'official', 'official_news', ?, ?, ?, ?)`,
    params: [ENTRY.storyId, ENTRY.storyKey, NOW, NOW, NOW, NOW],
  });
}

async function seedItem(executor: DbExecutor): Promise<void> {
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
              author, published_at, fetched_at, content_hash, raw_json, processing_status)
            VALUES (?, ?, ?, NULL, ?, ?, 'Gematsu', ?, ?, ?, '{}', 'processed')`,
    params: [
      ENTRY.item.id,
      SOURCE_ID,
      ENTRY.item.id,
      ENTRY.item.title,
      ENTRY.item.bodyExcerpt,
      NOW - 100_000,
      NOW - 90_000,
      ENTRY.item.contentHash,
    ],
  });
}

/** The flag-off shape: the live document with its `factGuard` key stripped. */
function absentDocumentJson(): string {
  const document = JSON.parse(ENTRY.documentJson) as Record<string, unknown>;
  delete document['factGuard'];
  return JSON.stringify(document);
}

async function seedDraft(executor: DbExecutor): Promise<void> {
  const documentJson = absentDocumentJson();
  const document = JSON.parse(documentJson) as Record<string, unknown>;
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              version, created_by, created_at, updated_at)
            VALUES (?, ?, 'ready', 'fa', 'news_v1', ?, ?, 1, 'test', ?, ?)`,
    params: [
      ENTRY.draftId,
      ENTRY.storyId,
      typeof document['headlineFa'] === 'string' ? document['headlineFa'] : ENTRY.draftId,
      documentJson,
      ENTRY.createdAt,
      ENTRY.createdAt,
    ],
  });
}

async function draftDocumentJson(executor: DbExecutor): Promise<string> {
  const row = await executor.first<{ document_json: string }>({
    sql: `SELECT document_json FROM drafts WHERE id = ?`,
    params: [ENTRY.draftId],
  });
  if (row === null) throw new Error(`draft ${ENTRY.draftId} not found`);
  return row.document_json;
}

beforeEach(async () => {
  const executor = createDbExecutor(env.DB);
  await freshDb(executor);
  await seedSoulPointer(executor);
  await seedSource(executor);
});

describe('ADR-0082 — bridge backfills a report_absent draft', () => {
  it('builds the missing report on the first pass and never re-triggers', async () => {
    const executor = createDbExecutor(env.DB);
    await seedStory(executor);
    await seedItem(executor);
    await seedDraft(executor);

    const first = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger,
    });
    // The rebuild happened (reevaluated 1) — and the rebuilt report is
    // grounded, so the gate then sends the draft to HUMAN REVIEW on
    // substance (2 claims < the 3-claim floor), never to the outbox.
    expect(first).toEqual({
      kind: 'bridged',
      scanned: 1,
      approved: 0,
      enqueued: 0,
      duplicates: 0,
      requiresReview: 1,
      refused: 0,
      retiredStale: 0,
      reevaluated: 1,
      reevaluationSkipped: 0,
      deferredGuideLane: 0,
      deferredCategoryCap: 0,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });

    const stored = JSON.parse(await draftDocumentJson(executor)) as Record<string, unknown>;
    const factGuard = stored['factGuard'] as Record<string, unknown> | undefined;
    expect(factGuard).toBeDefined();
    expect(factGuard?.['factGuardVersion']).toBe(1);
    const counts = factGuard?.['counts'] as Record<string, unknown> | undefined;
    expect(counts?.['claimsRequiringReview']).toBe(0);
    expect(counts?.['total']).toBe(2);
    // The claims themselves are untouched — only the derived report moved.
    expect(stored['modelClaims']).toEqual(
      (JSON.parse(ENTRY.documentJson) as Record<string, unknown>)['modelClaims'],
    );
    // ONE audit event for the build (no prior report existed, so the
    // before-count marks absence, not a measured count).
    const audits = await executor.query<{ target_id: string; metadata_json: string }>({
      sql: `SELECT target_id, metadata_json FROM audit_events WHERE action = 'fact_guard_reevaluated'`,
    });
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.target_id).toBe(ENTRY.draftId);
    const metadata = JSON.parse(audits.rows[0]?.metadata_json ?? '{}') as Record<string, unknown>;
    expect(metadata['factGuardVersion']).toBe(1);
    expect(metadata['claimsRequiringReviewBefore']).toBe(0);
    expect(metadata['claimsRequiringReviewAfter']).toBe(0);

    // Second pass: the report now exists, so the gate decides on it
    // (requires_review on substance, no numbers finding) and the
    // backfill never re-triggers — one attempt per draft, bounded.
    const second = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger,
    });
    expect(second.kind).toBe('bridged');
    if (second.kind === 'bridged') {
      expect(second.reevaluated).toBe(0);
      expect(second.requiresReview).toBe(1);
    }
    const auditsAfter = await executor.query<{ target_id: string }>({
      sql: `SELECT target_id FROM audit_events WHERE action = 'fact_guard_reevaluated'`,
    });
    expect(auditsAfter.rows).toHaveLength(1);
  });
});
