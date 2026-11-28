import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
  type PublicationChannelTransport,
} from '../../src/application/publishing/scheduler';
import { checkPublishGate, setDailyCap } from '../../src/adapters/db/publishing-settings-store';
import { isValidDailyCap } from '../../src/domain/publishing/publishing-settings';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * ADR-0079 §§3.3/3.5/3.6 — the content-quality gates at the scheduler,
 * over REAL workerd D1:
 *
 *  - §3.3: an already-enqueued stale row dead-letters (no send) with a
 *    `quality_rejections` row; in decision-only mode the same row is
 *    observed as `decision_only`/`stale` with ZERO writes.
 *  - §3.5: the fairness slot — nine due P1s from provider A plus one
 *    due P2 from provider B sends the P2 (the tick's one slot goes to
 *    the different provider); the P1 tiebreak — two due P1s from
 *    different providers send the higher-source-priority one first.
 *  - §3.6: a successful send increments the publication-scope
 *    `budgets.daily_posts` counter in today's Tehran bucket, and the
 *    gate refuses at the cap (cap 6 set via `setDailyCap`, counted 6
 *    → `cap_reached`; P0 still bypasses).
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window. */
const NOW_MORNING = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';
const ACTOR_ID = 126679582;

let clock: MutableClock;

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

/**
 * The render wraps Latin segments in Persian text with bidi isolation
 * marks (U+2066/U+2069) — strip them before asserting on a headline
 * that mixes scripts, so the test reads the words, not the marks.
 */
function stripBidi(text: string): string {
  return text.replace(/[\u2066-\u2069\u200E\u200F]/g, '');
}

interface SendCall {
  readonly chatId: number | string;
  readonly text: string;
}

function makeTransport(): PublicationChannelTransport & { readonly calls: readonly SendCall[] } {
  const calls: SendCall[] = [];
  let nextMessageId = 7000;
  return {
    calls,
    async sendMessageRich(input) {
      calls.push({ chatId: input.chatId, text: input.content.text });
      return { messageId: nextMessageId++ };
    },
  };
}

function buildScheduler(transport: PublicationChannelTransport | undefined, gateEnabled: boolean) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport,
    sendGate: { enabled: gateEnabled },
    contextProvider: createStoriesPolicyContextProvider(executor),
    clock,
    logger: silentLogger(),
    scanLimit: 10,
  });
}

