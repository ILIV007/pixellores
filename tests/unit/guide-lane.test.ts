import { describe, expect, it } from 'vitest';
import {
  classifyPostLane,
  GUIDE_PUBLISH_PRIORITY_SCORE,
  MAX_GUIDES_PER_BRIDGE_PASS,
} from '../../src/domain/publishing/guide-lane';

/**
 * ADR-0068 — quality fix #5: the guide lane. A `/guide/` path
 * segment makes a guide; anything else is news. Guides are KEPT —
 * the lane only shapes order (at most one per bridge pass, P2).
 */
describe('classifyPostLane', () => {
  it('classifies VGC /guide/ URLs as guides', () => {
    expect(
      classifyPostLane('https://www.videogameschronicle.com/guide/gta-6-all-safe-locations/'),
    ).toBe('guide');
  });

  it('classifies plain news URLs as news', () => {
    expect(
      classifyPostLane('https://www.videogameschronicle.com/news/gta-6-earns-3-79-billion/'),
    ).toBe('news');
  });

  it('matches a /guide/ PATH segment only, not a query or host', () => {
    expect(classifyPostLane('https://example.com/news/?guide=true')).toBe('news');
    expect(classifyPostLane('https://guide.example.com/news/x')).toBe('news');
    expect(classifyPostLane('https://example.com/GUIDE/x')).toBe('guide');
    expect(classifyPostLane('https://example.com/guidebook/x')).toBe('news');
  });

  it('treats a missing or malformed URL as news (never blocks)', () => {
    expect(classifyPostLane(null)).toBe('news');
    expect(classifyPostLane('not a url')).toBe('news');
  });

  it('pins the lane constants', () => {
    expect(GUIDE_PUBLISH_PRIORITY_SCORE).toBe(60);
    expect(MAX_GUIDES_PER_BRIDGE_PASS).toBe(1);
  });
});
