import { describe, expect, it } from 'vitest';
import {
  verifyTelegramLogin,
  type TelegramLoginData,
} from '../../src/application/web-panel/telegram-login';
import {
  ADMIN_SESSION_COOKIE_NAME,
  buildSessionClearCookie,
  buildSessionSetCookie,
  issueAdminSession,
  readSessionCookie,
  verifyAdminSession,
} from '../../src/application/web-panel/session';
import { parseDraftDocument } from '../../src/application/web-panel/web-panel-service';

/**
 * ADR-0081 — Telegram Login Widget verification + the session cookie.
 * The HMAC in these tests is computed INDEPENDENTLY (Web Crypto, the
 * same algorithm Telegram documents) — the test constructs the payload
 * the way Telegram would, then checks the module agrees. Fixture
 * values are deliberately NOT token-shaped (no `digits:` prefix).
 */

const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const WEBHOOK_SECRET = 'fixture-webhook-secret-for-tests-0123456789';
const OWNER_ID = 1000000001;
const NOW = 1_760_000_000_000;

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(keyBytes: ArrayBuffer, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** Build a widget payload exactly the way Telegram signs it. */
async function signedLoginData(
  overrides: Partial<TelegramLoginData> = {},
): Promise<TelegramLoginData> {
  const base: Record<string, unknown> = {
    id: OWNER_ID,
    first_name: 'Iliya',
    username: 'iliya_test',
    auth_date: Math.floor(NOW / 1000),
  };
  const merged = { ...base, ...overrides };
  const entries = Object.entries(merged)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([key, value]) => `${key}=${String(value)}`).join('\n');
  const tokenKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BOT_TOKEN));
  const hash = await hmacHex(tokenKey, dataCheckString);
  return { ...merged, hash } as TelegramLoginData;
}

describe('verifyTelegramLogin', () => {
  it('verifies a correctly signed widget payload', async () => {
    const data = await signedLoginData();
    const result = await verifyTelegramLogin(data, BOT_TOKEN, NOW);
    expect(result).toEqual({
      kind: 'verified',
      user: { id: OWNER_ID, firstName: 'Iliya', username: 'iliya_test' },
    });
  });

  it('rejects a tampered field as a bad hash', async () => {
    const data = await signedLoginData();
    const tampered = { ...data, first_name: 'Mallory' };
    expect(await verifyTelegramLogin(tampered, BOT_TOKEN, NOW)).toEqual({
      kind: 'rejected',
      reason: 'bad_hash',
    });
  });

  it('rejects a stale auth_date', async () => {
    const data = await signedLoginData({ auth_date: Math.floor(NOW / 1000) - 25 * 60 * 60 });
    expect(await verifyTelegramLogin(data, BOT_TOKEN, NOW)).toEqual({
      kind: 'rejected',
      reason: 'stale',
    });
  });

  it('rejects an auth_date too far in the future', async () => {
    const data = await signedLoginData({ auth_date: Math.floor(NOW / 1000) + 10 * 60 });
    expect(await verifyTelegramLogin(data, BOT_TOKEN, NOW)).toEqual({
      kind: 'rejected',
      reason: 'stale',
    });
  });

  it('rejects malformed shapes without throwing', async () => {
    const base = await signedLoginData();
    expect(await verifyTelegramLogin({ ...base, id: 'not-a-number' }, BOT_TOKEN, NOW)).toEqual({
      kind: 'rejected',
      reason: 'bad_shape',
    });
    expect(await verifyTelegramLogin({ ...base, hash: 'not-hex' }, BOT_TOKEN, NOW)).toEqual({
      kind: 'rejected',
      reason: 'bad_shape',
    });
    const { hash: _hash, ...noHash } = base;
    expect(await verifyTelegramLogin(noHash as TelegramLoginData, BOT_TOKEN, NOW)).toEqual({
      kind: 'rejected',
      reason: 'bad_shape',
    });
  });

  it('rejects a non-https photo_url', async () => {
    const data = await signedLoginData({ photo_url: 'http://example.test/photo.jpg' });
    expect(await verifyTelegramLogin(data, BOT_TOKEN, NOW)).toEqual({
      kind: 'rejected',
      reason: 'bad_shape',
    });
  });

  it('rejects verification without a bot token', async () => {
    const data = await signedLoginData();
    expect(await verifyTelegramLogin(data, '', NOW)).toEqual({
      kind: 'rejected',
      reason: 'bad_shape',
    });
  });
});

