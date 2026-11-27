/**
 * The POST ALBUM assembly (ADR-0072, plan §6) — PURE.
 *
 * The plan's album rule, as ONE deterministic function:
 * 1. A post with MULTIPLE source photos goes out as an album of those
 *    photos (at most POST_ALBUM_MAX_ITEMS = 4 per post).
 * 2. A post with NO source photo gets ONE generated image — as a single
 *    photo, NEVER as a multi-image generated album (generating several
 *    images for one post burns the budget).
 * 3. Mixing "real + generated" in one album is ALLOWED, with the order
 *    real-first / generated-last — and the generated item is flagged so
 *    the caption can say which photo is AI-generated.
 *
 * The assembler takes the already-resolved items (ledger + rights
 * decided upstream) and orders/caps them. It does NOT decide WHEN a
 * generated image joins an album: in v1 no scheduler path passes one
 * (the trigger is an owner decision — OD-019), so the generated slot
 * stays empty and albums are real-only. The ordering rule is pinned
 * here, tested, and ready for the follow-up that wires it.
 *
 * BOUNDARY: pure — no I/O, no clock, no SQL, no Telegram types. The
 * wire shape (file_id / URL / attach bytes) is decided by the caller;
 * this module only orders items and enforces the count.
 */

/** The plan's per-post album cap (Bot API allows 2..10; Pixel caps at 4). */
export const POST_ALBUM_MAX_ITEMS = 4;

/** One real (source) photo, already resolved to a sendable reference. */
export interface PostAlbumRealItem {
  /** The Telegram reference: a file_id or a bounded https URL. */
  readonly media: string;
  /** True when the reference is a URL (a file_id must be saved after). */
  readonly sentByUrl: boolean;
  /** The media_assets row this item rides (usage binding + file_id save). */
  readonly assetId: string;
}

/** One generated image, ready to upload as multipart bytes. */
export interface PostAlbumGeneratedItem {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** The media_assets row this item rides (usage binding + file_id save). */
  readonly assetId: string;
}

export interface PostAlbumItem {
  /** 0-based ordinal in the album (caption rides ordinal 0 only). */
  readonly ordinal: number;
  readonly kind: 'real' | 'generated';
  readonly media?: string;
  readonly sentByUrl?: boolean;
  readonly bytes?: Uint8Array;
  readonly contentType?: string;
  readonly assetId: string;
}

export type PostAlbumAssembly =
  | {
      readonly ok: true;
      readonly items: readonly PostAlbumItem[];
      /** The generated item's ordinal, or null when the album is real-only. */
      readonly generatedOrdinal: number | null;
    }
  | { readonly ok: false; readonly reason: 'not_an_album' | 'too_many_items' };

/**
 * Assemble ONE post album from real photos + an optional generated
 * image: real first (in given order), generated last, at most 4 items.
 * Fewer than 2 total items is not an album (the caller sends a single
 * photo instead); more than 4 refuses typed — the caller never
 * silently drops a photo to fit.
 */
export function assemblePostAlbum(input: {
  readonly real: readonly PostAlbumRealItem[];
  readonly generated?: PostAlbumGeneratedItem;
}): PostAlbumAssembly {
  const real = input.real;
  const total = real.length + (input.generated === undefined ? 0 : 1);
  if (total < 2) {
    return { ok: false, reason: 'not_an_album' };
  }
  if (total > POST_ALBUM_MAX_ITEMS) {
    return { ok: false, reason: 'too_many_items' };
  }
  const items: PostAlbumItem[] = real.map((item, index) => ({
    ordinal: index,
    kind: 'real' as const,
    media: item.media,
    sentByUrl: item.sentByUrl,
    assetId: item.assetId,
  }));
  if (input.generated !== undefined) {
    items.push({
      ordinal: items.length,
      kind: 'generated' as const,
      bytes: input.generated.bytes,
      contentType: input.generated.contentType,
      assetId: input.generated.assetId,
    });
  }
  return {
    ok: true,
    items,
    generatedOrdinal: input.generated === undefined ? null : items.length - 1,
  };
}
