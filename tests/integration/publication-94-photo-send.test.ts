import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  enqueuePublication,
  findPublicationById,
  listPublicationMessages,
} from '../../src/adapters/db/publication-outbox-store';
import { createMediaAssetStore } from '../../src/adapters/db/media-asset-store';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
  type PublicationChannelTransport,
} from '../../src/application/publishing/scheduler';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * ADR-0067 — the single-photo send (media by hotlink, no R2): when a
 * ready draft's story has a source item carrying an image URL, the
 * scheduler sends the post as a PHOTO (sendPhoto, URL or saved
 * file_id) with the rendered text as caption, and records the ledger
 * (file_id saved on a URL send, usage row ordinal 0). Every miss
 * degrades to the text send — never a throw, never a second send.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window (09:30–11:30). */
const NOW_MORNING = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';
const IMAGE_URL = 'https://cdn.example.com/a.jpg';

let clock: MutableClock;

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

async function insertStory(id: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', 'industry', 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [id, `key-${id}`, NOW_MORNING, NOW_MORNING, NOW_MORNING, NOW_MORNING],
  });
}

let draftVersionCounter = 0;

async function insertDraft(
  id: string,
  storyId: string,
  summaryFa = 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
): Promise<void> {
  draftVersionCounter += 1;
  const document = {
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa,
    modelClaims: [],
  };
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'approved', 'fa', 'standard', 'تیتر خبر گیمینگ', ?, '[]', '[]', ?, 'test', ?, ?)`,
    params: [id, storyId, JSON.stringify(document), draftVersionCounter, NOW_MORNING, NOW_MORNING],
  });
}

async function insertSourceItem(
  id: string,
  storyId: string,
  imageUrl: string | null,
  articleUrl: string,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, attribution_template, config_json,
            created_at, updated_at)
          VALUES ('src-photo', 'Photo Source', 'rss', 'editorial', 30, 1, 3600, 50, 100, 'threshold', NULL, '{}', ?, ?)`,
    params: [NOW_MORNING, NOW_MORNING],
  });
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, 'src-photo', ?, ?, 'Photo item', 'body', NULL, ?, ?, 'hash-photo', ?, 'processed')`,
    params: [
      id,
      `ext-${id}`,
      articleUrl,
      NOW_MORNING,
      NOW_MORNING,
      JSON.stringify(imageUrl === null ? {} : { imageUrl }),
    ],
  });
  await executor.run({
    sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
            normalized_value, confidence, status, created_at, updated_at)
          VALUES (?, ?, 'source_report', 'game', 'announced', 'a game', NULL, 80, 'supported', ?, ?)`,
    params: [`claim-${id}`, storyId, NOW_MORNING, NOW_MORNING],
  });
  await executor.run({
    sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
          VALUES (?, ?, ?, 'supports', 80, NULL, ?)`,
    params: [`ev-${id}`, `claim-${id}`, id, NOW_MORNING],
  });
}

async function insertAsset(
  id: string,
  itemId: string,
  rightsStatus: string,
  fileId: string | null = null,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO media_assets (id, source_item_id, type, canonical_url, source_url, mime_type,
            width, height, duration_seconds, file_size, sha256, visual_key, rights_status,
            attribution, r2_key, telegram_file_id, status, expires_at, created_at, updated_at)
          VALUES (?, ?, 'photo', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'cdn.example.com',
            NULL, ?, 'validated', NULL, ?, ?)`,
    params: [id, itemId, IMAGE_URL, IMAGE_URL, rightsStatus, fileId, NOW_MORNING, NOW_MORNING],
  });
}

interface PhotoCall {
  readonly chatId: number | string;
  readonly photo: string;
  readonly captionText: string | null;
}

interface MessageCall {
  readonly chatId: number | string;
  readonly text: string;
}

function makeTransport(photoFileId: string | undefined = 'file-abc') {
  const messageCalls: MessageCall[] = [];
  const photoCalls: PhotoCall[] = [];
  const transport: PublicationChannelTransport = {
    async sendMessageRich(input) {
      messageCalls.push({ chatId: input.chatId, text: input.content.text });
      return { messageId: 101 };
    },
    async sendPhotoRich(input) {
      photoCalls.push({
        chatId: input.chatId,
        photo: input.photo,
        captionText: input.caption?.text ?? null,
      });
      return photoFileId === undefined ? { messageId: 102 } : { messageId: 102, photoFileId };
    },
  };
  return { transport, messageCalls, photoCalls };
}

