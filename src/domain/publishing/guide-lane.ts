/**
 * The guide lane (ADR-0068 — quality fix #5).
 *
 * PURE, DETERMINISTIC, OFFLINE: a post is a GUIDE iff its source
 * item's canonical URL carries a `/guide/` path segment (e.g. the VGC
 * step-by-step guides). Guides are KEPT — never dropped — as a
 * separate occasional format: the bridge enqueues at most one guide
 * per pass at P2 priority, so guides ride the queue without crowding
 * news.
 */

/** A guide rides P2 (40–74): the dynamic window, never the P1 fast lane. */
export const GUIDE_PUBLISH_PRIORITY_SCORE = 60;

/** At most one guide per bridge pass — the "occasional format" pin. */
export const MAX_GUIDES_PER_BRIDGE_PASS = 1;

export type PostLane = 'news' | 'guide';

/**
 * The lane of a post from its source item's canonical URL. A null or
 * non-URL value is news (the lane never blocks on a missing URL —
 * the gate decides eligibility, the lane only shapes order).
 * The match is a `/guide/` PATH segment: a query string or a host
 * mentioning "guide" is not one.
 */
export function classifyPostLane(canonicalUrl: string | null): PostLane {
  if (canonicalUrl === null) return 'news';
  let path: string;
  try {
    path = new URL(canonicalUrl).pathname.toLowerCase();
  } catch {
    return 'news';
  }
  return path.split('/').includes('guide') ? 'guide' : 'news';
}
