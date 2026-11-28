/**
 * Telegram Login Widget verification (ADR-0081).
 *
 * The official algorithm, exactly:
 *   1. Build the data-check-string from every received field EXCEPT `hash`,
 *      sorted alphabetically by key, joined as `key=value` lines (`\n`).
 *   2. The HMAC key is SHA-256 of the bot token (bytes, not hex).
 *   3. HMAC-SHA-256 of the data-check-string, hex-encoded, compared with
 *      the received `hash` through the timing-safe helper.
 *   4. `auth_date` must be within 24h (and not more than 5 min in the
 *      future — clock skew, not trust).
 *
 * Pure: no I/O, no logging of values. Rejection reasons are stable codes
 * only — never the received values.
 */
import { timingSafeEqualStrings } from '../../shared/security/timing-safe';

/** Login Widget auth data, exactly as the widget's `onTelegramAuth` sends it. */
export interface TelegramLoginData {
  readonly id: unknown;
  readonly first_name: unknown;
  readonly last_name?: unknown;
  readonly username?: unknown;
  readonly photo_url?: unknown;
  readonly auth_date: unknown;
  readonly hash: unknown;
}

export interface TelegramLoginUser {
  readonly id: number;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly photoUrl?: string;
}

export type TelegramLoginVerification =
  | { readonly kind: 'verified'; readonly user: TelegramLoginUser }
  | { readonly kind: 'rejected'; readonly reason: 'bad_shape' | 'bad_hash' | 'stale' };

/** The widget's auth data is usable for 24h; 5 min of future skew is tolerated. */
export const TELEGRAM_LOGIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TELEGRAM_LOGIN_FUTURE_SKEW_MS = 5 * 60 * 1000;

const MAX_FIRST_NAME_LENGTH = 128;
const MAX_LAST_NAME_LENGTH = 128;
const MAX_USERNAME_LENGTH = 64;
const MAX_PHOTO_URL_LENGTH = 512;

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(keyBytes: ArrayBuffer, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(signature);
}

/**
 * Verify one Login Widget payload against the bot token. Returns the
 * verified user (id + display fields) or a stable rejection reason.
 * Never throws on malformed input — every shape failure is `bad_shape`.
 */
export async function verifyTelegramLogin(
  data: TelegramLoginData,
  botToken: string,
  nowMs: number,
): Promise<TelegramLoginVerification> {
  if (typeof botToken !== 'string' || botToken.length === 0) {
    return { kind: 'rejected', reason: 'bad_shape' };
  }
  if (
    typeof data.id !== 'number' ||
    !Number.isSafeInteger(data.id) ||
    data.id <= 0 ||
    !isNonEmptyBoundedString(data.first_name, MAX_FIRST_NAME_LENGTH) ||
    !isOptionalBoundedString(data.last_name, MAX_LAST_NAME_LENGTH) ||
    !isOptionalBoundedString(data.username, MAX_USERNAME_LENGTH) ||
    !isOptionalBoundedString(data.photo_url, MAX_PHOTO_URL_LENGTH) ||
    typeof data.auth_date !== 'number' ||
    !Number.isSafeInteger(data.auth_date) ||
    typeof data.hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(data.hash)
  ) {
    return { kind: 'rejected', reason: 'bad_shape' };
  }
  if (typeof data.photo_url === 'string' && !data.photo_url.startsWith('https://')) {
    return { kind: 'rejected', reason: 'bad_shape' };
  }
  const authDateMs = data.auth_date * 1000;
  if (
    authDateMs > nowMs + TELEGRAM_LOGIN_FUTURE_SKEW_MS ||
    nowMs - authDateMs > TELEGRAM_LOGIN_MAX_AGE_MS
  ) {
    return { kind: 'rejected', reason: 'stale' };
  }

  // The data-check-string: every field except `hash`, `key=value` per
  // line, keys sorted alphabetically. Values are stringified exactly as
  // Telegram sends them (numbers as decimal, strings verbatim).
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'hash' || value === undefined) {
      continue;
    }
    entries.push([key, String(value)]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n');

  const tokenKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botToken));
  const expectedHash = await hmacSha256Hex(tokenKey, dataCheckString);
  if (!(await timingSafeEqualStrings(expectedHash, data.hash))) {
    return { kind: 'rejected', reason: 'bad_hash' };
  }

  return {
    kind: 'verified',
    user: {
      id: data.id,
      firstName: data.first_name,
      ...(typeof data.last_name === 'string' && data.last_name.length > 0
        ? { lastName: data.last_name }
        : {}),
      ...(typeof data.username === 'string' && data.username.length > 0
        ? { username: data.username }
        : {}),
      ...(typeof data.photo_url === 'string' && data.photo_url.length > 0
        ? { photoUrl: data.photo_url }
        : {}),
    },
  };
}
