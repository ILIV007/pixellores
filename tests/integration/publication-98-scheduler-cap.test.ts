import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  enqueuePublication,
  findPublicationById,
} from '../../src/adapters/db/publication-outbox-store';
import {
  readTodayCounts,
  recordPublication,
} from '../../src/adapters/db/publishing-settings-store';
import {
  createPublicationScheduler,
  createStoriesPolicyContextProvider,
  type PublicationChannelTransport,
} from '../../src/application/publishing/scheduler';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';

/**
 * ADR-0084 — the daily publication cap binds at the scheduler's send
 * terminal. The harness mirrors publication-82 (real workerd D1, real
 * policy, fake Telegram transport); the only additions are the settings
 * + budgets rows the gate reads.
 *
 * Proven here:
 *  - cap reached (6 counted of cap 6) → an autonomous (safe_auto) row
 *    is DEFERRED with code `cap_reached`: zero sends, the claim is
 *    released with the attempt restored, re-evaluation in 10 minutes;
 *  - under cap (5 of 6) → the same row sends and the counted bucket
 *    moves to 6;
 *  - an owner (approval-mode) row sends AT the cap — the check never
 *    applies to it (cap-exempt, PR #36 owner bucket).
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

/** Tehran 10:00:00 on 2023-11-15 — inside the morning_scan window (09:30–11:30). */
const NOW_MORNING = 1_700_029_800_000;

const DESTINATION = '@pixel_lores';
const CAP = 6;
/** 10-minute policy-defer re-evaluation (POLICY_DEFER_REEVALUATE_MS). */
const REEVALUATE_MS = 10 * 60_000;

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

async function insertDraft(id: string, storyId: string): Promise<void> {
  const document = {
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
    modelClaims: [],
  };
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'approved', 'fa', 'standard', 'تیتر خبر گیمینگ', ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [id, storyId, JSON.stringify(document), NOW_MORNING, NOW_MORNING],
  });
}

/** Seed settings.publishing.daily_cap = cap (changed on a different Tehran day, so it is effective today). */
async function seedCap(cap: number): Promise<void> {
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES ('publishing.daily_cap', ?, 1, NULL, ?)`,
    params: [
      JSON.stringify({ cap, previous_cap: cap, changed_tehran_date: '2023-11-14' }),
      NOW_MORNING,
    ],
  });
}

/** Fill today's counted bucket with `count` publications (the real counter, not a forged row). */
async function fillCounted(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await recordPublication(executor, { isP0: false, nowMs: NOW_MORNING });
  }
}

function makeTransport(): PublicationChannelTransport & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async sendMessageRich() {
      calls += 1;
      return { messageId: 101 };
    },
  };
}

function buildScheduler(transport: PublicationChannelTransport) {
  return createPublicationScheduler({
    executor,
    destination: DESTINATION,
    transport,
    sendGate: { enabled: true },
    contextProvider: createStoriesPolicyContextProvider(executor),
    clock,
    logger: silentLogger(),
    scanLimit: 10,
  });
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await db.prepare('DELETE FROM publication_messages').run();
  await db.prepare('DELETE FROM publications').run();
  await db.prepare('DELETE FROM drafts').run();
  await db.prepare('DELETE FROM stories').run();
  await db.prepare('DELETE FROM settings').run();
  await db.prepare('DELETE FROM budgets').run();
  clock = fixedClock(NOW_MORNING);
});

describe('publishing-98 scheduler cap binding (ADR-0084)', () => {
  it('cap reached → autonomous row deferred with cap_reached, no send, attempt restored', async () => {
    await seedCap(CAP);
    await fillCounted(CAP);
    await insertStory('s-cap');
    await insertDraft('d-cap', 's-cap');
    await enqueuePublication(executor, {
      publicationId: 'pub-cap',
      draftId: 'd-cap',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const transport = makeTransport();
    const scheduler = buildScheduler(transport);
    const report = await scheduler.scanDuePublications();

    expect(report.dueCount).toBe(1);
    expect(report.details).toHaveLength(1);
    expect(report.details[0]).toMatchObject({
      publicationId: 'pub-cap',
      outcome: 'deferred_policy',
      code: 'cap_reached',
    });
    expect(transport.calls).toBe(0);

    const row = await findPublicationById(executor, 'pub-cap');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.run_after).toBe(NOW_MORNING + REEVALUATE_MS);
    expect((await readTodayCounts(executor, { nowMs: NOW_MORNING })).counted).toBe(CAP);
  });

  it('under cap → autonomous row sends and the counted bucket moves to the cap', async () => {
    await seedCap(CAP);
    await fillCounted(CAP - 1);
    await insertStory('s-under');
    await insertDraft('d-under', 's-under');
    await enqueuePublication(executor, {
      publicationId: 'pub-under',
      draftId: 'd-under',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'safe_auto',
      nowMs: clock.now(),
    });
    const transport = makeTransport();
    const scheduler = buildScheduler(transport);
    const report = await scheduler.scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-under', outcome: 'sent' });
    expect(transport.calls).toBe(1);
    const row = await findPublicationById(executor, 'pub-under');
    expect(row?.status).toBe('published');
    expect((await readTodayCounts(executor, { nowMs: NOW_MORNING })).counted).toBe(CAP);
  });

  it('owner row sends AT the cap — the check never applies to approval mode', async () => {
    await seedCap(CAP);
    await fillCounted(CAP);
    await insertStory('s-owner');
    await insertDraft('d-owner', 's-owner');
    await enqueuePublication(executor, {
      publicationId: 'pub-owner',
      draftId: 'd-owner',
      destination: DESTINATION,
      priorityScore: 62,
      approvalMode: 'approval',
      nowMs: clock.now(),
    });
    const transport = makeTransport();
    const scheduler = buildScheduler(transport);
    const report = await scheduler.scanDuePublications();

    expect(report.details[0]).toMatchObject({ publicationId: 'pub-owner', outcome: 'sent' });
    expect(transport.calls).toBe(1);
    const row = await findPublicationById(executor, 'pub-owner');
    expect(row?.status).toBe('published');
  });
});
