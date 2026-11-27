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
  type PublicationMediaGroupTransport,
} from '../../src/application/publishing/scheduler';
import type { ImageGenerationServicePort } from '../../src/domain/ai/image-types';
import { AI_IMAGE_DISCLOSURE_LINE } from '../../src/domain/ai/image-policy';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * ADR-0072 — the scheduler's generated-image + editorial-album paths:
 * a no-photo post gets ONE generated image (bytes upload + disclosure
 * in the caption, provenance in the ledger, file_id cached); a refused
 * real photo is NEVER replaced by a generated one; 2..4 source photos
 * go out as ONE media group (real only); every image failure degrades
 * to text; the editorial album heals from recorded evidence.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window (09:30–11:30). */
const NOW_MORNING = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';
const IMAGE_URL_1 = 'https://cdn.example.com/a.jpg';
const IMAGE_URL_2 = 'https://cdn.example.com/b.jpg';

const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

let clock: MutableClock;

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
    sql: `INSERT OR IGNORE INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
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
  imageUrl: string,
  rightsStatus: string,
  fileId: string | null = null,
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

async function enqueue(id: string, draftId: string): Promise<void> {
  await enqueuePublication(executor, {
    publicationId: id,
    draftId,
    destination: DESTINATION,
    priorityScore: 62,
    approvalMode: 'safe_auto',
    nowMs: clock.now(),
  });
}

interface BytesCall {
  readonly byteLength: number;
  readonly contentType: string;
  readonly captionText: string | null;
}

interface MediaGroupCall {
  readonly items: readonly Record<string, unknown>[];
  readonly attachments: readonly unknown[];
  readonly sendIdentityKey: string;
}

interface ChannelMediaGroupCall {
  readonly items: readonly {
    readonly type: string;
    readonly media: string;
    readonly caption?: { readonly text: string };
  }[];
}

function makeImageService(
  mode: 'generated' | 'deferred',
): ImageGenerationServicePort & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generateImage(input) {
      calls += 1;
      if (mode === 'deferred') {
        return { kind: 'deferred', reason: 'provider_unavailable', attempts: [] };
      }
      return {
        kind: 'generated',
        image: {
          bytes: IMAGE_BYTES,
          contentType: 'image/jpeg',
          modelId: '@cf/black-forest-labs/flux-1-schnell',
          prompt: `Cinematic wide shot, cinematic gaming scene, featuring ${input.headline}, no text in image, no logo, no watermark`,
          seed: null,
          neurons: 58,
          sha256Hex: await sha256Hex(IMAGE_BYTES),
        },
        attempts: [],
      };
    },
  };
}

function makeTransport({ withMediaGroup = false }: { withMediaGroup?: boolean } = {}) {
  const messageCalls: { text: string }[] = [];
  const photoCalls: { photo: string; captionText: string | null }[] = [];
  const bytesCalls: BytesCall[] = [];
  const mediaGroupCalls: ChannelMediaGroupCall[] = [];
  const transport: PublicationChannelTransport = {
    async sendMessageRich(input) {
      messageCalls.push({ text: input.content.text });
      return { messageId: 101 };
    },
    async sendPhotoRich(input) {
      photoCalls.push({ photo: input.photo, captionText: input.caption?.text ?? null });
      return { messageId: 102, photoFileId: 'file-abc' };
    },
    async sendPhotoBytesRich(input) {
      bytesCalls.push({
        byteLength: input.photo.bytes.byteLength,
        contentType: input.photo.contentType,
        captionText: input.caption?.text ?? null,
      });
      return { messageId: 103, photoFileId: 'file-gen-1' };
    },
    // ADR-0072 + ADR-0071: the editorial album rides the channel
    // transport's media-group seam (wired in cron); a transport without
    // it degrades the album to its first photo as a single photo.
    ...(withMediaGroup
      ? {
          async sendMediaGroupRich(input: {
            readonly items: readonly {
              readonly type: 'photo';
              readonly media: string;
              readonly caption?: { readonly text: string };
            }[];
          }) {
            mediaGroupCalls.push({ items: input.items });
            return [
              { messageId: 700, fileId: 'file-a1' },
              { messageId: 701, fileId: 'file-a2' },
              { messageId: 702, fileId: 'file-a3' },
              { messageId: 703, fileId: 'file-a4' },
            ].slice(0, input.items.length);
          },
        }
      : {}),
  };
  return { transport, messageCalls, photoCalls, bytesCalls, mediaGroupCalls };
}

function makeMediaTransport() {
  const calls: MediaGroupCall[] = [];
  const transport: PublicationMediaGroupTransport = {
    async sendMediaGroup(input) {
      calls.push({
        items: input.items as unknown as readonly Record<string, unknown>[],
        attachments: input.attachments,
        sendIdentityKey: input.sendIdentityKey,
      });
      return [
        { messageId: 700, fileId: 'file-a1' },
        { messageId: 701, fileId: 'file-a2' },
        { messageId: 702, fileId: 'file-a3' },
        { messageId: 703, fileId: 'file-a4' },
      ].slice(0, input.items.length);
    },
  };
  return { transport, calls };
}

function buildScheduler(
  transport: PublicationChannelTransport,
  imageGeneration: ImageGenerationServicePort | undefined,
  mediaTransport?: PublicationMediaGroupTransport,
) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport,
    mediaAssets: createMediaAssetStore(executor),
    imageGeneration,
    mediaTransport,
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

describe('publication-97 image generation (ADR-0072)', () => {
  it('sends ONE generated image when no source photo exists, with disclosure + provenance + cached file_id', async () => {
    await insertStory('s-gen-1');
    await insertDraft('d-gen-1', 's-gen-1');
    await insertSourceItem('item-gen-1', 's-gen-1', null, 'https://example.com/article-1');
    const imageService = makeImageService('generated');
    const { transport, messageCalls, photoCalls, bytesCalls } = makeTransport();
    await enqueue('pub-gen-1', 'd-gen-1');
    const report = await buildScheduler(transport, imageService).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-gen-1', outcome: 'sent' });
    expect(imageService.calls).toBe(1);
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);
    expect(bytesCalls).toHaveLength(1);
    expect(bytesCalls[0]?.byteLength).toBe(IMAGE_BYTES.byteLength);
    expect(bytesCalls[0]?.contentType).toBe('image/jpeg');
    expect(bytesCalls[0]?.captionText).toContain('تیتر خبر گیمینگ');
    expect(bytesCalls[0]?.captionText).toContain(AI_IMAGE_DISCLOSURE_LINE);

    const row = await findPublicationById(executor, 'pub-gen-1');
    expect(row?.status).toBe('published');
    const messages = await listPublicationMessages(executor, 'pub-gen-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message_id).toBe(103);

    // The ledger: one generated asset with full provenance, the returned
    // file_id cached, and the usage bound at ordinal 0.
    const asset = await executor.first<{
      id: string;
      status: string;
      telegram_file_id: string | null;
      rights_status: string;
      attribution: string | null;
      ai_provider: string | null;
      ai_model: string | null;
      ai_prompt: string | null;
      ai_seed: number | null;
      sha256: string | null;
    }>({
      sql: `SELECT id, status, telegram_file_id, rights_status, attribution, ai_provider, ai_model, ai_prompt, ai_seed, sha256
            FROM media_assets WHERE ai_provider = 'workers-ai'`,
    });
    expect(asset).not.toBeNull();
    expect(asset?.status).toBe('uploaded');
    expect(asset?.telegram_file_id).toBe('file-gen-1');
    expect(asset?.rights_status).toBe('official');
    expect(asset?.attribution).toBe('ai-generated');
    expect(asset?.ai_model).toBe('@cf/black-forest-labs/flux-1-schnell');
    expect(asset?.ai_prompt).toContain('no text in image');
    expect(asset?.ai_seed).toBeNull();
    expect(asset?.sha256).toBe(await sha256Hex(IMAGE_BYTES));
    const usages = await executor.query<{ media_asset_id: string; ordinal: number }>({
      sql: `SELECT media_asset_id, ordinal FROM media_usages WHERE publication_id = ?`,
      params: ['pub-gen-1'],
    });
    expect(usages.rows).toEqual([{ media_asset_id: asset!.id, ordinal: 0 }]);
  });

  it('never generates when a source photo exists (the real photo wins)', async () => {
    await insertStory('s-gen-2');
    await insertDraft('d-gen-2', 's-gen-2');
    await insertSourceItem('item-gen-2', 's-gen-2', IMAGE_URL_1, 'https://example.com/article-2');
    await insertAsset('asset-gen-2', 'item-gen-2', IMAGE_URL_1, 'attribution_required');
    const imageService = makeImageService('generated');
    const { transport, messageCalls, photoCalls, bytesCalls } = makeTransport();
    await enqueue('pub-gen-2', 'd-gen-2');
    const report = await buildScheduler(transport, imageService).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-gen-2', outcome: 'sent' });
    expect(imageService.calls).toBe(0);
    expect(bytesCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_URL_1);
    expect(messageCalls).toHaveLength(0);
  });

  it('never replaces a refused real photo with a generated one (text fallback)', async () => {
    await insertStory('s-gen-3');
    await insertDraft('d-gen-3', 's-gen-3');
    await insertSourceItem('item-gen-3', 's-gen-3', IMAGE_URL_1, 'https://example.com/article-3');
    await insertAsset('asset-gen-3', 'item-gen-3', IMAGE_URL_1, 'blocked');
    const imageService = makeImageService('generated');
    const { transport, messageCalls, photoCalls, bytesCalls } = makeTransport();
    await enqueue('pub-gen-3', 'd-gen-3');
    const report = await buildScheduler(transport, imageService).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-gen-3', outcome: 'sent' });
    expect(imageService.calls).toBe(0);
    expect(bytesCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
  });

  it('degrades to text when generation fails (never blocks the post)', async () => {
    await insertStory('s-gen-4');
    await insertDraft('d-gen-4', 's-gen-4');
    await insertSourceItem('item-gen-4', 's-gen-4', null, 'https://example.com/article-4');
    const imageService = makeImageService('deferred');
    const { transport, messageCalls, photoCalls, bytesCalls } = makeTransport();
    await enqueue('pub-gen-4', 'd-gen-4');
    const report = await buildScheduler(transport, imageService).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-gen-4', outcome: 'sent' });
    expect(imageService.calls).toBe(1);
    expect(bytesCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.text).toContain('تیتر خبر گیمینگ');
    // No generated asset row was written (the ledger insert happens
    // only after a successful generation).
    const assets = await executor.query<{ id: string }>({
      sql: `SELECT id FROM media_assets WHERE ai_provider = 'workers-ai'`,
    });
    expect(assets.rows).toHaveLength(0);
  });

  it('degrades to text without spending generation when the caption cannot fit the disclosure', async () => {
    await insertStory('s-gen-5');
    await insertDraft('d-gen-5', 's-gen-5', 'خ'.repeat(1200));
    await insertSourceItem('item-gen-5', 's-gen-5', null, 'https://example.com/article-5');
    const imageService = makeImageService('generated');
    const { transport, messageCalls, bytesCalls } = makeTransport();
    await enqueue('pub-gen-5', 'd-gen-5');
    const report = await buildScheduler(transport, imageService).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-gen-5', outcome: 'sent' });
    // The caption envelope is validated BEFORE the service call: zero
    // generation spent on a post that cannot carry the disclosure.
    expect(imageService.calls).toBe(0);
    expect(bytesCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
  });

  it('sends text when the image service is not wired (the pre-0070 behavior)', async () => {
    await insertStory('s-gen-6');
    await insertDraft('d-gen-6', 's-gen-6');
    await insertSourceItem('item-gen-6', 's-gen-6', null, 'https://example.com/article-6');
    const { transport, messageCalls, bytesCalls } = makeTransport();
    await enqueue('pub-gen-6', 'd-gen-6');
    const report = await buildScheduler(transport, undefined).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-gen-6', outcome: 'sent' });
    expect(bytesCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
  });

  it('sends 2 source photos as ONE media group (real only, caption ordinal 0)', async () => {
    await insertStory('s-alb-1');
    await insertDraft('d-alb-1', 's-alb-1');
    await insertSourceItem('item-alb-1a', 's-alb-1', IMAGE_URL_1, 'https://example.com/article-a');
    await insertSourceItem('item-alb-1b', 's-alb-1', IMAGE_URL_2, 'https://example.com/article-b');
    await insertAsset('asset-alb-1a', 'item-alb-1a', IMAGE_URL_1, 'attribution_required');
    await insertAsset('asset-alb-1b', 'item-alb-1b', IMAGE_URL_2, 'attribution_required');
    const imageService = makeImageService('generated');
    // ADR-0071 + ADR-0072 (rebase onto PR #32): the editorial album
    // rides the channel transport's media-group seam, not the
    // album-document media seam — the branch's sendClaimedEditorialAlbum
    // routing is superseded by sendEditorialAlbum.
    const { transport, messageCalls, photoCalls, bytesCalls, mediaGroupCalls } = makeTransport({
      withMediaGroup: true,
    });
    await enqueue('pub-alb-1', 'd-alb-1');
    const report = await buildScheduler(transport, imageService).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-alb-1', outcome: 'sent' });
    // No generation: real photos exist.
    expect(imageService.calls).toBe(0);
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);
    expect(bytesCalls).toHaveLength(0);
    expect(mediaGroupCalls).toHaveLength(1);
    const call = mediaGroupCalls[0]!;
    expect(call.items).toHaveLength(2);
    expect(call.items[0]?.media).toBe(IMAGE_URL_1);
    expect(call.items[1]?.media).toBe(IMAGE_URL_2);
    expect(call.items[0]?.caption).toBeDefined();
    expect(call.items[1]?.caption).toBeUndefined();
    expect(call.items[0]?.caption?.text).toContain('تیتر خبر گیمینگ');

    const row = await findPublicationById(executor, 'pub-alb-1');
    expect(row?.status).toBe('published');
    const messages = await listPublicationMessages(executor, 'pub-alb-1');
    expect(messages.map((m) => [m.ordinal, m.message_id])).toEqual([
      [0, 700],
      [1, 701],
    ]);
    const usages = await executor.query<{ media_asset_id: string; ordinal: number }>({
      sql: `SELECT media_asset_id, ordinal FROM media_usages WHERE publication_id = ? ORDER BY ordinal`,
      params: ['pub-alb-1'],
    });
    expect(usages.rows).toEqual([
      { media_asset_id: 'asset-alb-1a', ordinal: 0 },
      { media_asset_id: 'asset-alb-1b', ordinal: 1 },
    ]);
    // URL-sent items saved their returned file_ids.
    const saved = await executor.query<{ telegram_file_id: string | null }>({
      sql: `SELECT telegram_file_id FROM media_assets WHERE id IN ('asset-alb-1a', 'asset-alb-1b') ORDER BY id`,
    });
    expect(saved.rows).toEqual([{ telegram_file_id: 'file-a1' }, { telegram_file_id: 'file-a2' }]);
  });

  it('degrades an album to its first photo as a single photo when the media seam is absent', async () => {
    await insertStory('s-alb-2');
    await insertDraft('d-alb-2', 's-alb-2');
    await insertSourceItem('item-alb-2a', 's-alb-2', IMAGE_URL_1, 'https://example.com/article-a');
    await insertSourceItem('item-alb-2b', 's-alb-2', IMAGE_URL_2, 'https://example.com/article-b');
    await insertAsset('asset-alb-2a', 'item-alb-2a', IMAGE_URL_1, 'attribution_required');
    await insertAsset('asset-alb-2b', 'item-alb-2b', IMAGE_URL_2, 'attribution_required');
    const imageService = makeImageService('generated');
    const { transport, messageCalls, photoCalls, bytesCalls } = makeTransport();
    await enqueue('pub-alb-2', 'd-alb-2');
    // No media-group seam on the transport: the album degrades to its
    // first photo as a single photo (the ADR-0071 fallback).
    const report = await buildScheduler(transport, imageService).scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-alb-2', outcome: 'sent' });
    expect(imageService.calls).toBe(0);
    expect(bytesCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(1);
    expect(photoCalls[0]?.photo).toBe(IMAGE_URL_1);
    const messages = await listPublicationMessages(executor, 'pub-alb-2');
    expect(messages).toHaveLength(1);
  });

  it('heals a completed editorial album from recorded evidence without a second send', async () => {
    await insertStory('s-alb-3');
    await insertDraft('d-alb-3', 's-alb-3');
    await insertSourceItem('item-alb-3a', 's-alb-3', IMAGE_URL_1, 'https://example.com/article-a');
    await insertSourceItem('item-alb-3b', 's-alb-3', IMAGE_URL_2, 'https://example.com/article-b');
    await insertAsset('asset-alb-3a', 'item-alb-3a', IMAGE_URL_1, 'attribution_required');
    await insertAsset('asset-alb-3b', 'item-alb-3b', IMAGE_URL_2, 'attribution_required');
    await enqueue('pub-alb-3', 'd-alb-3');
    // A crashed earlier generation: both ordinals recorded + bound, but
    // the row never reached its terminal.
    await executor.run({
      sql: `INSERT INTO publication_messages (publication_id, chat_id, message_id, media_group_id, ordinal, text_hash, created_at)
            VALUES ('pub-alb-3', ?, 700, NULL, 0, NULL, ?), ('pub-alb-3', ?, 701, NULL, 1, NULL, ?)`,
      params: [DESTINATION, NOW_MORNING, DESTINATION, NOW_MORNING],
    });
    await executor.run({
      sql: `INSERT INTO media_usages (media_asset_id, publication_id, ordinal, created_at)
            VALUES ('asset-alb-3a', 'pub-alb-3', 0, ?), ('asset-alb-3b', 'pub-alb-3', 1, ?)`,
      params: [NOW_MORNING, NOW_MORNING],
    });
    const imageService = makeImageService('generated');
    const { transport, messageCalls, photoCalls, bytesCalls } = makeTransport();
    const media = makeMediaTransport();
    const report = await buildScheduler(
      transport,
      imageService,
      media.transport,
    ).scanDuePublications();

    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-alb-3',
      outcome: 'healed_from_evidence',
    });
    expect(imageService.calls).toBe(0);
    expect(messageCalls).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);
    expect(bytesCalls).toHaveLength(0);
    expect(media.calls).toHaveLength(0);
    const row = await findPublicationById(executor, 'pub-alb-3');
    expect(row?.status).toBe('published');
    const messages = await listPublicationMessages(executor, 'pub-alb-3');
    expect(messages).toHaveLength(2);
  });
});
