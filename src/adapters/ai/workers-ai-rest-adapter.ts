/**
 * Workers AI REST adapter — the BACKUP account port (ai-policy-v2.3,
 * ADR-0069): the SAME Workers AI product reached over the official REST
 * API on the backup Cloudflare account, called from the ONE primary
 * worker. No second worker, no second D1, no AI Gateway, no R2 — the
 * backup account needs nothing except the API token (ADR-0069 §3).
 *
 * Endpoint (official Workers AI REST API):
 *   POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}
 * with `Authorization: Bearer {token}` and the SAME JSON inputs the
 * binding takes (`{ messages, max_tokens }`). The token travels ONLY in
 * the Authorization request header — NEVER in a URL, query string, log,
 * error, or outcome.
 *
 * The REST response differs from the binding's post-processed output:
 * it is an envelope `{ result, success, errors, messages }`. This adapter
 * unwraps `result` and reuses the EXISTING `interpretRunResult`
 * chat.completion extraction (src/adapters/ai/workers-ai-adapter.ts),
 * which already understands
 * `{ choices: [{ message: { content, reasoning_content } }] }` and
 * `{ response }` — the v2.2 parse fix therefore applies to the backup
 * path unchanged.
 *
 * Security/robustness contract — the Gemini adapter's established
 * pattern (src/adapters/ai/gemini-adapter.ts):
 * - Strict HTTPS to ONE fixed origin (api.cloudflare.com); the account
 *   id and the model id are the only caller-controlled path segments,
 *   both strictly format-checked/percent-encoded. No arbitrary host may
 *   be supplied by callers or by model output.
 * - `redirect: 'error'` — a redirect is refused outright instead of
 *   being followed to an untrusted host.
 * - The response body is read with the shared bounded reader (strict
 *   byte cap + early Content-Length rejection + strict UTF-8).
 * - The wall deadline covers HEADERS *AND* BODY: the timer stays armed
 *   across the whole transport+body work, really aborts the request
 *   signal (best-effort runtime cancellation), and an independent race
 *   returns the typed deadline outcome even when the transport/stream
 *   ignores the signal. Late rejections after the race settled are
 *   absorbed (never unhandled). Timers are cleaned up on success and
 *   failure.
 * - Native failures map to the stable AiCallOutcome kinds:
 *   429 → `quota_denied` (Retry-After honored when numeric),
 *   401/403 → `auth_failed`, 404 → `model_unavailable`,
 *   non-200 otherwise → `transient`, 200 with `success: false` →
 *   `transient` (the envelope's error strings are NEVER surfaced).
 *   Raw response bodies, headers, URLs, the account id and the token
 *   NEVER cross this boundary.
 */
import type { AiCallOutcome, AiProviderPort } from '../../domain/ai/types';
import {
  BoundedReadError,
  decodeUtf8Strict,
  parseContentLengthHeader,
  readStreamBounded,
} from '../../shared/http/bounded-reader';
import { interpretRunResult } from './workers-ai-adapter';
import { parseRetryAfterMs, type AiHttpTransport } from './gemini-adapter';

/** Official Cloudflare API origin — the ONLY origin this adapter calls. */
export const WORKERS_AI_REST_ORIGIN = 'https://api.cloudflare.com';

/** Strict response byte cap for the REST JSON envelope. */
const WORKERS_AI_REST_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Cloudflare account ids are 32 lowercase hex characters. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Build the strict official endpoint URL. The account id must be the
 * 32-hex Cloudflare shape and the model id is percent-encoded — a
 * caller-supplied account id can never change the host, the scheme, or
 * smuggle path separators beyond the one documented slot.
 */
export function buildWorkersAiRestUrl(accountId: string, modelId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error('invalid backup account id format');
  }
  const encodedModel = encodeURIComponent(modelId);
  return `${WORKERS_AI_REST_ORIGIN}/client/v4/accounts/${accountId}/ai/run/${encodedModel}`;
}

export class WorkersAiRestAdapter implements AiProviderPort {
  readonly provider = 'workers-ai-backup' as const;

