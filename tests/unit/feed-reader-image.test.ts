import { describe, expect, it } from 'vitest';
import { parseFeedDocument } from '../../src/connectors/xml/feed-reader';
import {
  extractImageUrlFromRawJson,
  imageUrlHost,
  isHttpImageUrl,
} from '../../src/domain/media/image-url';

/**
 * ADR-0068 — media by hotlink (no R2): the feed reader carries the
 * item image (RSS enclosure / media:content / media:thumbnail, Atom
 * enclosure link) as `imageUrl`, and the pure image-URL helpers
 * validate it. An item with no usable image has `imageUrl: null` —
 * never a guess, never a fetch.
 */

const IMG = 'https://cdn.example.com/a.jpg';
const IMG2 = 'https://cdn.example.com/b.jpg';

function rssItem(inner: string): string {
  return `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title><item><title>Item</title><link>https://example.com/a</link>${inner}</item></channel></rss>`;
}

function atomEntry(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>e1</id><title>Item</title><link rel="alternate" href="https://example.com/a"/>${inner}</entry></feed>`;
}

describe('parseFeedDocument — item image (ADR-0068)', () => {
  it('takes an RSS enclosure url', () => {
    const parsed = parseFeedDocument(
      rssItem(`<enclosure url="${IMG}" type="image/jpeg" length="123"/>`),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBe(IMG);
  });

  it('takes media:content url', () => {
    const parsed = parseFeedDocument(rssItem(`<media:content url="${IMG2}" medium="image"/>`));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBe(IMG2);
  });

  it('takes media:thumbnail url', () => {
    const parsed = parseFeedDocument(
      rssItem(`<media:thumbnail url="${IMG}" width="800" height="450"/>`),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBe(IMG);
  });

  it('keeps the FIRST valid image in document order', () => {
    const parsed = parseFeedDocument(
      rssItem(
        `<media:content url="${IMG2}" medium="image"/><enclosure url="${IMG}" type="image/jpeg"/>`,
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBe(IMG2);
  });

  it('ignores a non-https enclosure', () => {
    const parsed = parseFeedDocument(
      rssItem('<enclosure url="http://cdn.example.com/a.jpg" type="image/jpeg"/>'),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBeNull();
  });

  it('ignores an over-long image URL', () => {
    const long = `https://cdn.example.com/${'a'.repeat(2040)}.jpg`;
    expect(long.length).toBeGreaterThan(2048);
    const parsed = parseFeedDocument(rssItem(`<enclosure url="${long}" type="image/jpeg"/>`));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBeNull();
  });

  it('takes an Atom enclosure link, never the article link', () => {
    const parsed = parseFeedDocument(
      atomEntry(`<link rel="enclosure" href="${IMG}" type="image/jpeg"/>`),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.feed.items[0]?.imageUrl).toBe(IMG);
      expect(parsed.feed.items[0]?.link).toBe('https://example.com/a');
    }
  });

  it('has no image when the Atom entry has only article links', () => {
    const parsed = parseFeedDocument(atomEntry(''));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBeNull();
  });

  it('has no image when the item carries no media field', () => {
    const parsed = parseFeedDocument(rssItem(''));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBeNull();
  });
});

describe('image-url helpers (ADR-0068)', () => {
  it('isHttpImageUrl accepts https only, bounded, no spaces', () => {
    expect(isHttpImageUrl(IMG)).toBe(true);
    expect(isHttpImageUrl('http://cdn.example.com/a.jpg')).toBe(false);
    expect(isHttpImageUrl('not a url')).toBe(false);
    expect(isHttpImageUrl(null)).toBe(false);
    expect(isHttpImageUrl(`https://cdn.example.com/${'a'.repeat(2040)}.jpg`)).toBe(false);
    expect(isHttpImageUrl('https://cdn.example.com/a b.jpg')).toBe(false);
  });

  it('extractImageUrlFromRawJson reads the flat imageUrl key only', () => {
    expect(extractImageUrlFromRawJson(JSON.stringify({ imageUrl: IMG }))).toBe(IMG);
    expect(extractImageUrlFromRawJson({ imageUrl: IMG })).toBe(IMG);
    expect(extractImageUrlFromRawJson(JSON.stringify({ imageUrl: 'http://x/y.jpg' }))).toBeNull();
    expect(extractImageUrlFromRawJson(JSON.stringify({ nested: { imageUrl: IMG } }))).toBeNull();
    expect(extractImageUrlFromRawJson('not json')).toBeNull();
    expect(extractImageUrlFromRawJson(null)).toBeNull();
  });

  it('imageUrlHost returns the lower-cased host, null otherwise', () => {
    expect(imageUrlHost('https://CDN.Example.COM/a.jpg')).toBe('cdn.example.com');
    expect(imageUrlHost('http://cdn.example.com/a.jpg')).toBeNull();
  });
});

describe('parseFeedDocument — content:encoded <img> fallback (ADR-0079)', () => {
  const IMG_A = 'https://cdn.example.com/encoded-a.jpg';
  const IMG_B = 'https://cdn.example.com/encoded-b.jpg';
  const MEDIA = 'https://cdn.example.com/media.jpg';

  function rssEncodedItem(inner: string): string {
    return `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title><item><title>Item</title><link>https://example.com/a</link>${inner}</item></channel></rss>`;
  }

  it('takes the first <img src> from content:encoded when no media image exists', () => {
    const parsed = parseFeedDocument(
      rssEncodedItem(
        `<content:encoded><![CDATA[<p>Text</p><img src="${IMG_A}"><img src="${IMG_B}">]]></content:encoded>`,
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBe(IMG_A);
  });

  it('a media:content image wins even when it comes after content:encoded', () => {
    const parsed = parseFeedDocument(
      rssEncodedItem(
        `<content:encoded><![CDATA[<img src="${IMG_A}">]]></content:encoded><media:content url="${MEDIA}" medium="image"/>`,
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBe(MEDIA);
  });

  it('ignores a non-https <img src> and takes the next valid one', () => {
    const parsed = parseFeedDocument(
      rssEncodedItem(
        `<content:encoded><![CDATA[<img src="http://example.com/plain.jpg"><img src="${IMG_B}">]]></content:encoded>`,
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBe(IMG_B);
  });

  it('no <img> in the encoded body leaves the item imageless', () => {
    const parsed = parseFeedDocument(
      rssEncodedItem(`<content:encoded><![CDATA[<p>No image here</p>]]></content:encoded>`),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBeNull();
  });

  it('takes the first <img src> from an Atom content body too', () => {
    const parsed = parseFeedDocument(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>e1</id><title>Item</title><link rel="alternate" href="https://example.com/a"/><content type="html">&lt;img src="${IMG_A}"&gt;</content></entry></feed>`,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.feed.items[0]?.imageUrl).toBe(IMG_A);
  });
});
