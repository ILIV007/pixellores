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
 * ADR-0068 — the single-photo send (media by hotlink, no R2): when a
 * ready draft's story has a source item carrying an image URL, the
 * scheduler sends the post as a PHOTO (sendPhoto, URL or saved
 * file_id) with the rendered text as caption, and records the ledger
 * (file_id saved on a URL send, usage row ordinal 0). Every miss
 * degrades to the text send — never a throw, never a second send.
 *
 * ADR-0071 — the editorial album: when 2..4 source items carry distinct
 * images, the scheduler sends ONE media group (caption on the first
 * photo only) with per-ordinal delivery records + usage bindings, and
 * the shape-aware evidence check heals only on the exact ordinal set.
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
  // One source row per item (a multi-photo story needs several items in
  // one test — the id is per-item, never shared).
  const sourceId = `src-${id}`;
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, attribution_template, config_json,
            created_at, updated_at)
          VALUES (?, 'Photo Source', 'rss', 'editorial', 30, 1, 3600, 50, 100, 'threshold', NULL, '{}', ?, ?)`,
    params: [sourceId, NOW_MORNING, NOW_MORNING],
  });
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, ?, ?, 'Photo item', 'body', NULL, ?, ?, 'hash-photo', ?, 'processed')`,
    params: [
      id,
      sourceId,
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
  imageUrl: string = IMAGE_URL,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO media_assets (id, source_item_id, type, canonical_url, source_url, mime_type,
            width, height, duration_seconds, file_size, sha256, visual_key, rights_status,
            attribution, r2_key, telegram_file_id, status, expires_at, created_at, updated_at)
          VALUES (?, ?, 'photo', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'cdn.example.com',
            NULL, ?, 'validated', NULL, ?, ?)`,
    params: [id, itemId, imageUrl, imageUrl, rightsStatus, fileId, NOW_MORNING, NOW_MORNING],
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

interface MediaGroupCall {
  readonly chatId: number | string;
  readonly items: readonly { readonly media: string; readonly captionText: string | null }[];
}

interface MediaGroupReplyItem {
  readonly messageId: number;
  readonly fileId?: string;
}

function makeTransport(
  photoFileId: string | undefined = 'file-abc',
  options: {
    /** False = the transport has no media-group seam (the album degrades). */
    readonly withMediaGroup?: boolean;
    /** Fixed reply for the media-group send (the shape-gate test). */
    readonly mediaGroupReply?: readonly MediaGroupReplyItem[];
  } = {},
) {
  const messageCalls: MessageCall[] = [];
  const photoCalls: PhotoCall[] = [];
  const mediaGroupCalls: MediaGroupCall[] = [];
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
    ...(options.withMediaGroup === false
      ? {}
      : {
          async sendMediaGroupRich(input: {
            readonly chatId: number | string;
            readonly items: readonly {
              readonly type: 'photo';
              readonly media: string;
              readonly caption?: {
                readonly kind: string;
                readonly text: string;
                readonly entities: readonly unknown[];
              };
            }[];
          }) {
            mediaGroupCalls.push({
              chatId: input.chatId,
              items: input.items.map((item) => ({
                media: item.media,
                captionText: item.caption?.text ?? null,
              })),
            });
            if (options.mediaGroupReply !== undefined) {
              return options.mediaGroupReply;
            }
            return input.items.map((item, ordinal) => ({
              messageId: 200 + ordinal,
              fileId: `file-mg-${ordinal}`,
            }));
          },
        }),
  };
  return { transport, messageCalls, photoCalls, mediaGroupCalls };
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

describe('publication-94 photo send (ADR-0068)', () => {
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

  it('trims the caption to 1024 units and still sends the photo when the rendered text is too long for a caption (ADR-0071)', async () => {
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

    // ADR-0071 (owner order 2026-11-22: trim if needed, never a second
    // send): the 1024-unit caption cap trims the caption — the photo is
    // KEPT, and the text fallback happens only when no photo exists.
    expect(report.details[0]).toMatchObject({ publicationId: 'pub-photo-5', outcome: 'sent' });
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_URL);
    expect(photoCalls[0]?.captionText).not.toBeNull();
    expect(photoCalls[0]?.captionText?.length).toBeLessThanOrEqual(1024);
    expect(photoCalls[0]?.captionText).toContain('تیتر خبر گیمینگ');
    expect(photoCalls[0]?.captionText).toContain('…');
  });
});

async function insertPublicationMessage(
  publicationId: string,
  messageId: number,
  ordinal: number,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO publication_messages (publication_id, chat_id, message_id, media_group_id, ordinal, text_hash, created_at)
          VALUES (?, ?, ?, NULL, ?, NULL, ?)`,
    params: [publicationId, DESTINATION, messageId, ordinal, NOW_MORNING],
  });
}