  constructor(
    private readonly transport: AiHttpTransport,
    private readonly accountId: string,
    private readonly apiToken: string,
  ) {
    // Fail fast at construction: a malformed account id is a wiring bug,
    // never a runtime condition. The token is NOT format-checked — its
    // only consumer is the Authorization header below.
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error('invalid backup account id format');
    }
  }

  async complete(input: {
    readonly modelId: string;
    readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[];
    readonly maxOutputTokens: number;
    readonly deadlineAtMs: number;
  }): Promise<AiCallOutcome> {
    // Clock contract: the deadline is an ABSOLUTE timestamp in the caller's
    // clock domain (the service's injected clock — the system wall clock in
    // production). This adapter measures against the system wall clock
    // (Date.now) because REAL cancellation requires real timers.
    const remainingMs = input.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return { kind: 'deadline_exceeded' };
    }

    let url: string;
    try {
      url = buildWorkersAiRestUrl(this.accountId, input.modelId);
    } catch {
      // An out-of-policy model id (e.g. path-breaking characters beyond
      // percent-encoding) is a wiring bug, never a provider condition.
      return { kind: 'transient' };
    }
    const body = JSON.stringify({
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      max_tokens: input.maxOutputTokens,
    });

    // The wall deadline covers HEADERS *AND* BODY (round 1.10.6.1):
    // receiving fast 200 headers must NOT end the deadline protection. The
    // timer stays armed until the whole transport+body work settles; it
    // really ABORTS the request signal (best-effort runtime cancellation)
    // and independently fires the typed deadline race. If the transport or
    // body stream ignores the signal, the race still enforces the deadline
    // — the abandoned in-flight work is documented, never hidden.
    const abortController = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const deadlineRace = new Promise<'deadline'>((resolve) => {
      if (remainingMs < 2_147_483_647) {
        timerId = setTimeout(() => {
          abortController.abort();
          resolve('deadline');
        }, remainingMs);
      }
    });

    const work = (async (): Promise<AiCallOutcome> => {
      const response = await this.transport(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The ONLY place the backup token appears — never in the URL.
          authorization: `Bearer ${this.apiToken}`,
        },
        body,
        redirect: 'error',
        signal: abortController.signal,
      });
      if (response.status !== 200) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        switch (response.status) {
          case 429:
            return { kind: 'quota_denied', retryAfterMs };
          case 401:
          case 403:
            return { kind: 'auth_failed' };
          case 404:
            return { kind: 'model_unavailable', retryAfterMs };
          default:
            return { kind: 'transient', retryAfterMs };
        }
      }
      const bodyText = await readBodyBounded(response);
      if (bodyText === null) {
        return { kind: 'transient' };
      }
      return interpretRestEnvelope(bodyText);
    })();

    try {
      const winner = await Promise.race([work, deadlineRace]);
      if (winner === 'deadline') {
        return { kind: 'deadline_exceeded' };
      }
      return winner;
    } catch (error) {
      // AbortError => the wall deadline fired (real cancellation);
      // anything else is a transport failure. Neither leaks URL/headers.
      if (error instanceof Error && error.name === 'AbortError') {
        return { kind: 'deadline_exceeded' };
      }
      return { kind: 'transient' };
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      // A late transport/body rejection after the race settled must never
      // surface as an unhandled rejection; the outcome is already decided.
      void work.catch(() => undefined);
    }
  }
}

/** Bounded body read; ANY bounded-read failure maps to a transient outcome. */
async function readBodyBounded(response: Response): Promise<string | null> {
  const declared = parseContentLengthHeader(
    response.headers.get('content-length'),
    WORKERS_AI_REST_MAX_RESPONSE_BYTES,
  );
  if (declared.kind === 'oversized' || declared.kind === 'invalid') {
    return null;
  }
  try {
    const bytes = await readStreamBounded(response.body, WORKERS_AI_REST_MAX_RESPONSE_BYTES);
    return decodeUtf8Strict(bytes);
  } catch (error) {
    if (error instanceof BoundedReadError) {
      return null;
    }
    return null;
  }
}

/**
 * Strict, shape-checked unwrap of the REST envelope. A 200 envelope
 * carries `{ result, success, errors, messages }`:
 * - `success: false` => transient (the provider refused server-side; the
 *   envelope's error strings are never surfaced — only the kind is).
 * - A missing/non-object envelope or a missing `result` => transient.
 * - Otherwise the SAME interpretation as the binding path
 *   (`interpretRunResult`): chat.completion `choices`, the instruct
 *   `{ response }` shape, or a raw string.
 */
export function interpretRestEnvelope(bodyText: string): AiCallOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: 'transient' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'transient' };
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope['success'] === false) {
    return { kind: 'transient' };
  }
  const result = envelope['result'];
  if (result === null || result === undefined) {
    return { kind: 'transient' };
  }
  return interpretRunResult(result);
}

/**
 * Factory for the production port. The injected transport defaults to
 * the runtime global fetch (strict HTTPS origin enforced by the URL
 * builder); tests inject a fake. The account id is NON-secret
 * configuration (the `BACKUP_CF_ACCOUNT_ID` var); the token is a secret
 * (`BACKUP_WORKERS_AI_API_TOKEN`) that only ever lands in the
 * Authorization header.
 */
export function createWorkersAiRestAdapter(
  accountId: string,
  apiToken: string,
  transport: AiHttpTransport = fetch,
): AiProviderPort {
  return new WorkersAiRestAdapter(transport, accountId, apiToken);
}
