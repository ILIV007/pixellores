import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  NOW,
  OWNER_ID,
  captureLogger,
  freshDb,
  seedAdmin,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import { handleWebPanel } from '../../src/entrypoints/http/handlers/web-panel';
import {
  ADMIN_SESSION_COOKIE_NAME,
  issueAdminSession,
} from '../../src/application/web-panel/session';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import { HTTP_STATUS_BY_CODE, toAppError } from '../../src/shared/errors/app-error';
import type { WorkerEnv } from '../../src/shared/types/env';
import type { TelegramLoginData } from '../../src/application/web-panel/telegram-login';

/**
 * ADR-0081 — the site admin panel over REAL workerd D1: the fail-closed
 * flag, the static surface, the Telegram Login auth, the session, every
 * read screen, the mode golden path (flip + audit row + restore), draft
 * approve → outbox → cancel, the provider toggle, the reviewer denial,
 * the honestly-disabled actions, and admin management (read-only while
 * the flag is off, working while on). The ONLY artificial pieces are
 * the fixture bot token/secret (deliberately NOT token-shaped) and the
 * minted session cookies (the same HMAC the handler verifies).
 */

const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const WEBHOOK_SECRET = 'fixture-webhook-secret-for-tests-0123456789';
const REVIEWER_ID = 2000000004;
const TARGET_USER_ID = 2000000009;
const SOURCE_ID = 'gematsu_news';

const BASE_OVERRIDES: Record<string, unknown> = {
  ADMIN_WEB_PANEL_ENABLED: 'true',
  BOT_TOKEN,
  WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  TARGET_CHANNEL: '@pixellores',
  APP_VERSION: '1.49.0',
  APP_COMMIT: '0123456789abcdef0123456789abcdef01234567',
  ENVIRONMENT: 'development',
};

const { logger } = captureLogger();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signedLoginData(
  userId: number,
  authDateSeconds: number,
): Promise<TelegramLoginData> {
  const fields: Record<string, unknown> = {
    id: userId,
    first_name: userId === OWNER_ID ? 'Iliya' : 'Reviewer',
    auth_date: authDateSeconds,
  };
  const entries = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([key, value]) => `${key}=${String(value)}`).join('\n');
  const tokenKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BOT_TOKEN));
  const key = await crypto.subtle.importKey(
    'raw',
    tokenKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hash = toHex(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dataCheckString)),
  );
  return { ...fields, hash } as TelegramLoginData;
}

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> & { kind?: string };
  readonly headers: Headers;
}