async function seedSource(input: {
  readonly id: string;
  readonly name: string;
  readonly lane: 'official' | 'editorial';
  readonly priority: number;
}): Promise<void> {
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, ?, 'rss', ?, 80, 1, 3600, ?, 100, 'auto', '{}', ?, ?)`,
    params: [input.id, input.name, input.lane, input.priority, NOW_MORNING, NOW_MORNING],
  });
}

async function seedDueRow(input: {
  readonly storyId: string;
  readonly draftId: string;
  readonly pubId: string;
  readonly sourceId: string;
  readonly itemId: string;
  readonly headline: string;
  readonly priority: number;
  readonly publishedAtMs: number;
  readonly createdAtMs?: number;
}): Promise<void> {
  const contentHash = `hash-${input.itemId}`;
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', 'industry', 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [
      input.storyId,
      `key-${input.storyId}`,
      NOW_MORNING,
      NOW_MORNING,
      NOW_MORNING,
      NOW_MORNING,
    ],
  });
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt,
            author, published_at, fetched_at, content_hash, raw_json, processing_status)
          VALUES (?, ?, ?, ?, ?, 'excerpt', NULL, ?, ?, ?, '{}', 'processed')`,
    params: [
      input.itemId,
      input.sourceId,
      `ext-${input.itemId}`,
      `https://example.com/news/${input.itemId}/`,
      input.headline,
      input.publishedAtMs,
      NOW_MORNING,
      contentHash,
    ],
  });
  await executor.run({
    sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
            normalized_value, confidence, status, created_at, updated_at)
          VALUES (?, ?, 'source_report', 'game', 'announced', 'a game', NULL, 80, 'supported', ?, ?)`,
    params: [`claim-${input.itemId}`, input.storyId, NOW_MORNING, NOW_MORNING],
  });
  await executor.run({
    sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
          VALUES (?, ?, ?, 'supports', 80, NULL, ?)`,
    params: [`ev-${input.itemId}`, `claim-${input.itemId}`, input.itemId, NOW_MORNING],
  });
  const document = {
    schemaVersion: 1,
    headlineFa: input.headline,
    summaryFa: 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
    modelClaims: [],
  };
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'approved', 'fa', 'standard', ?, ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [
      input.draftId,
      input.storyId,
      input.headline,
      JSON.stringify(document),
      NOW_MORNING,
      NOW_MORNING,
    ],
  });
  await executor.run({
    sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
            scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
            max_attempts, idempotency_key, last_error, created_at, updated_at, soul_version)
          VALUES (?, ?, ?, 'pending', ?, 'auto', NULL, ?, NULL, NULL, NULL, 0,
            3, ?, NULL, ?, ?, 1)`,
    params: [
      input.pubId,
      input.storyId,
      input.draftId,
      input.priority,
      NOW_MORNING,
      `key-${input.pubId}`,
      input.createdAtMs ?? NOW_MORNING - 2 * 3_600_000,
      NOW_MORNING,
    ],
  });
}

async function readPublicationStatus(pubId: string): Promise<string | null> {
  const rows = await executor.query<{ status: string }>({
    sql: 'SELECT status FROM publications WHERE id = ?',
    params: [pubId],
  });
  return rows.rows[0]?.status ?? null;
}

async function readPublicationRunAfter(pubId: string): Promise<number | null> {
  const rows = await executor.query<{ run_after: number }>({
    sql: 'SELECT run_after FROM publications WHERE id = ?',
    params: [pubId],
  });
  return rows.rows[0]?.run_after ?? null;
}

async function readQualityRejections(): Promise<
  readonly { id: string; fingerprint: string; reason: string }[]
> {
  const rows = await executor.query<{ id: string; fingerprint: string; reason: string }>({
    sql: 'SELECT id, fingerprint, reason FROM quality_rejections ORDER BY id ASC',
  });
  return rows.rows;
}

async function readDailyPosts(bucketDate: string): Promise<number> {
  const rows = await executor.query<{ requests: number }>({
    sql: `SELECT requests FROM budgets
           WHERE scope = 'publication' AND budget_key = 'daily_posts' AND bucket_date = ?`,
    params: [bucketDate],
  });
  return rows.rows[0]?.requests ?? 0;
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
    'budgets',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  clock = fixedClock(NOW_MORNING);
});

describe('scheduler freshness gate (ADR-0079 §3.3)', () => {
  it('dead-letters an already-enqueued stale row (no send) and records the rejection', async () => {
    await seedSource({ id: 'src-a', name: 'Provider A', lane: 'official', priority: 80 });
    await seedDueRow({
      storyId: 's-stale',
      draftId: 'd-stale',
      pubId: 'pub-stale',
      sourceId: 'src-a',
      itemId: 'item-stale',
      headline: 'خبر کهنه',
      priority: 80,
      publishedAtMs: NOW_MORNING - 72 * 3_600_000,
    });
    const transport = makeTransport();
    const report = await buildScheduler(transport, true).scanDuePublications();
    expect(transport.calls).toHaveLength(0);
    expect(await readPublicationStatus('pub-stale')).toBe('dead_letter');
    const staleDetail = report.details.find((detail) => detail.publicationId === 'pub-stale');
    expect(staleDetail?.outcome).toBe('dead_lettered');
    expect(staleDetail?.code).toBe('stale');
    const rejections = await readQualityRejections();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.id).toBe('qr:stale:d-stale');
    expect(rejections[0]?.fingerprint).toBe('stale:hash-item-stale');
    expect(rejections[0]?.reason).toBe('stale_source_age');
  });

  it('decision-only mode observes the same stale row with zero writes', async () => {
    await seedSource({ id: 'src-a', name: 'Provider A', lane: 'official', priority: 80 });
    await seedDueRow({
      storyId: 's-stale',
      draftId: 'd-stale',
      pubId: 'pub-stale',
      sourceId: 'src-a',
      itemId: 'item-stale',
      headline: 'خبر کهنه',
      priority: 80,
      publishedAtMs: NOW_MORNING - 72 * 3_600_000,
    });
    const transport = makeTransport();
    const report = await buildScheduler(transport, false).scanDuePublications();
    expect(report.decisionOnly).toBe(true);
    expect(transport.calls).toHaveLength(0);
    expect(await readPublicationStatus('pub-stale')).toBe('pending');
    const staleDetail = report.details.find((detail) => detail.publicationId === 'pub-stale');
    expect(staleDetail?.outcome).toBe('decision_only');
    expect(staleDetail?.code).toBe('stale');
    expect(await readQualityRejections()).toHaveLength(0);
  });
});

describe('scheduler fairness slot and P1 tiebreak (ADR-0079 §3.5)', () => {
  it('§4: nine due P1s from provider A plus one due P2 from provider B sends the P2', async () => {
    await seedSource({ id: 'src-a', name: 'Provider A', lane: 'official', priority: 80 });
    await seedSource({ id: 'src-b', name: 'Provider B', lane: 'editorial', priority: 50 });
    for (let index = 0; index < 9; index += 1) {
      await seedDueRow({
        storyId: `s-a${index}`,
        draftId: `d-a${index}`,
        pubId: `pub-a${index}`,
        sourceId: 'src-a',
        itemId: `item-a${index}`,
        headline: `خبر P1 شماره ${index}`,
        priority: 80,
        publishedAtMs: NOW_MORNING - 3_600_000,
      });
    }
    await seedDueRow({
      storyId: 's-b0',
      draftId: 'd-b0',
      pubId: 'pub-b0',
      sourceId: 'src-b',
      itemId: 'item-b0',
      headline: 'خبر P2 تنها',
      priority: 62,
      publishedAtMs: NOW_MORNING - 3_600_000,
    });
    const transport = makeTransport();
    const report = await buildScheduler(transport, true).scanDuePublications();
    // Exactly one send this tick — and it is the P2 from provider B.
    expect(transport.calls).toHaveLength(1);
    expect(stripBidi(transport.calls[0]?.text ?? '')).toContain('خبر P2 تنها');
    expect(await readPublicationStatus('pub-b0')).toBe('published');
    const sentDetail = report.details.find((detail) => detail.publicationId === 'pub-b0');
    expect(sentDetail?.outcome).toBe('sent');
    // Every P1 deferred on the gap behind the fairness send — none sent.
    for (let index = 0; index < 9; index += 1) {
      expect(await readPublicationStatus(`pub-a${index}`)).toBe('pending');
      const runAfter = await readPublicationRunAfter(`pub-a${index}`);
      expect(runAfter).not.toBeNull();
      expect(runAfter!).toBeGreaterThan(NOW_MORNING);
    }
  });

  it('P1-only due sets behave exactly as before: the higher-source-priority P1 sends first', async () => {
    await seedSource({
      id: 'src-psblog',
      name: 'PlayStation Blog',
      lane: 'official',
      priority: 80,
    });
    await seedSource({ id: 'src-editorial', name: 'Editorial', lane: 'editorial', priority: 60 });
    await seedDueRow({
      storyId: 's-ed',
      draftId: 'd-ed',
      pubId: 'pub-ed',
      sourceId: 'src-editorial',
      itemId: 'item-ed',
      headline: 'خبر ادیتوریال',
      priority: 80,
      publishedAtMs: NOW_MORNING - 3_600_000,
    });
    await seedDueRow({
      storyId: 's-ps',
      draftId: 'd-ps',
      pubId: 'pub-ps',
      sourceId: 'src-psblog',
      itemId: 'item-ps',
      headline: 'خبر پلی‌استیشن',
      priority: 80,
      publishedAtMs: NOW_MORNING - 3_600_000,
    });
    const transport = makeTransport();
    const report = await buildScheduler(transport, true).scanDuePublications();
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.text).toContain('خبر پلی‌استیشن');
    expect(await readPublicationStatus('pub-ps')).toBe('published');
    expect(await readPublicationStatus('pub-ed')).toBe('pending');
    const sentDetail = report.details.find((detail) => detail.publicationId === 'pub-ps');
    expect(sentDetail?.outcome).toBe('sent');
  });
});

describe('scheduler daily cap wiring (ADR-0079 §3.6)', () => {
  it('a successful send increments budgets.daily_posts in today’s Tehran bucket', async () => {
    await seedSource({ id: 'src-a', name: 'Provider A', lane: 'official', priority: 80 });
    await seedDueRow({
      storyId: 's-one',
      draftId: 'd-one',
      pubId: 'pub-one',
      sourceId: 'src-a',
      itemId: 'item-one',
      headline: 'خبر تنها',
      priority: 80,
      publishedAtMs: NOW_MORNING - 3_600_000,
    });
    expect(await readDailyPosts('2023-11-15')).toBe(0);
    const transport = makeTransport();
    const report = await buildScheduler(transport, true).scanDuePublications();
    expect(transport.calls).toHaveLength(1);
    expect(report.details[0]?.outcome).toBe('sent');
    // The counter is the wiring proof: without the recordPublication
    // call a send leaves no budgets row at all.
    expect(await readDailyPosts('2023-11-15')).toBe(1);
  });

  it('the cap bound admits 6 (and 15/18) and rejects 5', () => {
    expect(isValidDailyCap(6)).toBe(true);
    expect(isValidDailyCap(15)).toBe(true);
    expect(isValidDailyCap(18)).toBe(true);
    expect(isValidDailyCap(5)).toBe(false);
    expect(isValidDailyCap(19)).toBe(false);
  });

  it('setDailyCap(6) applies from the next Tehran day, and the gate refuses at the cap (P0 bypasses)', async () => {
    const outcome = await setDailyCap(executor, { cap: 6, actorId: ACTOR_ID, nowMs: NOW_MORNING });
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.effectiveFrom).toBe('2023-11-16');
    expect(await setDailyCap(executor, { cap: 5, actorId: ACTOR_ID, nowMs: NOW_MORNING })).toEqual({
      kind: 'invalid',
    });
    // Six counted posts on the effective day, then the gate refuses.
    const nextDay = NOW_MORNING + 24 * 3_600_000;
    await executor.run({
      sql: `INSERT INTO budgets (scope, budget_key, bucket_date, requests, input_tokens, output_tokens, bytes_transferred, updated_at)
            VALUES ('publication', 'daily_posts', '2023-11-16', 6, 0, 0, 0, ?)`,
      params: [nextDay],
    });
    const atCap = await checkPublishGate(executor, { priority: 'p1', nowMs: nextDay });
    expect(atCap.cap).toBe(6);
    expect(atCap.counted).toBe(6);
    expect(atCap.decision).toEqual({ allowed: false, reason: 'cap_reached' });
    const p0AtCap = await checkPublishGate(executor, { priority: 'p0', nowMs: nextDay });
    expect(p0AtCap.decision.allowed).toBe(true);
    const belowCap = await checkPublishGate(executor, { priority: 'p1', nowMs: NOW_MORNING });
    expect(belowCap.decision.allowed).toBe(true);
  });
});