describe('admin session cookie', () => {
  it('round-trips the user id and display name', async () => {
    const cookie = await issueAdminSession({
      userId: OWNER_ID,
      firstName: 'Iliya',
      secret: WEBHOOK_SECRET,
      nowMs: NOW,
    });
    expect(
      await verifyAdminSession({ cookieValue: cookie, secret: WEBHOOK_SECRET, nowMs: NOW }),
    ).toEqual({
      userId: OWNER_ID,
      firstName: 'Iliya',
    });
  });

  it('round-trips without a display name', async () => {
    const cookie = await issueAdminSession({
      userId: OWNER_ID,
      secret: WEBHOOK_SECRET,
      nowMs: NOW,
    });
    expect(
      await verifyAdminSession({ cookieValue: cookie, secret: WEBHOOK_SECRET, nowMs: NOW }),
    ).toEqual({
      userId: OWNER_ID,
      firstName: null,
    });
  });

  it('rejects an expired session', async () => {
    const cookie = await issueAdminSession({
      userId: OWNER_ID,
      secret: WEBHOOK_SECRET,
      nowMs: NOW,
    });
    expect(
      await verifyAdminSession({
        cookieValue: cookie,
        secret: WEBHOOK_SECRET,
        nowMs: NOW + 25 * 60 * 60 * 1000,
      }),
    ).toBeNull();
  });

  it('rejects a tampered payload and a wrong secret', async () => {
    const cookie = await issueAdminSession({
      userId: OWNER_ID,
      firstName: 'Iliya',
      secret: WEBHOOK_SECRET,
      nowMs: NOW,
    });
    const [payload, signature] = cookie.split('.');
    const tamperedPayload = `${payload === undefined ? '' : payload.slice(0, -1)}A`;
    expect(
      await verifyAdminSession({
        cookieValue: `${tamperedPayload}.${signature}`,
        secret: WEBHOOK_SECRET,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      await verifyAdminSession({ cookieValue: cookie, secret: 'a-different-secret', nowMs: NOW }),
    ).toBeNull();
    expect(
      await verifyAdminSession({ cookieValue: 'garbage', secret: WEBHOOK_SECRET, nowMs: NOW }),
    ).toBeNull();
    expect(
      await verifyAdminSession({ cookieValue: '', secret: WEBHOOK_SECRET, nowMs: NOW }),
    ).toBeNull();
  });

  it('parses the cookie out of a Cookie header', () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie('other=1; pixel_admin_session=abc123; x=2')).toBe('abc123');
    expect(readSessionCookie(`${ADMIN_SESSION_COOKIE_NAME}=`)).toBeNull();
  });

  it('builds a secure, http-only session cookie and a clearing cookie', () => {
    const setCookie = buildSessionSetCookie('abc123', true);
    expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE_NAME}=abc123`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Max-Age=86400');
    expect(buildSessionSetCookie('abc123', false)).not.toContain('Secure');
    expect(buildSessionClearCookie()).toContain('Max-Age=0');
  });
});

describe('parseDraftDocument', () => {
  it('parses the headline, summary, source, and claims', () => {
    const parsed = parseDraftDocument(
      JSON.stringify({
        headlineFa: 'GTA VI sells fast',
        summaryFa: 'A short summary.',
        sourceReport: {
          sourceItemId: 'item-1',
          sourceName: 'Gematsu',
          excerptText: 'The excerpt.',
        },
        modelClaims: [{ text: 'Sold 32.5M copies.', evidenceIds: [], status: 'unverified' }],
      }),
    );
    expect(parsed.headline).toBe('GTA VI sells fast');
    expect(parsed.summary).toBe('A short summary.');
    expect(parsed.sourceName).toBe('Gematsu');
    expect(parsed.excerpt).toBe('The excerpt.');
    expect(parsed.claims).toEqual([{ text: 'Sold 32.5M copies.', status: 'unverified' }]);
    expect(parsed.figures).toBeNull();
    expect(parsed.quote).toBeNull();
    expect(parsed.verdict).toBeNull();
  });

  it('never throws on malformed documents', () => {
    const parsed = parseDraftDocument('{not json');
    expect(parsed.headline).toBeNull();
    expect(parsed.summary).toBeNull();
    expect(parsed.claims).toEqual([]);
    const empty = parseDraftDocument('[]');
    expect(empty.headline).toBeNull();
  });

  it('returns structured figures and the quote when present', () => {
    const parsed = parseDraftDocument(
      JSON.stringify({
        headlineFa: 'Headline',
        summaryFa: 'Summary',
        figures: [{ label: 'Day-one sales', value: '$3.79B', significance: 'headline' }],
        quote: { text: 'A great game.', attribution: 'Reviewer' },
        verdict: 'Worth watching.',
        gameName: 'GTA VI',
        soulForm: { categoryEmoji: '🎮', trustLabel: 'official' },
        rewrite: { status: 'rewritten' },
      }),
    );
    expect(parsed.figures).toHaveLength(1);
    expect(parsed.quote).toEqual({ text: 'A great game.', attribution: 'Reviewer' });
    expect(parsed.verdict).toBe('Worth watching.');
    expect(parsed.gameName).toBe('GTA VI');
    expect(parsed.soulForm).toEqual({ categoryEmoji: '🎮', trustLabel: 'official' });
    expect(parsed.rewriteStatus).toBe('rewritten');
  });

  it('bounds the figures and claims lists', () => {
    const parsed = parseDraftDocument(
      JSON.stringify({
        headlineFa: 'H',
        summaryFa: 'S',
        figures: Array.from({ length: 20 }, (_, i) => ({ value: i })),
        modelClaims: Array.from({ length: 40 }, (_, i) => ({ text: `claim ${i}` })),
      }),
    );
    expect(parsed.figures).toHaveLength(8);
    expect(parsed.claims).toHaveLength(32);
  });
});
