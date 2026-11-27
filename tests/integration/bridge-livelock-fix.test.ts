import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { bridgeReadyDrafts } from '../../src/application/publishing/auto-publish-bridge';
import { buildFactGuardReport } from '../../src/domain/editorial/fact-guard';
import { buildTraceableExcerpt } from '../../src/domain/editorial/mapper';
import { sha256Hex } from '../../src/shared/ids/idempotency-key';
import front5Fixture from '../fixtures/bridge-livelock-front5.json';

/**
 * ADR-0074 — the bridge livelock fix, over REAL workerd D1 with the REAL
 * stored bytes of the five drafts that stalled the live channel on
 * 2026-11-27 (fixture: the exact `document_json` values read from the
 * preview D1, with their source items' stored title/body_excerpt/
 * content_hash). The five oldest ready drafts all failed the TOTAL
 * deterministic auto-gate on `number_not_observed_in_evidence` for
 * Persian-digit tokens (۲۰۲۷، ۲۷، ۱۸، ۱۷، ۲۱) that exist in the stored
 * excerpt ONLY as Latin digits — the pre-ADR-0066 numbers lens. The
 * bridge re-scanned the same front five on every 5-minute pass, wrote
 * nothing, and never reached the 48 drafts behind them.
 *
 * This suite proves, on those exact bytes:
 *  - the re-evaluation path rebuilds each stored report with the
 *    CURRENT folded lens, the findings clear, and all five bridge in
 *    ONE pass (audited, Soul-stamped, enqueued);
 *  - a genuinely ungrounded number is NOT laundered: the rebuild is
 *    byte-identical to the stored report, nothing is written, and the
 *    draft still requires review;
 *  - re-evaluation is fail-closed: a missing source item and a
 *    content-hash mismatch both leave the stored report untouched;
 *  - the progress layer rotates the scan: five deterministically-failing
 *    oldest drafts cannot block the passable draft behind them — the
 *    second pass reaches it.
 *
 * The ONLY artificial pieces are the seeded rows themselves (the live
 * D1 values, copied verbatim) and the logger sink.
 */

const NOW = 1_796_000_000_000;
const SOURCE_ID = 'src-livelock';
const DESTINATION = '@pixel_channel_livelock';

const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });

interface LivelockFixtureEntry {
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

const FRONT5 = front5Fixture as readonly LivelockFixtureEntry[];

/** One distinct mix category per story, so the 40% cap never binds. */
const STORY_CONTENT_TYPES = ['official_news', 'release', 'mobile', 'hardware', 'esports'] as const;

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
          VALUES (?, 'منبع آزمون لاک‌قفل', 'rss', 'official', 96, 1, 300, 50, 300, 'threshold', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
}

async function seedStory(
  executor: DbExecutor,
  storyId: string,
  storyKey: string,
  contentType: string,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, first_seen_at, last_evidence_at, created_at, updated_at)
          VALUES (?, ?, 'discovered', 'official', ?, ?, ?, ?, ?)`,
    params: [storyId, storyKey, contentType, NOW, NOW, NOW, NOW],
  });
}

async function seedItem(
  executor: DbExecutor,
  item: LivelockFixtureEntry['item'],
  contentHashOverride?: string,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
              author, published_at, fetched_at, content_hash, raw_json, processing_status)
            VALUES (?, ?, ?, NULL, ?, ?, 'Gematsu', ?, ?, ?, '{}', 'processed')`,
    params: [
      item.id,
      SOURCE_ID,
      item.id,
      item.title,
      item.bodyExcerpt,
      NOW - 100_000,
      NOW - 90_000,
      contentHashOverride ?? item.contentHash,
    ],
  });
}

