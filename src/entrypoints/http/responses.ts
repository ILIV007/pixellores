/**
 * HTTP response helpers.
 *
 * Every response is constructed here so security headers are applied
 * consistently. Error responses can only be produced via `errorResponse`,
 * which routes through the safe serializer (shared/errors/serialize.ts) and
 * therefore never leaks stacks, causes, or environment values.
 */
import { HTTP_STATUS_BY_CODE, toAppError } from '../../shared/errors/app-error';
import { toPublicErrorBody } from '../../shared/errors/serialize';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
  });
}

/**
 * ADR-0081 — the site admin panel's Content-Security-Policy. No
 * `unsafe-inline`, no `unsafe-eval`: all JS and CSS are same-origin
 * static routes, the ONLY external script is Telegram's own Login
 * Widget, and its login popup iframe comes from oauth.telegram.org.
 * (Fredy's Manager ships an unsafe-inline CSP — explicitly NOT copied.)
 */
export const ADMIN_PANEL_CSP =
  "default-src 'self'; script-src 'self' https://telegram.org; " +
  "style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-src https://oauth.telegram.org; frame-ancestors 'none'; base-uri 'none'";

function staticResponse(contentType: string, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': contentType,
      'content-security-policy': ADMIN_PANEL_CSP,
    },
  });
}

/** ADR-0081 — the admin shell page (GET /admin). */
export function htmlResponse(body: string): Response {
  return staticResponse('text/html; charset=utf-8', body);
}

/** ADR-0081 — the admin SPA script (GET /admin/app.js). */
export function jsResponse(body: string): Response {
  return staticResponse('application/javascript; charset=utf-8', body);
}

/** ADR-0081 — the admin stylesheet (GET /admin/app.css). */
export function cssResponse(body: string): Response {
  return staticResponse('text/css; charset=utf-8', body);
}

/**
 * Build a minimal, safe error response from any thrown value.
 * The raw error is logged by the caller; only the sanitized body is returned.
 */
export function errorResponse(value: unknown, requestId: string): Response {
  const appError = toAppError(value);
  const body = toPublicErrorBody(value, requestId);
  return jsonResponse(HTTP_STATUS_BY_CODE[appError.code] ?? 500, body);
}