async function call(input: {
  readonly method: string;
  readonly path: string;
  readonly envOverride?: Record<string, unknown>;
  readonly cookie?: string;
  readonly body?: unknown;
}): Promise<CallResult> {
  const testEnv = {
    ...env,
    ...BASE_OVERRIDES,
    ...(input.envOverride ?? {}),
  } as unknown as WorkerEnv;
  const headers: Record<string, string> = {};
  if (input.cookie !== undefined) {
    headers.cookie = `${ADMIN_SESSION_COOKIE_NAME}=${input.cookie}`;
  }
  if (input.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const request = new Request(`https://panel.test${input.path}`, {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  let response: Response;
  try {
    response = await handleWebPanel(request, testEnv, { logger });
  } catch (error) {
    // The worker's error path, mirrored: AppError → its HTTP status.
    const appError = toAppError(error);
    const status = HTTP_STATUS_BY_CODE[appError.code] ?? 500;
    return { status, body: { code: appError.code }, headers: new Headers() };
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

async function ownerCookie(): Promise<string> {
  return await issueAdminSession({
    userId: OWNER_ID,
    firstName: 'Iliya',
    secret: WEBHOOK_SECRET,
    nowMs: Date.now(),
  });
}

async function seedSource(): Promise<void> {
  const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled, interval_seconds,
            priority, daily_request_budget, approval_policy, config_json, created_at, updated_at)
          VALUES (?, 'Gematsu', 'gematsu_news', 'official', 90, 1, 3600, 80, 100, 'auto', '{}', ?, ?)`,
    params: [SOURCE_ID, NOW, NOW],
  });
  await executor.run({
    sql: `INSERT INTO source_state (source_id, next_poll_at, last_polled_at, last_success_at,
            last_error, consecutive_failures, updated_at)
          VALUES (?, ?, ?, ?, NULL, 0, ?)`,
    params: [SOURCE_ID, NOW, NOW, NOW, NOW],
  });
}

const DRAFT_DOCUMENT = JSON.stringify({
  headlineFa: 'Test headline',
  summaryFa: 'Test summary.',
  sourceReport: {
    sourceItemId: 'item-1',
    sourceName: 'Gematsu',
    stance: 'mentions',
    excerptText: 'The excerpt.',
    truncated: false,
  },
  modelClaims: [{ text: 'A test claim.', evidenceIds: [], status: 'unverified' }],
});

describe('web panel flag', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('answers the uniform 404 while the flag is off', async () => {
    const shell = await call({
      method: 'GET',
      path: '/admin',
      envOverride: { ADMIN_WEB_PANEL_ENABLED: 'false' },
    });
    expect(shell.status).toBe(404);
    const api = await call({
      method: 'GET',
      path: '/api/admin/dashboard',
      envOverride: { ADMIN_WEB_PANEL_ENABLED: 'false' },
    });
    expect(api.status).toBe(404);
    expect(api.body.code).toBe('not_found');
  });

  it('serves the static shell, script, and stylesheet with the flag on', async () => {
    const shell = await call({ method: 'GET', path: '/admin' });
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');
    expect(shell.headers.get('content-security-policy')).toContain(
      "script-src 'self' https://telegram.org",
    );
    const js = await call({ method: 'GET', path: '/admin/app.js' });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('application/javascript');
    const css = await call({ method: 'GET', path: '/admin/app.css' });
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('requires a session for every API read', async () => {
    const res = await call({ method: 'GET', path: '/api/admin/dashboard' });
    expect(res.status).toBe(401);
  });
});

describe('web panel auth', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('logs the owner in with a valid widget payload and sets the session cookie', async () => {
    const login = await signedLoginData(OWNER_ID, Math.floor(Date.now() / 1000));
    const res = await call({ method: 'POST', path: '/api/admin/auth', body: login });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('owner');
    expect(res.body.userId).toBe(OWNER_ID);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(ADMIN_SESSION_COOKIE_NAME);
    expect(setCookie).toContain('HttpOnly');
    const cookie = setCookie.split(';')[0]?.split('=')[1] ?? '';
    const me = await call({ method: 'GET', path: '/api/admin/me', cookie });
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(OWNER_ID);
    expect(me.body.role).toBe('owner');
  });

  it('rejects a tampered payload, a stale auth_date, and a non-admin user', async () => {
    const valid = await signedLoginData(OWNER_ID, Math.floor(Date.now() / 1000));
    const tampered = await call({
      method: 'POST',
      path: '/api/admin/auth',
      body: { ...valid, first_name: 'Mallory' },
    });
    expect(tampered.status).toBe(401);
    const stale = await signedLoginData(OWNER_ID, Math.floor(Date.now() / 1000) - 25 * 60 * 60);
    expect((await call({ method: 'POST', path: '/api/admin/auth', body: stale })).status).toBe(401);
    const stranger = await signedLoginData(2000000006, Math.floor(Date.now() / 1000));
    expect((await call({ method: 'POST', path: '/api/admin/auth', body: stranger })).status).toBe(
      401,
    );
  });

  it('rejects a tampered session cookie', async () => {
    const cookie = await ownerCookie();
    const bad = `${cookie.slice(0, -2)}AA`;
    expect((await call({ method: 'GET', path: '/api/admin/me', cookie: bad })).status).toBe(401);
  });

  it('logs out by clearing the cookie', async () => {
    const cookie = await ownerCookie();
    const res = await call({ method: 'POST', path: '/api/admin/logout', cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });
});

describe('web panel reads and the mode golden path', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('reads every screen on a fresh database', async () => {
    const cookie = await ownerCookie();
    for (const path of [
      '/api/admin/dashboard',
      '/api/admin/queue',
      '/api/admin/posts',
      '/api/admin/schedule',
      '/api/admin/soul',
      '/api/admin/settings',
      '/api/admin/stats',
      '/api/admin/admins',
      '/api/admin/manual',
      '/api/admin/providers',
      '/api/admin/debug',
    ]) {
      const res = await call({ method: 'GET', path, cookie });
      expect(res.status).toBe(200);
    }
    const dashboard = await call({ method: 'GET', path: '/api/admin/dashboard', cookie });
    expect(dashboard.body.mode).toBe('auto');
    expect(dashboard.body.nextTickInMinutes).toBe(5);
    const soul = await call({ method: 'GET', path: '/api/admin/soul', cookie });
    expect(soul.body.soulVersion).toBeNull();
    expect(soul.body.flags).toMatchObject({ aiEnabled: false, geminiEnabled: false });
  });

  it('runs the golden path: flip the mode, see its audit row, restore it', async () => {
    const cookie = await ownerCookie();
    const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });

    const flipped = await call({
      method: 'POST',
      path: '/api/admin/schedule/mode',
      cookie,
      body: { mode: 'paused' },
    });
    expect(flipped.status).toBe(200);
    expect(flipped.body.kind).toBe('applied');

    const setting = await executor.first<{ value_json: string }>({
      sql: `SELECT value_json FROM settings WHERE key = ?`,
      params: ['publishing.mode'],
    });
    expect(setting).not.toBeNull();
    expect(JSON.parse(setting?.value_json ?? '{}').mode).toBe('paused');
    const audit = await executor.query<{ action: string; actor_id: string; target_id: string }>({
      sql: `SELECT action, actor_id, target_id FROM audit_events WHERE action = ?`,
      params: ['settings.mode_changed'],
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'settings.mode_changed',
      actor_id: String(OWNER_ID),
      target_id: 'publishing.mode',
    });

    const restored = await call({
      method: 'POST',
      path: '/api/admin/schedule/mode',
      cookie,
      body: { mode: 'auto' },
    });
    expect(restored.body.kind).toBe('applied');
    const settingAfter = await executor.first<{ value_json: string }>({
      sql: `SELECT value_json FROM settings WHERE key = ?`,
      params: ['publishing.mode'],
    });
    expect(JSON.parse(settingAfter?.value_json ?? '{}').mode).toBe('auto');
    const auditAfter = await executor.query<{ action: string }>({
      sql: `SELECT action FROM audit_events WHERE action = ?`,
      params: ['settings.mode_changed'],
    });
    expect(auditAfter.rows).toHaveLength(2);
  });

  it('rejects an invalid mode and a bad cap', async () => {
    const cookie = await ownerCookie();
    const badMode = await call({
      method: 'POST',
      path: '/api/admin/schedule/mode',
      cookie,
      body: { mode: 'turbo' },
    });
    expect(badMode.body.kind).toBe('invalid');
    const badCap = await call({
      method: 'POST',
      path: '/api/admin/schedule/cap',
      cookie,
      body: { cap: 0 },
    });
    expect(badCap.body.kind).toBe('invalid');
  });
});

describe('web panel queue flow', () => {
  beforeEach(async () => {
    await freshDb();
    await seedStory('story-1', 'Test story');
    await seedDraft({
      id: 'draft-1',
      storyId: 'story-1',
      title: 'Test headline',
      documentJson: DRAFT_DOCUMENT,
    });
  });

  it('previews a draft, approves it into the outbox, then cancels it', async () => {
    const cookie = await ownerCookie();
    const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });

    const preview = await call({ method: 'GET', path: '/api/admin/drafts/draft-1', cookie });
    expect(preview.status).toBe(200);
    expect(preview.body.headline).toBe('Test headline');
    expect(preview.body.claims).toHaveLength(1);
    expect((await call({ method: 'GET', path: '/api/admin/drafts/nope', cookie })).status).toBe(
      404,
    );

    const approved = await call({
      method: 'POST',
      path: '/api/admin/drafts/draft-1/approve',
      cookie,
      body: {},
    });
    expect(approved.body.kind).toBe('approved');
    expect(approved.body.publicationId).toBe('pub:human:draft-1');
    const publication = await executor.first<{ status: string; draft_id: string }>({
      sql: `SELECT status, draft_id FROM publications WHERE id = ?`,
      params: ['pub:human:draft-1'],
    });
    expect(publication).toMatchObject({ status: 'pending', draft_id: 'draft-1' });

    const queue = await call({ method: 'GET', path: '/api/admin/queue', cookie });
    expect(queue.body.counts).toMatchObject({ ready: 0, pending: 1 });

    const cancelled = await call({
      method: 'POST',
      path: '/api/admin/queue/pub:human:draft-1/cancel',
      cookie,
      body: {},
    });
    expect(cancelled.body.kind).toBe('applied');
    const after = await executor.first<{ status: string }>({
      sql: `SELECT status FROM publications WHERE id = ?`,
      params: ['pub:human:draft-1'],
    });
    expect(after?.status).toBe('cancelled');
  });

  it('rejects a draft', async () => {
    const cookie = await ownerCookie();
    const rejected = await call({
      method: 'POST',
      path: '/api/admin/drafts/draft-1/reject',
      cookie,
      body: {},
    });
    expect(rejected.body.kind).toBe('applied');
    const draft = await createDbExecutor(env.DB, { clock: fixedClock(NOW) }).first<{
      status: string;
    }>({
      sql: `SELECT status FROM drafts WHERE id = ?`,
      params: ['draft-1'],
    });
    expect(draft?.status).toBe('rejected');
  });
});

describe('web panel permissions and honest gaps', () => {
  beforeEach(async () => {
    await freshDb();
    await seedAdmin(REVIEWER_ID, 'reviewer');
    await seedSource();
  });

  it('lets a reviewer read but not mutate', async () => {
    const cookie = await issueAdminSession({
      userId: REVIEWER_ID,
      firstName: 'Reviewer',
      secret: WEBHOOK_SECRET,
      nowMs: Date.now(),
    });
    const read = await call({ method: 'GET', path: '/api/admin/dashboard', cookie });
    expect(read.status).toBe(200);
    const mutation = await call({
      method: 'POST',
      path: '/api/admin/schedule/mode',
      cookie,
      body: { mode: 'paused' },
    });
    expect(mutation.body.kind).toBe('denied');
  });

  it('toggles a provider and writes its audit row', async () => {
    const cookie = await ownerCookie();
    const executor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const providers = await call({ method: 'GET', path: '/api/admin/providers', cookie });
    expect(providers.body.total).toBe(1);
    expect(providers.body.enabled).toBe(1);
    expect(providers.body.healthy).toBe(1);

    const toggled = await call({
      method: 'POST',
      path: `/api/admin/providers/${SOURCE_ID}/toggle`,
      cookie,
      body: { enabled: false },
    });
    expect(toggled.body.kind).toBe('applied');
    const row = await executor.first<{ enabled: number }>({
      sql: `SELECT enabled FROM sources WHERE id = ?`,
      params: [SOURCE_ID],
    });
    expect(row?.enabled).toBe(0);
    const audit = await executor.query<{ action: string; actor_id: string }>({
      sql: `SELECT action, actor_id FROM audit_events WHERE action = ?`,
      params: ['source.enabled'],
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_id).toBe(String(OWNER_ID));
    const missing = await call({
      method: 'POST',
      path: '/api/admin/providers/nope/toggle',
      cookie,
      body: { enabled: false },
    });
    expect(missing.body.kind).toBe('not_found');
  });

  it('answers honestly disabled for Send Now, Force tick, Test AI, and Manual trigger', async () => {
    const cookie = await ownerCookie();
    expect(
      (await call({ method: 'POST', path: '/api/admin/queue/pub:x/send-now', cookie, body: {} }))
        .body,
    ).toMatchObject({ available: false, reason: 'send_now_unavailable' });
    expect(
      (await call({ method: 'POST', path: '/api/admin/schedule/force-tick', cookie, body: {} }))
        .body,
    ).toMatchObject({ available: false, reason: 'force_tick_unavailable' });
    expect(
      (await call({ method: 'POST', path: '/api/admin/soul/test-ai', cookie, body: {} })).body,
    ).toMatchObject({ available: false, reason: 'test_ai_unavailable' });
    expect(
      (
        await call({
          method: 'POST',
          path: `/api/admin/manual/provider/${SOURCE_ID}`,
          cookie,
          body: {},
        })
      ).body,
    ).toMatchObject({ available: false, reason: 'manual_trigger_unavailable' });
    expect(
      (await call({ method: 'POST', path: '/api/admin/manual/dry-run', cookie, body: {} })).body,
    ).toMatchObject({ available: false, reason: 'manual_trigger_unavailable' });
  });

  it('reports transport_unavailable for pin without a bot token', async () => {
    const cookie = await ownerCookie();
    const res = await call({
      method: 'POST',
      path: '/api/admin/posts/pin',
      cookie,
      body: { refType: 'publication', refId: 'pub-1', channelMessageId: 42 },
      envOverride: { BOT_TOKEN: undefined },
    });
    expect(res.body.kind).toBe('transport_unavailable');
  });

  it('reports no_destination for approve without a channel', async () => {
    await seedStory('story-9', 'No channel story');
    await seedDraft({
      id: 'draft-9',
      storyId: 'story-9',
      title: 'T',
      documentJson: DRAFT_DOCUMENT,
    });
    const cookie = await ownerCookie();
    const res = await call({
      method: 'POST',
      path: '/api/admin/drafts/draft-9/approve',
      cookie,
      body: {},
      envOverride: { TARGET_CHANNEL: undefined },
    });
    expect(res.body.kind).toBe('no_destination');
  });
});

describe('web panel admin management', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('is read-only while admin management is off', async () => {
    const cookie = await ownerCookie();
    const list = await call({ method: 'GET', path: '/api/admin/admins', cookie });
    expect(list.body.manageEnabled).toBe(false);
    const add = await call({
      method: 'POST',
      path: '/api/admin/admins',
      cookie,
      body: { targetUserId: TARGET_USER_ID, targetRole: 'reviewer' },
    });
    expect(add.body.kind).toBe('manage_disabled');
  });

  it('adds and removes an admin while management is on, and protects the owner', async () => {
    const cookie = await ownerCookie();
    const on = { ADMIN_MANAGE_ENABLED: 'true' };
    const added = await call({
      method: 'POST',
      path: '/api/admin/admins',
      cookie,
      body: { targetUserId: TARGET_USER_ID, targetRole: 'reviewer' },
      envOverride: on,
    });
    expect(added.body.kind).toBe('applied');
    const removed = await call({
      method: 'POST',
      path: `/api/admin/admins/${TARGET_USER_ID}/remove`,
      cookie,
      body: {},
      envOverride: on,
    });
    expect(removed.body.kind).toBe('applied');
    const ownerRemove = await call({
      method: 'POST',
      path: `/api/admin/admins/${OWNER_ID}/remove`,
      cookie,
      body: {},
      envOverride: on,
    });
    expect(ownerRemove.body.kind).toBe('owner_protected');
    const badRole = await call({
      method: 'POST',
      path: '/api/admin/admins',
      cookie,
      body: { targetUserId: TARGET_USER_ID, targetRole: 'superuser' },
      envOverride: on,
    });
    expect(badRole.body.kind).toBe('invalid_role');
  });
});
