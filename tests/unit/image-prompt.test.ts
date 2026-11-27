import { describe, expect, it } from 'vitest';
import {
  IMAGE_CATEGORY_SCENES,
  IMAGE_PROMPT_TAIL,
  buildImagePrompt,
  extractHeadlineTokens,
  extractImagePromptInput,
} from '../../src/domain/ai/image-prompt';

/**
 * AI image prompt builder (ADR-0072) — pure. English, technical,
 * neutral; only the headline's Latin tokens survive; the fixed tail
 * forbids text/logo/watermark in the image.
 */
describe('extractHeadlineTokens', () => {
  it('keeps Latin game/studio tokens in headline order, at most 4', () => {
    expect(extractHeadlineTokens('تریلر جدید GTA VI و Elden Ring منتشر شد')).toEqual([
      'GTA',
      'VI',
      'Elden',
      'Ring',
    ]);
    expect(extractHeadlineTokens('Alpha Beta Gamma Delta Epsilon Zeta Eta')).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ]);
  });

  it('drops Persian words, never transliterates', () => {
    expect(extractHeadlineTokens('خبر مهم از دنیای بازی‌ها')).toEqual([]);
    expect(extractHeadlineTokens('')).toEqual([]);
  });

  it('de-duplicates case-insensitively, keeping the first form', () => {
    expect(extractHeadlineTokens('GTA gta Gta VI')).toEqual(['GTA', 'VI']);
  });
});

describe('buildImagePrompt', () => {
  it('builds a wide 16:9 prompt for breaking news with the scene + tokens + tail', () => {
    const built = buildImagePrompt({ headline: 'فوری: GTA VI تاخیر خورد', categoryEmoji: '🔴' });
    expect(built.aspect).toBe('16:9');
    expect(built.width).toBe(1344);
    expect(built.height).toBe(768);
    expect(built.headlineTokens).toEqual(['GTA', 'VI']);
    expect(built.prompt).toContain(IMAGE_CATEGORY_SCENES['🔴']);
    expect(built.prompt).toContain('GTA VI');
    expect(built.prompt.endsWith(IMAGE_PROMPT_TAIL)).toBe(true);
    expect(built.prompt).not.toContain('screenshot');
    expect(built.prompt).not.toContain('box art');
    expect(built.prompt).not.toContain('official');
  });

  it('builds a square 1:1 prompt for a calm category', () => {
    const built = buildImagePrompt({ headline: 'خبر خوب برای گیمرها', categoryEmoji: '🟢' });
    expect(built.aspect).toBe('1:1');
    expect(built.width).toBe(1024);
    expect(built.height).toBe(1024);
    expect(built.prompt).toContain(IMAGE_CATEGORY_SCENES['🟢']);
  });

  it('still yields a valid prompt from the category scene alone (no Latin tokens)', () => {
    const built = buildImagePrompt({ headline: 'خبر مهم از دنیای بازی‌ها', categoryEmoji: '🎮' });
    expect(built.headlineTokens).toEqual([]);
    expect(built.aspect).toBe('16:9');
    expect(built.prompt.length).toBeGreaterThan(0);
    expect(built.prompt.endsWith(IMAGE_PROMPT_TAIL)).toBe(true);
  });

  it('degrades an unknown category to the default scene and square aspect', () => {
    const built = buildImagePrompt({
      headline: 'GTA VI',
      // @ts-expect-error — an emoji outside the Soul vocabulary is invalid input.
      categoryEmoji: '🦄',
    });
    expect(built.aspect).toBe('1:1');
    expect(built.prompt).toContain('cinematic gaming scene');
  });

  it('never exceeds the flux prompt bound', () => {
    const built = buildImagePrompt({ headline: 'GTA '.repeat(500), categoryEmoji: '🔴' });
    expect(built.prompt.length).toBeLessThanOrEqual(2048);
  });
});

describe('extractImagePromptInput', () => {
  const doc = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      headlineFa: 'تریلر GTA VI منتشر شد',
      categoryEmoji: '🎮',
      ...overrides,
    });

  it('reads headline + category emoji from a valid editorial document', () => {
    expect(extractImagePromptInput(doc())).toEqual({
      headline: 'تریلر GTA VI منتشر شد',
      categoryEmoji: '🎮',
    });
  });

  it('keeps the headline when the emoji is missing or invalid (default scene)', () => {
    expect(extractImagePromptInput(doc({ categoryEmoji: undefined }))).toEqual({
      headline: 'تریلر GTA VI منتشر شد',
    });
    expect(extractImagePromptInput(doc({ categoryEmoji: '🦄' }))).toEqual({
      headline: 'تریلر GTA VI منتشر شد',
    });
  });

  it('refuses unparseable, wrong-version, or headline-less documents (never a guess)', () => {
    expect(extractImagePromptInput('not json')).toBeNull();
    expect(extractImagePromptInput('')).toBeNull();
    expect(extractImagePromptInput(doc({ schemaVersion: 2 }))).toBeNull();
    expect(extractImagePromptInput(doc({ headlineFa: '' }))).toBeNull();
    expect(extractImagePromptInput(doc({ headlineFa: '   ' }))).toBeNull();
    expect(extractImagePromptInput(JSON.stringify(['array']))).toBeNull();
  });
});
