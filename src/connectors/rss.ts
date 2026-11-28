/**
 * RSS/Atom connector (Phase 4 — ADR-0039 §1/§3). Covers all seven RSS
 * entries of the registry generically: single `endpoint` or bounded
 * `endpointTemplates` lists.
 *
 * Behavior: conditional GET (If-None-Match + If-Modified-Since from the
 * per-feed cursor), safe bounded XML parsing, normalization via the
 * shared module. All-304 across feeds → not_modified. Malformed feeds
 * fail safe (item-level drop with malformedCount; whole-feed parse
 * failure is a `failed` poll for that feed — but OTHER feeds' durable
 * items still commit; the cursor keeps their state, the broken feed's
 * entry is left untouched, ADR-0038 §5).
 *
 * R10 (Round 1.8): a budget-authority denial (`budget_denied` /
 * `budget_source_missing` from the ingestion transport) ABORTS the whole
 * multi-feed sequence immediately — no further feed requests — and the
 * window is deferred WHOLE: no items, the PRIOR per-feed cursor (never
 * the partially advanced one), typed `budgetDenied` propagation.
 *
 * R10.1 (Round 1.8.1): a denial also preserves the prior source-level
 * validators (B2) and the strongest Retry-After bound observed earlier in
 * the same sequence (B3); an authority throw keeps the poll's observed
 * attempt total (B4).
 */
import { INGESTION_LIMITS } from '../domain/source/source-registry';
import type { SafeHttpFailureReason } from '../shared/http/safe-http';
import { safeHttpReasonToHealthReason } from '../shared/http/safe-http';
import { parseFeedDocument, type ParsedFeedItem } from './xml/feed-reader';
import { isHttpImageUrl } from '../domain/media/image-url';
import { normalizeRawItem, type NormalizedItemOut } from './normalize';
import {
  budgetDenialKindOf,
  budgetDeniedOutput,
  endpointHost,
  fetchWithObservedAttempts,
  isXmlContentType,
  parseRetryAfterSeconds,
  strongestRetryAfterLowerBound,
  type ConnectorFetchInput,
  type ConnectorFetchOutput,
  type SourceConnector,
} from './contract';

