import { describe, expect, it } from 'vitest';
import { hasFormMarkers, parseFormMarkers } from '../../src/domain/inbound/form-markers';

/**
 * Form #4 markers (ADR-0073 §3): the Soul rewrite emits `**…**` for the
 * bold headline + main figure and `> …` for a quote + attribution; the
 * formatter turns them into Telegram entities. Pure and deterministic —
 * the marker text itself is never sent to the channel.
 */
describe('inbound form markers', () => {
  it('turns **bold** spans into bold entities and strips the markers', () => {
    const { text, entities } = parseFormMarkers(
      '**تریلر جدید GTA VI**\nفروش به **3.79 میلیارد دلار** رسید.',
    );
    expect(text).toBe('تریلر جدید GTA VI\nفروش به 3.79 میلیارد دلار رسید.');
    expect(text).not.toContain('**');
    expect(entities).toHaveLength(2);
    for (const entity of entities) {
      expect(entity.type).toBe('bold');
      expect(text.slice(entity.offset, entity.offset + entity.length)).not.toBe('');
    }
    expect(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length)).toBe(
      'تریلر جدید GTA VI',
    );
    expect(text.slice(entities[1]!.offset, entities[1]!.offset + entities[1]!.length)).toBe(
      '3.79 میلیارد دلار',
    );
  });

  it('merges consecutive > lines into ONE blockquote entity, newlines included', () => {
    const { text, entities } = parseFormMarkers('> Best trailer of the year\n> — IGN');
    expect(text).toBe('Best trailer of the year\n— IGN');
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: 'blockquote', offset: 0, length: text.length });
  });

  it('keeps a bold span strictly inside its blockquote', () => {
    const { text, entities } = parseFormMarkers('> The **best** trailer\n> — IGN');
    expect(text).toBe('The best trailer\n— IGN');
    const quote = entities.find((entity) => entity.type === 'blockquote');
    const bold = entities.find((entity) => entity.type === 'bold');
    expect(quote).toBeDefined();
    expect(bold).toBeDefined();
    expect(bold!.offset).toBeGreaterThan(quote!.offset);
    expect(bold!.offset + bold!.length).toBeLessThan(quote!.offset + quote!.length);
    expect(text.slice(bold!.offset, bold!.offset + bold!.length)).toBe('best');
  });

  it('strips an unbalanced ** marker instead of sending it literally', () => {
    const { text, entities } = parseFormMarkers('تریلر جدید ** منتشر شد');
    expect(text).not.toContain('**');
    expect(entities).toHaveLength(0);
    expect(hasFormMarkers('تریلر جدید ** منتشر شد')).toBe(false);
  });

  it('strips a whitespace-only ** ** pair and emits no empty entity', () => {
    const { text, entities } = parseFormMarkers('متن ** ** ادامه');
    expect(text).not.toContain('**');
    expect(entities).toHaveLength(0);
  });

  it('leaves plain text untouched with no entities', () => {
    const { text, entities } = parseFormMarkers('تریلر جدید منتشر شد.');
    expect(text).toBe('تریلر جدید منتشر شد.');
    expect(entities).toHaveLength(0);
    expect(hasFormMarkers('تریلر جدید منتشر شد.')).toBe(false);
  });

  it('hasFormMarkers is true for a bold span and for a quote line', () => {
    expect(hasFormMarkers('**تیتر**')).toBe(true);
    expect(hasFormMarkers('متن\n> نقل‌قول')).toBe(true);
  });
});
