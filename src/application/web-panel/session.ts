/**
 * Admin session cookie (ADR-0081).
 *
 * No D1 table: the session is a signed cookie, not a row.
 *   value = base64url("<userId>.<expiryMs>[.<base64url(firstName)>]")
 *         + "." + base64url(HMAC-SHA-256(secret, payload))
 * The HMAC key is the existing WEBHOOK_SECRET (a server-side secret that
 * never leaves the worker). The display name rides inside the SIGNED
 * payload — it is verified by the HMAC, never trusted from the client —
 * so a reload still shows who is signed in. Verification re-computes
 * the HMAC and compares it through the timing-safe helper; a tampered
 * payload, an expired session, or a wrong secret all verify as null —
 * never an exception.
 *
 * TTL is 24h (the same window as the Login Widget's auth_date): the owner
 * re-logs in with one widget click after expiry.
 */
import { timingSafeEqualStrings } from '../../shared/security/timing-safe';

export const ADMIN_SESSION_COOKIE_NAME = 'pixel_admin_session';
export const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface AdminSession {
  readonly userId: number;
  readonly firstName: string | null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index) ?? 0;
    }
    return bytes;
  } catch {
    return null;
  }
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Issue a session cookie value for a verified Telegram user id. */
export async function issueAdminSession(input: {
  readonly userId: number;
  readonly firstName?: string;
  readonly secret: string;
  readonly nowMs: number;
  readonly ttlMs?: number;
}): Promise<string> {
  const expiryMs = input.nowMs + (input.ttlMs ?? ADMIN_SESSION_TTL_MS);
  const payload =
    input.firstName !== undefined && input.firstName.length > 0
      ? `${input.userId}.${expiryMs}.${base64UrlEncode(new TextEncoder().encode(input.firstName))}`
      : `${input.userId}.${expiryMs}`;
  const signature = await signPayload(input.secret, payload);
  return `${base64UrlEncode(new TextEncoder().encode(payload))}.${signature}`;
}

/**
 * Verify a session cookie value. Returns the session (Telegram user id
 * + display name), or null when the cookie is malformed, tampered,
 * expired, or signed with a different secret.
 */
export async function verifyAdminSession(input: {
  readonly cookieValue: string;
  readonly secret: string;
  readonly nowMs: number;
}): Promise<AdminSession | null> {
  const parts = input.cookieValue.split('.');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return null;
  }
  const payloadBytes = base64UrlDecode(parts[0]);
  if (payloadBytes === null) {
    return null;
  }
  const payload = new TextDecoder().decode(payloadBytes);
  const segments = payload.split('.');
  const userIdText = segments[0];
  const expiryText = segments[1];
  const userId = Number(userIdText);
  const expiryMs = Number(expiryText);
  if (
    userIdText === undefined ||
    expiryText === undefined ||
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(expiryMs) ||
    expiryMs <= input.nowMs
  ) {
    return null;
  }
  let firstName: string | null = null;
  if (segments.length === 3) {
    const nameBytes = base64UrlDecode(segments[2] as string);
    if (nameBytes === null) {
      return null;
    }
    firstName = new TextDecoder().decode(nameBytes);
  } else if (segments.length !== 2) {
    return null;
  }
  const expectedSignature = await signPayload(input.secret, payload);
  if (!(await timingSafeEqualStrings(expectedSignature, parts[1]))) {
    return null;
  }
  return { userId, firstName };
}

/** Parse the session cookie out of a Cookie header (null when absent). */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const prefix = `${ADMIN_SESSION_COOKIE_NAME}=`;
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Build the Set-Cookie header value for an issued session. */
export function buildSessionSetCookie(cookieValue: string, secure: boolean): string {
  const parts = [
    `${ADMIN_SESSION_COOKIE_NAME}=${cookieValue}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** Build the Set-Cookie header value that clears the session. */
export function buildSessionClearCookie(): string {
  return `${ADMIN_SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
