import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { claimJob } from '../../src/adapters/db/job-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  acquirePollOwnership,
  commitOwnedPollResults,
  commitPollResults,
  reserveSourcePoll,
  schedulePollWindowOwned,
  type IngestItemRow,
  type PollTerminalState,
} from '../../src/adapters/db/source-ingest-store';

/**
 * ADR-0079 §3.4(a) — the ingest commit persists the resolved source
 * photo: one media_assets row per INSERTED item with an image (type
 * photo, rights attribution_required, attribution = the image host,
 * status validated — the shape resolveEditorialPhoto already accepts).
 * Before this fix the image died at the commit: normalize validated
 * imageUrl into provenance, the store never read it, media_assets had
 * 0 rows live, and every post went out text-only.
 */
const db: DbExecutor = createDbExecutor(env.DB);
const NOW = 1_770_000_000_000;

const IMG = 'https://cdn.example.com/a.jpg';

function itemRow(overrides: Partial<IngestItemRow> = {}): IngestItemRow {
  return {
    id: `item-${Math.random().toString(36).slice(2, 10)}`,
    sourceId: 'playstation_blog',
    externalId: 'ext-1',
    canonicalUrl: 'https://blog.playstation.com/article-1',
    title: 'A title',
    excerpt: null,
    author: null,
    publishedAtMs: NOW,
    fetchedAtMs: NOW,
    contentHash: 'hash-1',
    rawJson: '{}',
    ...overrides,
  };
}

function terminalState(overrides: Partial<PollTerminalState> = {}): PollTerminalState {
  return {
    cursor: 'cursor-1',
    etag: null,
    lastModified: null,
    nextPollAtMs: NOW + 300_000,
    success: true,
    lastChangedAtMs: NOW,
    lastError: null,
    consecutiveFailures: 0,
    circuitOpenUntilMs: null,
    requestsToday: 1,
    budgetDate: '2026-02-02',
    ...overrides,
  };
}

async function countMediaAssets(): Promise<number> {
  const row = await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM media_assets' });
  return row!.n;
}

async function readMediaAsset(canonicalUrl: string): Promise<Record<string, unknown> | null> {
  return db.first<Record<string, unknown>>({
    sql: 'SELECT * FROM media_assets WHERE canonical_url = ?',
    params: [canonicalUrl],
  });
}

async function reserve(sourceId: string, scheduledForMs: number): Promise<number> {
  // The reservation is fenced on the observed due marker: point the
  // seeded state at it first (the round12 harness does the same).
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at = ? WHERE source_id = ?',
    params: [scheduledForMs, sourceId],
  });
  const reserved = await reserveSourcePoll(db, { sourceId, scheduledForMs, nowMs: NOW });
  if (reserved.kind !== 'reserved') throw new Error('reservation failed');
  return reserved.holdUntilMs;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  // FK order: media_assets references source_items — clear it first.
  await db.run({ sql: 'DELETE FROM media_assets' });
  await db.run({ sql: 'DELETE FROM source_items' });
  await db.run({ sql: 'DELETE FROM source_state' });
  await db.run({ sql: 'DELETE FROM sources' });
  await db.run({ sql: 'DELETE FROM jobs' });
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('invalid registry');
  await seedSourcesFromRegistry(db, r.registry, NOW);
});