async function readUsages(publicationId: string) {
  const usages = await executor.query<{ media_asset_id: string; ordinal: number }>({
    sql: 'SELECT media_asset_id, ordinal FROM media_usages WHERE publication_id = ? ORDER BY ordinal ASC',
    params: [publicationId],
  });
  return usages.rows;
}

describe('publication-94 editorial album (ADR-0071)', () => {
  const IMAGE_B = 'https://cdn.example.com/b.jpg';
  const IMAGE_C = 'https://cdn.example.com/c.jpg';
  const IMAGE_D = 'https://cdn.example.com/d.jpg';
  const IMAGE_E = 'https://cdn.example.com/e.jpg';

  async function insertTwoPhotoStory(storyId: string): Promise<void> {
    await insertStory(storyId);
    await insertDraft(`d-${storyId}`, storyId);
    await insertSourceItem(
      `item-${storyId}-1`,
      storyId,
      IMAGE_URL,
      'https://example.com/article-1',
    );
    await insertSourceItem(`item-${storyId}-2`, storyId, IMAGE_B, 'https://example.com/article-2');
    await insertAsset(`asset-${storyId}-1`, `item-${storyId}-1`, 'attribution_required');
    await insertAsset(
      `asset-${storyId}-2`,
      `item-${storyId}-2`,
      'attribution_required',
      null,
      IMAGE_B,
    );
  }

  it('sends one media group of 2 photos, caption on the first only, records both ordinals + usages, saves file_ids', async () => {
    await insertTwoPhotoStory('album-1');
    const { transport, messageCalls, photoCalls, mediaGroupCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-album-1',
      draftId: 'd-album-1',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-album-1', outcome: 'sent' });
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);
    expect(mediaGroupCalls).toHaveLength(1);
    expect(mediaGroupCalls[0]?.items).toHaveLength(2);
    expect(mediaGroupCalls[0]?.items[0]).toEqual({
      media: IMAGE_URL,
      captionText: expect.stringContaining('تیتر خبر گیمینگ'),
    });
    expect(mediaGroupCalls[0]?.items[1]).toEqual({ media: IMAGE_B, captionText: null });

    const row = await findPublicationById(executor, 'pub-album-1');
    expect(row?.status).toBe('published');
    const messages = await listPublicationMessages(executor, 'pub-album-1');
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => [m.ordinal, m.message_id])).toEqual([
      [0, 200],
      [1, 201],
    ]);
    expect(await readUsages('pub-album-1')).toEqual([
      { media_asset_id: 'asset-album-1-1', ordinal: 0 },
      { media_asset_id: 'asset-album-1-2', ordinal: 1 },
    ]);
    const assets = await executor.query<{
      id: string;
      status: string;
      telegram_file_id: string | null;
    }>({
      sql: `SELECT id, status, telegram_file_id FROM media_assets WHERE id LIKE 'asset-album-1-%' ORDER BY id ASC`,
      params: [],
    });
    expect(assets.rows).toEqual([
      { id: 'asset-album-1-1', status: 'uploaded', telegram_file_id: 'file-mg-0' },
      { id: 'asset-album-1-2', status: 'uploaded', telegram_file_id: 'file-mg-1' },
    ]);
  });

  it('caps the album at 4 photos when 5 source items carry images', async () => {
    await insertStory('album-2');
    await insertDraft('d-album-2', 'album-2');
    const urls = [IMAGE_URL, IMAGE_B, IMAGE_C, IMAGE_D, IMAGE_E];
    for (let index = 0; index < urls.length; index += 1) {
      const n = index + 1;
      await insertSourceItem(
        `item-album-2-${n}`,
        'album-2',
        urls[index]!,
        `https://example.com/article-${n}`,
      );
      await insertAsset(
        `asset-album-2-${n}`,
        `item-album-2-${n}`,
        'attribution_required',
        null,
        urls[index]!,
      );
    }
    const { transport, mediaGroupCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-album-2',
      draftId: 'd-album-2',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-album-2', outcome: 'sent' });
    expect(mediaGroupCalls).toHaveLength(1);
    expect(mediaGroupCalls[0]?.items.map((item) => item.media)).toEqual([
      IMAGE_URL,
      IMAGE_B,
      IMAGE_C,
      IMAGE_D,
    ]);
    const messages = await listPublicationMessages(executor, 'pub-album-2');
    expect(messages).toHaveLength(4);
  });

  it('sends a single photo when only one of several items carries an image', async () => {
    await insertStory('album-3');
    await insertDraft('d-album-3', 'album-3');
    await insertSourceItem('item-album-3-1', 'album-3', IMAGE_URL, 'https://example.com/article-1');
    await insertSourceItem('item-album-3-2', 'album-3', null, 'https://example.com/article-2');
    await insertAsset('asset-album-3-1', 'item-album-3-1', 'attribution_required');
    const { transport, photoCalls, mediaGroupCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-album-3',
      draftId: 'd-album-3',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-album-3', outcome: 'sent' });
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_URL);
    expect(mediaGroupCalls).toHaveLength(0);
  });

  it('dedupes a repeated image URL to a single photo', async () => {
    await insertStory('album-4');
    await insertDraft('d-album-4', 'album-4');
    await insertSourceItem('item-album-4-1', 'album-4', IMAGE_URL, 'https://example.com/article-1');
    await insertSourceItem('item-album-4-2', 'album-4', IMAGE_URL, 'https://example.com/article-2');
    await insertAsset('asset-album-4-1', 'item-album-4-1', 'attribution_required');
    const { transport, photoCalls, mediaGroupCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-album-4',
      draftId: 'd-album-4',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-album-4', outcome: 'sent' });
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_URL);
    expect(mediaGroupCalls).toHaveLength(0);
  });

  it('skips a rights-blocked URL and sends the usable photo alone', async () => {
    await insertStory('album-5');
    await insertDraft('d-album-5', 'album-5');
    await insertSourceItem('item-album-5-1', 'album-5', IMAGE_URL, 'https://example.com/article-1');
    await insertSourceItem('item-album-5-2', 'album-5', IMAGE_B, 'https://example.com/article-2');
    await insertAsset('asset-album-5-1', 'item-album-5-1', 'blocked');
    await insertAsset('asset-album-5-2', 'item-album-5-2', 'attribution_required', null, IMAGE_B);
    const { transport, photoCalls, mediaGroupCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-album-5',
      draftId: 'd-album-5',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-album-5', outcome: 'sent' });
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_B);
    expect(mediaGroupCalls).toHaveLength(0);
  });

  it('degrades to a single photo with the first image when the transport has no media-group seam', async () => {
    await insertTwoPhotoStory('album-6');
    const { transport, photoCalls, mediaGroupCalls } = makeTransport(undefined, {
      withMediaGroup: false,
    });
    await enqueuePublication(executor, {
      publicationId: 'pub-album-6',
      draftId: 'd-album-6',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-album-6', outcome: 'sent' });
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_URL);
    expect(mediaGroupCalls).toHaveLength(0);
  });

  it('parks uncertain with no ledger write when the media-group reply shape is wrong', async () => {
    await insertTwoPhotoStory('album-7');
    const { transport, mediaGroupCalls } = makeTransport(undefined, {
      mediaGroupReply: [{ messageId: 200 }],
    });
    await enqueuePublication(executor, {
      publicationId: 'pub-album-7',
      draftId: 'd-album-7',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-album-7',
      outcome: 'failed_unconfirmed',
      code: 'response_media_group_shape_invalid',
    });
    expect(mediaGroupCalls).toHaveLength(1);
    const messages = await listPublicationMessages(executor, 'pub-album-7');
    expect(messages).toHaveLength(0);
  });

  it('heals from a complete album proof and reconciles the missing usage binding', async () => {
    await insertTwoPhotoStory('album-8');
    const { transport, messageCalls, photoCalls, mediaGroupCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-album-8',
      draftId: 'd-album-8',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    // A crashed earlier generation recorded both ordinals but died
    // before the usage binding landed.
    await insertPublicationMessage('pub-album-8', 301, 0);
    await insertPublicationMessage('pub-album-8', 302, 1);
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-album-8',
      outcome: 'healed_from_evidence',
    });
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);
    expect(mediaGroupCalls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-album-8');
    expect(row?.status).toBe('published');
    expect(await readUsages('pub-album-8')).toEqual([
      { media_asset_id: 'asset-album-8-1', ordinal: 0 },
      { media_asset_id: 'asset-album-8-2', ordinal: 1 },
    ]);
  });

  it('parks a partial album proof instead of healing or re-sending', async () => {
    await insertStory('album-9');
    await insertDraft('d-album-9', 'album-9');
    const urls = [IMAGE_URL, IMAGE_B, IMAGE_C];
    for (let index = 0; index < urls.length; index += 1) {
      const n = index + 1;
      await insertSourceItem(
        `item-album-9-${n}`,
        'album-9',
        urls[index]!,
        `https://example.com/article-${n}`,
      );
      await insertAsset(
        `asset-album-9-${n}`,
        `item-album-9-${n}`,
        'attribution_required',
        null,
        urls[index]!,
      );
    }
    const { transport, mediaGroupCalls } = makeTransport();
    await enqueuePublication(executor, {
      publicationId: 'pub-album-9',
      draftId: 'd-album-9',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    // Only ordinals 0..1 of a 3-photo album were recorded.
    await insertPublicationMessage('pub-album-9', 301, 0);
    await insertPublicationMessage('pub-album-9', 302, 1);
    const report = await buildScheduler(transport).scanDuePublications();

    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-album-9',
      outcome: 'failed_unconfirmed',
      code: 'album_evidence_incomplete',
    });
    expect(mediaGroupCalls).toHaveLength(0);
  });
});