interface FeedCursorEntry {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

type FeedCursor = Record<string, FeedCursorEntry>;

/**
 * ADR-0068 — og:image resolution bounds (ADR-0079 raises the cap 2 → 8:
 * feeds return 10–20 items and only the freshest few had any chance of
 * an article fetch). At most eight article fetches per feed per poll,
 * freshest-first: the feed is newer-first, so the first imageless items
 * are the ones most likely new. Each fetch charges ONE source/day
 * ingestion unit (the same authority as the feed fetch); a budget denial
 * stops og:image for the poll only — the feed items still commit.
 */
const OG_IMAGE_MAX_PER_FEED = 8;
/** og:image lives in <head>: 256 KiB is far more than enough. */
const OG_IMAGE_BYTE_CAP = 256 * 1024;
const OG_IMAGE_TIMEOUT_MS = 5_000;
/** Bounded meta-tag scan (a pathological page cannot loop forever). */
const OG_IMAGE_MAX_META_TAGS = 100;

/**
 * Extract the first valid `og:image` URL from article HTML. The
 * `<meta property="og:image" content="...">` tag is matched
 * case-insensitively with either quote style and either attribute
 * order; a missing, relative, or non-https value yields null.
 */
export function extractOgImage(html: string): string | null {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const bounded = metaTags.slice(0, OG_IMAGE_MAX_META_TAGS);
  for (const tag of bounded) {
    if (!/\bog:image\b/i.test(tag)) continue;
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const url = content?.[1] ?? content?.[2] ?? null;
    if (url !== null && isHttpImageUrl(url)) return url;
  }
  return null;
}

function parseCursor(cursor: string | null): FeedCursor {
  if (cursor === null || cursor.length === 0 || cursor.length > 16_384) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: FeedCursor = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        key.startsWith('https://')
      ) {
        const entry = value as Record<string, unknown>;
        out[key] = {
          etag: typeof entry.etag === 'string' ? entry.etag.slice(0, 256) : null,
          lastModified:
            typeof entry.lastModified === 'string' ? entry.lastModified.slice(0, 128) : null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve `og:image` for the freshest imageless items of one feed
 * (ADR-0068). At most `OG_IMAGE_MAX_PER_FEED` article fetches, in
 * feed order (newer-first). Every outcome is fail-soft: a failed
 * fetch skips that article, a budget denial or a transport throw
 * stops og:image for the feed — the parsed items always survive,
 * with or without an image. The request count is honestly carried
 * (each attempt charged exactly what the transport reports).
 */
async function resolveOgImages(input: {
  readonly items: readonly ParsedFeedItem[];
  readonly effects: ConnectorFetchInput['effects'];
  readonly requestCount: number;
}): Promise<{ readonly items: readonly ParsedFeedItem[]; readonly requestCount: number }> {
  let requestCount = input.requestCount;
  let attempts = 0;
  const items = [...input.items];
  for (let index = 0; index < items.length; index += 1) {
    if (attempts >= OG_IMAGE_MAX_PER_FEED) break;
    const item = items[index]!;
    if (item.imageUrl !== null) continue;
    const articleUrl = item.link ?? item.guidPermalink ?? null;
    if (articleUrl === null) continue;
    const host = endpointHost(articleUrl);
    if (host === null) continue;
    attempts += 1;
    let result: Awaited<ReturnType<typeof input.effects.safeFetch>>;
    try {
      result = await input.effects.safeFetch({
        url: articleUrl,
        headers: {
          accept: 'text/html, */*;q=0.8',
          'user-agent': 'PixelEditorialAgent/1.4 (+https://t.me/pixellores)',
        },
        byteCap: OG_IMAGE_BYTE_CAP,
        timeoutMs: OG_IMAGE_TIMEOUT_MS,
        maxRedirects: INGESTION_LIMITS.maxRedirects,
        allowedHosts: [host],
      });
    } catch {
      // A transport throw (incl. an authority failure) stops og:image
      // for this feed — the feed items still commit below.
      break;
    }
    requestCount += result.requestCount;
    if (!result.ok) {
      // A budget denial stops og:image for the poll; any other
      // failure only skips this article.
      if (budgetDenialKindOf(result.reason) !== null) break;
      continue;
    }
    if (result.status !== 200) continue;
    const ogImage = extractOgImage(result.bodyText);
    if (ogImage !== null) {
      items[index] = { ...item, imageUrl: ogImage };
    }
  }
  return { items, requestCount };
}

function feedUrls(config: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const endpoint = config['endpoint'];
  if (typeof endpoint === 'string' && endpoint.startsWith('https://')) {
    urls.push(endpoint);
  }
  const templates = config['endpointTemplates'];
  if (Array.isArray(templates)) {
    for (const template of templates) {
      if (typeof template === 'string' && template.startsWith('https://') && urls.length < 4) {
        urls.push(template);
      }
    }
  }
  return urls.slice(0, 4);
}

export function createRssConnector(): SourceConnector {
  return {
    id: 'rss',
    byteCap: INGESTION_LIMITS.maxFeedBytes,
    plannedRequestCount(config: Record<string, unknown>): number {
      return Math.max(1, feedUrls(config).length);
    },
    preflight(
      config: Record<string, unknown>,
    ): { ok: true } | { ok: false; reason: 'watchlist_empty' } {
      return feedUrls(config).length > 0 ? { ok: true } : { ok: false, reason: 'watchlist_empty' };
    },
    allowedHosts(config: Record<string, unknown>): readonly string[] {
      return feedUrls(config)
        .map((url) => endpointHost(url))
        .filter((host): host is string => host !== null);
    },
    async fetch(input: ConnectorFetchInput): Promise<ConnectorFetchOutput> {
      const { config, state, effects, sourceId } = input;
      const urls = feedUrls(config);
      if (urls.length === 0) {
        return {
          status: 'failed',
          items: [],
          cursor: state.cursor,
          etag: null,
          lastModified: null,
          retryAfterSeconds: null,
          requestCount: 0,
          malformedCount: 0,
          failureReason: 'watchlist_empty',
        };
      }
      const cursor = parseCursor(state.cursor);
      const items: NormalizedItemOut[] = [];
      let requestCount = 0;
      let malformed = 0;
      let anyChanged = false;
      let anyRateLimited = false;
      let anyFailed = false;
      // STRONGEST Retry-After lower bound across ALL rate-limited feeds
      // (R05): a later shorter, missing, or invalid header never erases an
      // earlier valid bound — see strongestRetryAfterLowerBound.
      let retryAfterSeconds: number | null = null;
      let failureReason: ConnectorFetchOutput['failureReason'] = null;
      const nextCursor: FeedCursor = { ...cursor };

      for (const feedUrl of urls) {
        const entry = cursor[feedUrl] ?? { etag: null, lastModified: null };
        const headers: Record<string, string> = {
          accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          'user-agent': 'PixelEditorialAgent/1.4 (+https://t.me/pixellores)',
        };
        // Conditional GET: BOTH validators when available (blueprint §8).
        if (entry.etag !== null) {
          headers['if-none-match'] = entry.etag;
        }
        if (entry.lastModified !== null) {
          headers['if-modified-since'] = entry.lastModified;
        }
        // R10.1 (B4): an authority throw mid-sequence keeps the poll's
        // observed attempt total: prior completed feeds (requestCount) +
        // the failing sequence's own count, aggregated EXACTLY once.
        const response = await fetchWithObservedAttempts(requestCount, () =>
          effects.safeFetch({
            url: feedUrl,
            headers,
            byteCap: INGESTION_LIMITS.maxFeedBytes,
            timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
            maxRedirects: INGESTION_LIMITS.maxRedirects,
            allowedHosts: [endpointHost(feedUrl) ?? ''],
          }),
        );
        requestCount += response.requestCount;
        // R10: a budget-authority denial aborts the WHOLE sequence (no
        // further feeds, no partial cursor advancement, no items).
        // R10.1 (B2/B3): the PRIOR source validators and the strongest
        // Retry-After bound already observed in THIS sequence survive the
        // denial (zero stays a valid bound).
        const denial = response.ok ? null : budgetDenialKindOf(response.reason);
        if (denial !== null) {
          return budgetDeniedOutput({
            requestCount,
            cursor: state.cursor,
            etag: state.etag,
            lastModified: state.lastModified,
            retryAfterSeconds,
            denialKind: denial,
          });
        }
        if (!response.ok) {
          anyFailed = true;
          failureReason = mapFailureReason(response.reason);
          continue;
        }
        if (response.status === 304) {
          nextCursor[feedUrl] = entry;
          continue;
        }
        if (response.status === 429) {
          anyRateLimited = true;
          retryAfterSeconds = strongestRetryAfterLowerBound(
            retryAfterSeconds,
            parseRetryAfterSeconds(response.headers.get('retry-after'), effects.nowMs()),
          );
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          anyFailed = true;
          failureReason = 'http_status_error';
          continue;
        }
        if (!isXmlContentType(response.headers.get('content-type'))) {
          anyFailed = true;
          failureReason = 'unexpected_content_type';
          continue;
        }
        const parsed = parseFeedDocument(response.bodyText);
        if (!parsed.ok) {
          malformed += 1;
          anyFailed = true;
          failureReason = 'response_malformed';
          continue;
        }
        anyChanged = true;
        const etag = response.headers.get('etag');
        const lastModified = response.headers.get('last-modified');
        nextCursor[feedUrl] = {
          etag: etag === null ? null : etag.slice(0, 256),
          lastModified: lastModified === null ? null : lastModified.slice(0, 128),
        };
        const stripDownloads = config['stripDownloadLinks'] === true;
        // ADR-0068: og:image for the freshest imageless items — the
        // feed items commit with or without an image (see resolveOgImages).
        const withImages = await resolveOgImages({
          items: parsed.feed.items,
          effects,
          requestCount,
        });
        requestCount = withImages.requestCount;
        for (const rawItem of withImages.items) {
          const normalized = await normalizeRawItem({
            connector: 'rss',
            sourceId,
            originLabel: feedUrl,
            raw: {
              id: rawItem.id,
              link: rawItem.link,
              guidPermalink: rawItem.guidPermalink,
              title: rawItem.title,
              bodyText: rawItem.bodyText,
              author: rawItem.author,
              publishedRaw: rawItem.publishedRaw,
              imageUrl: rawItem.imageUrl,
            },
            stripDownloads,
            nowMs: effects.nowMs(),
          });
          if (normalized.ok) {
            items.push(normalized.item);
          } else {
            malformed += 1;
          }
        }
      }

      if (anyRateLimited) {
        return {
          status: 'rate_limited',
          items,
          cursor: JSON.stringify(nextCursor),
          etag: null,
          lastModified: null,
          retryAfterSeconds,
          requestCount,
          malformedCount: malformed,
          failureReason: null,
        };
      }
      if (anyFailed) {
        return {
          status: 'failed',
          items,
          cursor: JSON.stringify(nextCursor),
          etag: null,
          lastModified: null,
          retryAfterSeconds: null,
          requestCount,
          malformedCount: malformed,
          failureReason,
        };
      }
      if (!anyChanged) {
        return {
          status: 'not_modified',
          items: [],
          cursor: JSON.stringify(nextCursor),
          etag: null,
          lastModified: null,
          retryAfterSeconds: null,
          requestCount,
          malformedCount: 0,
          failureReason: null,
        };
      }
      return {
        status: 'changed',
        items,
        cursor: JSON.stringify(nextCursor),
        etag: null,
        lastModified: null,
        retryAfterSeconds: null,
        requestCount,
        malformedCount: malformed,
        failureReason: null,
      };
    },
  };
}

function mapFailureReason(reason: SafeHttpFailureReason): ConnectorFetchOutput['failureReason'] {
  return safeHttpReasonToHealthReason(reason) as ConnectorFetchOutput['failureReason'];
}
