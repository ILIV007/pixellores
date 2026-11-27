import { describe, expect, it } from 'vitest';
import { POST_ALBUM_MAX_ITEMS, assemblePostAlbum } from '../../src/domain/media/post-album';

/**
 * Post-album assembly (ADR-0072) — pure. Real-first / generated-last,
 * at most 4 items; fewer than 2 is not an album; more than 4 refuses
 * typed (never silently drops a photo).
 */
const real = (n: number) =>
  Array.from({ length: n }, (_, index) => ({
    media: `file-photo-${index + 1}`,
    sentByUrl: index % 2 === 1,
    assetId: `mda-${index + 1}`,
  }));

describe('assemblePostAlbum', () => {
  it('refuses a single photo: not an album (the caller sends a single photo)', () => {
    expect(assemblePostAlbum({ real: real(1) })).toEqual({
      ok: false,
      reason: 'not_an_album',
    });
    expect(assemblePostAlbum({ real: [] })).toEqual({
      ok: false,
      reason: 'not_an_album',
    });
    expect(
      assemblePostAlbum({
        real: real(1),
        generated: { bytes: new Uint8Array([1]), contentType: 'image/jpeg', assetId: 'mda-g' },
      }),
    ).toEqual({ ok: true, items: expect.any(Array), generatedOrdinal: 1 });
  });

  it('orders 2 real photos with ordinals and no generated slot', () => {
    const assembled = assemblePostAlbum({ real: real(2) });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.items).toHaveLength(2);
    expect(assembled.items.map((item) => item.ordinal)).toEqual([0, 1]);
    expect(assembled.items.map((item) => item.kind)).toEqual(['real', 'real']);
    expect(assembled.items.map((item) => item.media)).toEqual(['file-photo-1', 'file-photo-2']);
    expect(assembled.items[1]?.sentByUrl).toBe(true);
    expect(assembled.generatedOrdinal).toBeNull();
  });

  it('pins a generated image LAST (real-first, generated-last) with its ordinal', () => {
    const assembled = assemblePostAlbum({
      real: real(3),
      generated: { bytes: new Uint8Array([9]), contentType: 'image/jpeg', assetId: 'mda-g' },
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.items).toHaveLength(4);
    expect(assembled.items.map((item) => item.kind)).toEqual(['real', 'real', 'real', 'generated']);
    expect(assembled.generatedOrdinal).toBe(3);
    expect(assembled.items[3]?.assetId).toBe('mda-g');
    expect(assembled.items[3]?.bytes).toEqual(new Uint8Array([9]));
  });

  it('refuses more than 4 total items (never silently drops a photo)', () => {
    expect(assemblePostAlbum({ real: real(5) })).toEqual({
      ok: false,
      reason: 'too_many_items',
    });
    expect(
      assemblePostAlbum({
        real: real(4),
        generated: { bytes: new Uint8Array([1]), contentType: 'image/jpeg', assetId: 'mda-g' },
      }),
    ).toEqual({ ok: false, reason: 'too_many_items' });
  });

  it('accepts exactly 4 real photos (the plan cap)', () => {
    const assembled = assemblePostAlbum({ real: real(4) });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.items).toHaveLength(POST_ALBUM_MAX_ITEMS);
    expect(POST_ALBUM_MAX_ITEMS).toBe(4);
  });
});