function buildScheduler(transport: PublicationChannelTransport) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport,
    mediaAssets: createMediaAssetStore(executor),
    sendGate: { enabled: true },
    contextProvider: createStoriesPolicyContextProvider(executor),
    clock,
    logger: silentLogger(),
    scanLimit: 10,
  });
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  for (const table of [
    'media_usages',
    'media_assets',
    'evidence',
    'claims',
    'source_items',
    'sources',
    'publication_messages',
    'publications',
    'drafts',
    'stories',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  clock = fixedClock(NOW_MORNING);
  draftVersionCounter = 0;
});

describe('publication-94 photo send (ADR-0067)', () => {
  it('sends a photo when a validated asset exists, saves the file_id, records the usage', async () => {
    await insertStory('s-photo-1');
    await insertDraft('d-photo-1', 's-photo-1');
    await insertSourceItem('item-1', 's-photo-1', IMAGE_URL, 'https://example.com/article-1');
    await insertAsset('asset-1', 'item-1', 'attribution_required');
    const { transport, messageCalls, photoCalls } = makeTransport('file-abc');
    await enqueuePublication(executor, {
      publicationId: 'pub-photo-1',
      draftId: 'd-photo-1',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-photo-1', outcome: 'sent' });
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_URL);
    expect(photoCalls[0]?.captionText).toContain('تیتر خبر گیمینگ');

    const row = await findPublicationById(executor, 'pub-photo-1');
    expect(row?.status).toBe('published');
    const messages = await listPublicationMessages(executor, 'pub-photo-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message_id).toBe(102);

    // The ledger: the URL send's file_id is saved for reuse, and the
    // usage row records the photo on this publication (ordinal 0).
    const asset = await executor.first<{ status: string; telegram_file_id: string | null }>({
      sql: 'SELECT status, telegram_file_id FROM media_assets WHERE id = ?',
      params: ['asset-1'],
    });
    expect(asset?.status).toBe('uploaded');
    expect(asset?.telegram_file_id).toBe('file-abc');
    const usages = await executor.query<{ media_asset_id: string; ordinal: number }>({
      sql: 'SELECT media_asset_id, ordinal FROM media_usages WHERE publication_id = ?',
      params: ['pub-photo-1'],
    });
    expect(usages.rows).toHaveLength(1);
    expect(usages.rows[0]).toEqual({ media_asset_id: 'asset-1', ordinal: 0 });
  });

  it('inserts the URL asset when none exists and still sends the photo', async () => {
    await insertStory('s-photo-2');
    await insertDraft('d-photo-2', 's-photo-2');
    await insertSourceItem('item-2', 's-photo-2', IMAGE_URL, 'https://example.com/article-2');
    const { transport, messageCalls, photoCalls } = makeTransport('file-def');
    await enqueuePublication(executor, {
      publicationId: 'pub-photo-2',
      draftId: 'd-photo-2',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-photo-2', outcome: 'sent' });
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_URL);
    const asset = await executor.first<{ status: string; attribution: string | null }>({
      sql: 'SELECT status, attribution FROM media_assets WHERE canonical_url = ?',
      params: [IMAGE_URL],
    });
    expect(asset?.status).toBe('uploaded');
    expect(asset?.attribution).toBe('cdn.example.com');
  });

  it('falls back to text when the story has no image', async () => {
    await insertStory('s-photo-3');
    await insertDraft('d-photo-3', 's-photo-3');
    await insertSourceItem('item-3', 's-photo-3', null, 'https://example.com/article-3');
    const { transport, messageCalls, photoCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-photo-3',
      draftId: 'd-photo-3',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-photo-3', outcome: 'sent' });
    expect(photoCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.text).toContain('تیتر خبر گیمینگ');
  });

  it('falls back to text when the asset rights are not publishable', async () => {
    await insertStory('s-photo-4');
    await insertDraft('d-photo-4', 's-photo-4');
    await insertSourceItem('item-4', 's-photo-4', IMAGE_URL, 'https://example.com/article-4');
    await insertAsset('asset-4', 'item-4', 'blocked');
    const { transport, messageCalls, photoCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-photo-4',
      draftId: 'd-photo-4',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-photo-4', outcome: 'sent' });
    expect(photoCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
  });

  it('falls back to text when the rendered text is too long for a caption', async () => {
    await insertStory('s-photo-5');
    await insertDraft('d-photo-5', 's-photo-5', 'خ'.repeat(1200));
    await insertSourceItem('item-5', 's-photo-5', IMAGE_URL, 'https://example.com/article-5');
    await insertAsset('asset-5', 'item-5', 'attribution_required');
    const { transport, messageCalls, photoCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-photo-5',
      draftId: 'd-photo-5',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    // The 4096-unit text send still fits; the 1024-unit caption does
    // not — the post goes out as text, never dropped.
    expect(report.details[0]).toMatchObject({ publicationId: 'pub-photo-5', outcome: 'sent' });
    expect(photoCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
  });
});