describe('ingest commit persists the source photo (ADR-0079)', () => {
  it('an inserted item with an image mints one validated media_assets row', async () => {
    const holdUntilMs = await reserve('playstation_blog', NOW);
    const item = itemRow({
      imageUrl: IMG,
      mediaAssetId: 'media-1',
      imageAttribution: 'cdn.example.com',
    });
    const result = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [item],
      state: terminalState(),
      holdUntilMs,
      nowMs: NOW,
    });
    expect(result.inserted).toBe(1);
    expect(await countMediaAssets()).toBe(1);
    const row = await readMediaAsset(IMG);
    expect(row).not.toBeNull();
    expect(row?.['id']).toBe('media-1');
    expect(row?.['source_item_id']).toBe(item.id);
    expect(row?.['type']).toBe('photo');
    expect(row?.['rights_status']).toBe('attribution_required');
    expect(row?.['attribution']).toBe('cdn.example.com');
    expect(row?.['status']).toBe('validated');
  });

  it('an imageless item mints no media row', async () => {
    const holdUntilMs = await reserve('playstation_blog', NOW);
    const result = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [itemRow()],
      state: terminalState(),
      holdUntilMs,
      nowMs: NOW,
    });
    expect(result.inserted).toBe(1);
    expect(await countMediaAssets()).toBe(0);
  });

  it('a duplicate re-commit mints no second media row for the URL', async () => {
    const holdUntilMs = await reserve('playstation_blog', NOW);
    const first = itemRow({
      imageUrl: IMG,
      mediaAssetId: 'media-1',
      imageAttribution: 'cdn.example.com',
    });
    await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [first],
      state: terminalState(),
      holdUntilMs,
      nowMs: NOW,
    });
    expect(await countMediaAssets()).toBe(1);

    // Same external id, fresh attempt ids: the item is a duplicate, so
    // no second media row may appear (and no orphan may point at the
    // fresh, never-inserted item id).
    const holdUntilMs2 = await reserve('playstation_blog', NOW + 300_000);
    const retry = itemRow({
      id: 'item-retry',
      imageUrl: IMG,
      mediaAssetId: 'media-2',
      imageAttribution: 'cdn.example.com',
    });
    const second = await commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [retry],
      state: terminalState({ nextPollAtMs: NOW + 600_000 }),
      holdUntilMs: holdUntilMs2,
      nowMs: NOW + 300_000,
    });
    expect(second.inserted).toBe(0);
    expect(await countMediaAssets()).toBe(1);
    const row = await readMediaAsset(IMG);
    expect(row?.['id']).toBe('media-1');
    expect(row?.['source_item_id']).toBe(first.id);
  });

  it('the owned commit path mints the media row too', async () => {
    // Production ownership dance (R09): schedule the owned window, claim
    // the poll job, acquire ownership — then the owned commit.
    const jobId = 'job-owned-1';
    const scheduled = await schedulePollWindowOwned(
      db,
      {
        sourceId: 'playstation_blog',
        scheduledForMs: 0,
        idempotencyKey: 'ingest-media:playstation_blog:0',
        canonicalPayloadJson: canonicalizeJson({
          sourceId: 'playstation_blog',
          scheduledForMs: 0,
        }),
        jobId,
        priority: 40,
        maxAttempts: 3,
        nowMs: NOW,
      },
      900,
    );
    expect(scheduled.kind).toBe('scheduled');
    const claim = await claimJob(db, jobId, NOW);
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('fixture claim failed');
    const owned = await acquirePollOwnership(db, {
      sourceId: 'playstation_blog',
      jobId,
      scheduledForMs: 0,
      generation: claim.generation,
      nowMs: NOW,
    });
    expect(owned.kind).toBe('owned');
    if (owned.kind !== 'owned') throw new Error('fixture ownership failed');
    const item = itemRow({
      imageUrl: IMG,
      mediaAssetId: 'media-owned-1',
      imageAttribution: 'cdn.example.com',
    });
    const result = await commitOwnedPollResults(db, {
      sourceId: 'playstation_blog',
      jobId,
      generation: claim.generation,
      observedHoldUntilMs: owned.holdUntilMs,
      items: [item],
      state: terminalState(),
      nowMs: NOW,
    });
    expect(result.inserted).toBe(1);
    expect(await countMediaAssets()).toBe(1);
    const row = await readMediaAsset(IMG);
    expect(row?.['id']).toBe('media-owned-1');
    expect(row?.['source_item_id']).toBe(item.id);
  });
});