async function seedDraft(
  executor: DbExecutor,
  entry: LivelockFixtureEntry,
  documentJsonOverride?: string,
): Promise<void> {
  const document = JSON.parse(documentJsonOverride ?? entry.documentJson) as Record<
    string,
    unknown
  >;
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              version, created_by, created_at, updated_at)
            VALUES (?, ?, 'ready', 'fa', 'news_v1', ?, ?, 1, 'test', ?, ?)`,
    params: [
      entry.draftId,
      entry.storyId,
      typeof document['headlineFa'] === 'string' ? document['headlineFa'] : entry.draftId,
      documentJsonOverride ?? entry.documentJson,
      entry.createdAt,
      entry.createdAt,
    ],
  });
}

async function seedFront5WithItems(executor: DbExecutor): Promise<void> {
  for (let index = 0; index < FRONT5.length; index += 1) {
    const entry = FRONT5[index]!;
    await seedStory(executor, entry.storyId, entry.storyKey, STORY_CONTENT_TYPES[index]!);
    await seedItem(executor, entry.item);
    await seedDraft(executor, entry);
  }
}

async function draftStatus(executor: DbExecutor, draftId: string): Promise<string | null> {
  const row = await executor.first<{ status: string }>({
    sql: `SELECT status FROM drafts WHERE id = ?`,
    params: [draftId],
  });
  return row?.status ?? null;
}

async function draftDocumentJson(executor: DbExecutor, draftId: string): Promise<string> {
  const row = await executor.first<{ document_json: string }>({
    sql: `SELECT document_json FROM drafts WHERE id = ?`,
    params: [draftId],
  });
  if (row === null) {
    throw new Error(`draft ${draftId} not found`);
  }
  return row.document_json;
}

beforeEach(async () => {
  const executor = createDbExecutor(env.DB);
  await freshDb(executor);
  await seedSoulPointer(executor);
  await seedSource(executor);
});

describe('ADR-0074 — bridge livelock: re-evaluation + progress', () => {
  it('the live front 5 clear under the folded lens and bridge in one pass', async () => {
    const executor = createDbExecutor(env.DB);
    await seedFront5WithItems(executor);

    const bridged = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger,
    });
    expect(bridged).toEqual({
      kind: 'bridged',
      scanned: 5,
      approved: 5,
      enqueued: 5,
      duplicates: 0,
      requiresReview: 0,
      refused: 0,
      reevaluated: 5,
      reevaluationSkipped: 0,
      deferredGuideLane: 0,
      deferredCategoryCap: 0,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });

    // All five left `ready` for `auto_approved`, Soul-stamped, enqueued.
    for (const entry of FRONT5) {
      expect(await draftStatus(executor, entry.draftId)).toBe('auto_approved');
      const stored = JSON.parse(await draftDocumentJson(executor, entry.draftId)) as Record<
        string,
        unknown
      >;
      const factGuard = stored['factGuard'] as {
        claims: readonly { reviewRequired: boolean }[];
      };
      expect(factGuard.claims.every((claim) => claim.reviewRequired === false)).toBe(true);
      // The claims themselves are untouched — only the derived report moved.
      expect(stored['modelClaims']).toEqual(
        (JSON.parse(entry.documentJson) as Record<string, unknown>)['modelClaims'],
      );
    }
    const publications = await executor.query<{ soul_version: number | null }>({
      sql: `SELECT soul_version FROM publications ORDER BY created_at ASC`,
    });
    expect(publications.rows).toHaveLength(5);
    for (const row of publications.rows) {
      expect(row.soul_version).toBe(1);
    }
    // ONE audit event per rebuilt report (ids and counts only).
    const audits = await executor.query<{ target_id: string; metadata_json: string }>({
      sql: `SELECT target_id, metadata_json FROM audit_events WHERE action = 'fact_guard_reevaluated' ORDER BY target_id ASC`,
    });
    expect(audits.rows).toHaveLength(5);
    expect(audits.rows.map((row) => row.target_id).sort()).toEqual(
      FRONT5.map((entry) => entry.draftId).sort(),
    );
    for (const row of audits.rows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      expect(metadata['claimsRequiringReviewAfter']).toBe(0);
      expect(metadata['factGuardVersion']).toBe(1);
    }
    // The progress table remembers the eligible verdicts.
    const evaluations = await executor.query<{
      last_outcome: string;
      consecutive_failures: number;
    }>({
      sql: `SELECT last_outcome, consecutive_failures FROM draft_gate_evaluations`,
    });
    expect(evaluations.rows).toHaveLength(5);
    for (const row of evaluations.rows) {
      expect(row.last_outcome).toBe('eligible_auto');
      expect(row.consecutive_failures).toBe(0);
    }
  });

  it('a genuinely ungrounded number is NOT laundered by re-evaluation', async () => {
    const executor = createDbExecutor(env.DB);
    const entry = FRONT5[0]!;
    // The stored report is built with the CURRENT lens over a claim whose
    // Persian year ۲۰۳۰ appears in the excerpt in NO script — the finding
    // is genuine, and the rebuild must be byte-identical (no write).
    const document = JSON.parse(entry.documentJson) as Record<string, unknown>;
    const modelClaims = document['modelClaims'] as {
      text: string;
      evidenceIds: readonly string[];
      status: string;
    }[];
    const modifiedClaims = modelClaims.map((claim, index) =>
      index === 0 ? { ...claim, text: claim.text.replace('۲۰۲۷', '۲۰۳۰') } : claim,
    );
    const excerpt = buildTraceableExcerpt({
      title: entry.item.title,
      body_excerpt: entry.item.bodyExcerpt,
    });
    const rebuiltReport = buildFactGuardReport({
      snapshot: { sourceItemId: entry.item.id, contentHash: entry.item.contentHash },
      evidence: {
        evidenceId: entry.item.id,
        excerptText: excerpt.text,
        excerptTruncated: excerpt.truncated,
      },
      draftClaims: modifiedClaims.map((claim) => ({
        text: claim.text,
        evidenceIds: claim.evidenceIds,
      })),
      draftHeadlineFa: document['headlineFa'] as string,
      draftSummaryFa: document['summaryFa'] as string,
      draftSourceItemId: entry.item.id,
    });
    expect(
      rebuiltReport.claims[0]?.findings.some(
        (finding) => finding.code === 'number_not_observed_in_evidence',
      ),
    ).toBe(true);
    const modifiedDocumentJson = JSON.stringify({
      ...document,
      modelClaims: modifiedClaims,
      factGuard: rebuiltReport,
    });
    await seedStory(executor, entry.storyId, entry.storyKey, 'official_news');
    await seedItem(executor, entry.item);
    await seedDraft(executor, entry, modifiedDocumentJson);

    const bridged = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger,
    });
    expect(bridged).toEqual({
      kind: 'bridged',
      scanned: 1,
      approved: 0,
      enqueued: 0,
      duplicates: 0,
      requiresReview: 1,
      refused: 0,
      reevaluated: 0,
      reevaluationSkipped: 0,
      deferredGuideLane: 0,
      deferredCategoryCap: 0,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });
    expect(await draftStatus(executor, entry.draftId)).toBe('ready');
    // Nothing was written: the stored bytes are identical, no audit row.
    expect(await draftDocumentJson(executor, entry.draftId)).toBe(modifiedDocumentJson);
    const audits = await executor.query<{ id: string }>({
      sql: `SELECT id FROM audit_events WHERE action = 'fact_guard_reevaluated'`,
    });
    expect(audits.rows).toHaveLength(0);
  });

  it('fail-closed: a missing item and a hash mismatch leave the report untouched', async () => {
    const executor = createDbExecutor(env.DB);
    const missing = FRONT5[0]!;
    const mismatched = FRONT5[1]!;
    await seedStory(executor, missing.storyId, missing.storyKey, 'official_news');
    await seedDraft(executor, missing);
    await seedStory(executor, mismatched.storyId, mismatched.storyKey, 'release');
    await seedItem(executor, mismatched.item, 'tampered-content-hash-that-matches-nothing');
    await seedDraft(executor, mismatched);

    const bridged = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger,
    });
    expect(bridged).toEqual({
      kind: 'bridged',
      scanned: 2,
      approved: 0,
      enqueued: 0,
      duplicates: 0,
      requiresReview: 2,
      refused: 0,
      reevaluated: 0,
      reevaluationSkipped: 2,
      deferredGuideLane: 0,
      deferredCategoryCap: 0,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });
    for (const entry of [missing, mismatched]) {
      expect(await draftStatus(executor, entry.draftId)).toBe('ready');
      expect(await draftDocumentJson(executor, entry.draftId)).toBe(entry.documentJson);
    }
    const audits = await executor.query<{ id: string }>({
      sql: `SELECT id FROM audit_events WHERE action = 'fact_guard_reevaluated'`,
    });
    expect(audits.rows).toHaveLength(0);
    const evaluations = await executor.query<{
      draft_id: string;
      last_outcome: string;
      consecutive_failures: number;
      last_failure_reason: string | null;
    }>({
      sql: `SELECT draft_id, last_outcome, consecutive_failures, last_failure_reason FROM draft_gate_evaluations ORDER BY draft_id ASC`,
    });
    expect(evaluations.rows).toHaveLength(2);
    for (const row of evaluations.rows) {
      expect(row.last_outcome).toBe('requires_review');
      expect(row.consecutive_failures).toBe(1);
      expect(row.last_failure_reason).toBe('fact_guard_findings');
    }
  });

  it('progress: five failing oldest drafts do not block the passable draft behind them', async () => {
    const executor = createDbExecutor(env.DB);
    // Five deterministically-failing oldest drafts: the numbers finding
    // can never clear because their source items do not exist.
    for (let index = 0; index < FRONT5.length; index += 1) {
      const entry = FRONT5[index]!;
      await seedStory(executor, entry.storyId, entry.storyKey, STORY_CONTENT_TYPES[index]!);
      await seedDraft(executor, entry);
    }
    // The passable draft behind them: a SYNTHETIC eligible draft — entry
    // 0's real bytes, re-pointed at a fresh source item whose stored
    // report is built with the CURRENT lens (clean: the folded numbers
    // lens grounds the Persian-digit claims). It needs NO re-evaluation;
    // the point is that the second pass REACHES it at all.
    const template = FRONT5[0]!;
    const passableId = 'eddr-livelock-passable';
    const passableItemId = 'item-livelock-passable';
    const passableHash = await sha256Hex(
      `${passableItemId}\u001f${template.item.title}\u001f${template.item.bodyExcerpt ?? ''}`,
    );
    const passableExcerpt = buildTraceableExcerpt({
      title: template.item.title,
      body_excerpt: template.item.bodyExcerpt,
    });
    const templateDocument = JSON.parse(template.documentJson) as Record<string, unknown>;
    const templateClaims = templateDocument['modelClaims'] as {
      text: string;
      evidenceIds: readonly string[];
      status: string;
    }[];
    const passableClaims = templateClaims.map((claim) => ({
      ...claim,
      evidenceIds: [passableItemId],
    }));
    const passableReport = buildFactGuardReport({
      snapshot: { sourceItemId: passableItemId, contentHash: passableHash },
      evidence: {
        evidenceId: passableItemId,
        excerptText: passableExcerpt.text,
        excerptTruncated: passableExcerpt.truncated,
      },
      draftClaims: passableClaims.map((claim) => ({
        text: claim.text,
        evidenceIds: claim.evidenceIds,
      })),
      draftHeadlineFa: templateDocument['headlineFa'] as string,
      draftSummaryFa: templateDocument['summaryFa'] as string,
      draftSourceItemId: passableItemId,
    });
    expect(passableReport.counts.claimsRequiringReview).toBe(0);
    const passableDocumentJson = JSON.stringify({
      ...templateDocument,
      modelClaims: passableClaims,
      factGuard: passableReport,
    });
    await seedStory(
      executor,
      'edst-livelock-passable',
      'editorial.story:livelock-passable',
      'official_news',
    );
    await seedItem(executor, {
      id: passableItemId,
      title: template.item.title,
      bodyExcerpt: template.item.bodyExcerpt,
      contentHash: passableHash,
    });
    await seedDraft(
      executor,
      {
        ...template,
        draftId: passableId,
        storyId: 'edst-livelock-passable',
        // Newest of all six: the first pass (limit 5) must NOT reach it.
        createdAt: FRONT5[4]!.createdAt + 1000,
      },
      passableDocumentJson,
    );

    // Pass 1 scans the front five (all unevaluated, oldest first) — all
    // fail, all are recorded, nothing bridges.
    const first = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW,
      logger,
    });
    expect(first).toEqual({
      kind: 'bridged',
      scanned: 5,
      approved: 0,
      enqueued: 0,
      duplicates: 0,
      requiresReview: 5,
      refused: 0,
      reevaluated: 0,
      reevaluationSkipped: 5,
      deferredGuideLane: 0,
      deferredCategoryCap: 0,
      deferredRewrite: 0,
      failedRewrite: 0,
      rejected: 0,
    });
    expect(await draftStatus(executor, passableId)).toBe('ready');

    // Pass 2 reaches the passable draft FIRST (zero failures) and bridges
    // it — without the progress layer it would rescan the same front
    // five and never reach it.
    const second = await bridgeReadyDrafts({
      executor,
      destination: DESTINATION,
      mode: 'auto',
      nowMs: NOW + 300_000,
      logger,
    });
    expect(second.kind).toBe('bridged');
    if (second.kind === 'bridged') {
      expect(second.scanned).toBe(5);
      expect(second.approved).toBe(1);
      expect(second.enqueued).toBe(1);
      expect(second.reevaluated).toBe(0);
    }
    expect(await draftStatus(executor, passableId)).toBe('auto_approved');
    const publications = await executor.query<{ draft_id: string }>({
      sql: `SELECT draft_id FROM publications`,
    });
    expect(publications.rows.map((row) => row.draft_id)).toEqual([passableId]);

    // The progress table tells the story: the passable draft is eligible
    // with zero failures; the four re-scanned front drafts sit at two
    // consecutive failures; the one front draft the second pass never
    // reached sits at one.
    const evaluations = await executor.query<{
      draft_id: string;
      last_outcome: string;
      consecutive_failures: number;
    }>({
      sql: `SELECT draft_id, last_outcome, consecutive_failures FROM draft_gate_evaluations ORDER BY draft_id ASC`,
    });
    expect(evaluations.rows).toHaveLength(6);
    const byId = new Map(evaluations.rows.map((row) => [row.draft_id, row]));
    expect(byId.get(passableId)).toEqual({
      draft_id: passableId,
      last_outcome: 'eligible_auto',
      consecutive_failures: 0,
    });
    const failingCounts = FRONT5.map(
      (entry) => byId.get(entry.draftId)?.consecutive_failures,
    ).sort();
    expect(failingCounts).toEqual([1, 2, 2, 2, 2]);
  });
});
