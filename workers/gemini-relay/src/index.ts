/**
 * Gemini pass-through relay (test transport for pixel-preview).
 *
 * WHY: direct fetch from the pixel-preview worker to
 * generativelanguage.googleapis.com fails instantly at transport level
 * (live-verified 2026-11-22: all three allowlist models, transient_failure
 * in 0 ms, twice — no HTTP response ever arrives, so the key was never
 * validated). The owner ordered a relay/proxy when direct fails. This
 * worker is the relay: pixel-preview calls IT (Cloudflare-to-Cloudflare),
 * it forwards the same request to Google from the backup account's
 * egress, and returns Google's response verbatim.
 *
 * SECURITY CONTRACT (deliberately minimal — a test transport, NOT a
 * production open proxy):
 * - ONLY POST to the exact generateContent path shape is forwarded
 *   (`/v1beta/models/<model>:generateContent`, model id charset-bound).
 *   Every other method/path gets 404. No query string is forwarded.
 * - The API key is NEVER stored here: it arrives in the `x-goog-api-key`
 *   header from pixel-preview and is forwarded verbatim to Google in the
 *   same header. It is never logged, never persisted, never in a URL.
 * - Only two request headers are forwarded (content-type, x-goog-api-key);
 *   only content-type + retry-after are returned. Body is bounded
 *   (64 KiB). Upstream fetch uses `redirect: 'manual'` — workerd does NOT
 *   implement `redirect: 'error'` (it throws a synchronous TypeError, the
 *   same bug that killed the pixel→Google path, ADR-0070 §1); a 3xx from
 *   Google arrives as a response and is returned verbatim, never followed.
 * - HARDENING BEFORE PRODUCTION USE (recorded in the ADR): require a
 *   relay shared secret header from pixel-preview so the endpoint is not
 *   a public pass-through for arbitrary callers' keys. Until then this
 *   relay is a test-only transport and the pixel flag stays operator-gated.
 */
const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com';
const PATH_PATTERN = /^\/v1beta\/models\/[A-Za-z0-9._-]+:generateContent$/;
const MAX_BODY_BYTES = 64 * 1024;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || !PATH_PATTERN.test(url.pathname)) {
      return new Response('not found', { status: 404 });
    }
    const apiKey = request.headers.get('x-goog-api-key');
    const contentType = request.headers.get('content-type');
    if (apiKey === null || apiKey.length === 0) {
      return new Response('missing key', { status: 400 });
    }
    let body: ArrayBuffer;
    try {
      body = await request.arrayBuffer();
    } catch {
      return new Response('unreadable body', { status: 400 });
    }
    if (body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES) {
      return new Response('bad body', { status: 400 });
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${GOOGLE_ORIGIN}${url.pathname}`, {
        method: 'POST',
        headers: {
          'content-type': contentType ?? 'application/json',
          'x-goog-api-key': apiKey,
        },
        body,
        // workerd implements ONLY 'follow' | 'manual' — 'error' throws a
        // synchronous TypeError before any network (ADR-0070 §1: this was
        // the relay→Google 502 — the catch below converted the throw).
        // 'manual' returns 3xx as a response, never followed.
        redirect: 'manual',
      });
    } catch {
      // Upstream unreachable from this egress: a plain 502 (never a
      // stack, never the key, never the body).
      return new Response('upstream unreachable', { status: 502 });
    }
    const respBody = await upstream.arrayBuffer();
    const headers = new Headers();
    const upstreamContentType = upstream.headers.get('content-type');
    if (upstreamContentType !== null) {
      headers.set('content-type', upstreamContentType);
    }
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter !== null) {
      headers.set('retry-after', retryAfter);
    }
    return new Response(respBody, { status: upstream.status, headers });
  },
};
