import { describe, expect, it } from 'vitest';
import { parseFeedDocument } from '../../src/connectors/xml/feed-reader';
import { XML_BOUNDS } from '../../src/connectors/xml/safe-xml';
import gamespotFeedXml from '../fixtures/gamespot-news-2026-11-28.xml?raw';

/**
 * ADR-0079 §3.2 — GameSpot regression fixture: the CURRENT live feed
 * (https://www.gamespot.com/feeds/news/, saved 2026-11-28 05:40 UTC,
 * lastBuildDate Sat, 28 Nov 2026 05:21:04 UTC). The Nov 21–22 polls
 * recorded 5 consecutive `response_malformed` failures for
 * gamespot_news and the source never succeeded once — the feed itself
 * was fine; the scanner rejected it. Root cause, proven by bisecting
 * this document: ONE `content:encoded` CDATA body is 86,704 chars,
 * over the scanner's 65,536-char text-node bound, and the scanner
 * failed the WHOLE document for it. The fix truncates over-long text
 * nodes at the bound instead of failing; this fixture pins the live
 * document parsing end to end.
 */
describe('GameSpot live feed fixture (ADR-0079)', () => {
  it('parses the saved live feed: 30 items', () => {
    const parsed = parseFeedDocument(gamespotFeedXml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.feed.kind).toBe('rss');
    expect(parsed.feed.items).toHaveLength(30);
  });

  it('every item carries an image (media:content)', () => {
    const parsed = parseFeedDocument(gamespotFeedXml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const item of parsed.feed.items) {
      expect(item.imageUrl).not.toBeNull();
    }
    expect(parsed.feed.items[0]?.imageUrl).toBe(
      'https://www.gamespot.com/wp-content/uploads/original/1752/17528202/4665483-12.silksong.jpg?w=300',
    );
    expect(parsed.feed.items[0]?.title).toBe(
      'Hollow Knight: Silksong’s First Expansion Details Coming Friday, Here’s How To Watch',
    );
  });

  it('the over-long article body is truncated at the scanner bound, not fatal', () => {
    const parsed = parseFeedDocument(gamespotFeedXml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const freebie = parsed.feed.items.find((item) =>
      item.title?.includes('Epic Games Store Freebie'),
    );
    expect(freebie).toBeDefined();
    // The 86,704-char CDATA body is cut at the bound — the item still
    // parses, with a full-length body for the excerpt cap downstream.
    // 65,535, not 65,536: the char at the cut is a high surrogate (an
    // emoji in the article HTML), so the surrogate-safe cut backs off
    // one unit rather than orphaning its low half.
    expect(freebie?.bodyText?.length).toBe(XML_BOUNDS.maxTextNodeChars - 1);
  });
});
