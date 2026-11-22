/**
 * Source-article image URLs (ADR-0068 — media by hotlink, no R2).
 *
 * PURE, DETERMINISTIC, OFFLINE: the bounded validation + extraction of
 * the image URL a feed item carries (feed enclosure / media:content /
 * media:thumbnail, or og:image resolved by the connector) and of the
 * image URL stored in a source item's durable provenance
 * (`raw_json.imageUrl`).
 *
 * BOUNDS (pinned, never guessed): an image URL is an https URL of at
 * most 2048 chars (the `media_assets.canonical_url` reader bound) with
 * no control characters and no spaces. Anything else is not an image
 * URL — never a fetch, never a guess.
 */

/** The `media_assets.canonical_url` bound (media-usage.ts `isBoundedUrl`). */
export const IMAGE_URL_MAX_LENGTH = 2048;

/**
 * The bounded https-URL check for an image reference. Accepts ONLY
 * `https://` URLs: http is never fetched (the mrp1 https-only rule),
 * and a non-URL string is never treated as one.
 */
export function isHttpImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 9 || value.length > IMAGE_URL_MAX_LENGTH) return false;
  if (!value.startsWith('https://')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f) return false;
  }
  return true;
}

/**
 * Extract the stored image URL from a source item's `raw_json` (a JSON
 * string or an already-parsed object). Anything unparseable, missing,
 * or failing the URL bound yields null — never a throw, never a guess.
 * The stored field is the flat `imageUrl` key written by the
 * normalizer (ADR-0068); a nested or differently-shaped value is not
 * one.
 */
export function extractImageUrlFromRawJson(rawJson: unknown): string | null {
  let parsed: unknown = rawJson;
  if (typeof rawJson === 'string') {
    if (rawJson.length === 0 || rawJson.length > 16_384) return null;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const imageUrl = (parsed as Record<string, unknown>)['imageUrl'];
  return isHttpImageUrl(imageUrl) ? imageUrl : null;
}

/**
 * The host of an image URL, for the durable attribution echo
 * (`media_assets.attribution`). Returns null for anything that is not
 * a valid image URL — the caller records no attribution then.
 */
export function imageUrlHost(imageUrl: string): string | null {
  if (!isHttpImageUrl(imageUrl)) return null;
  const afterScheme = imageUrl.slice('https://'.length);
  const hostPart = afterScheme.split('/')[0] ?? '';
  const host = hostPart.startsWith('[') ? hostPart : (hostPart.split(':')[0] ?? '');
  return host.length > 0 && host.length <= 256 ? host.toLowerCase() : null;
}
