import { describe, expect, it } from 'vitest';
import {
  EDITORIAL_POST_LABELS,
  foldDigitsToLatin,
  isolateLatinSpan,
  renderEditorialPostCaption,
  renderEditorialPostText,
} from '../../src/domain/admin-post/editorial-post-render';
import { readRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';

/**
 * R1.22 Phase A — the v3 editorial→post render contract (ADR-0071):
 * the owner-approved msg-16 form — bold emoji title + Latin game name on
 * its own line, body, real-quote blockquote, ONE figures block (each
 * figure exactly once, Latin digits only, main figure bold+mono), an
 * unlabeled verdict, and the house footer — with NO trust label, NO ⏺
 * separator, NO unverified line, NO 'حرف آخر:' label, and NO source line.
 */

const LRI = '\u2066';
const PDI = '\u2069';

const HEADLINE = 'فروش خیره‌کننده در روز نخست';
const SUMMARY =
  'بالاخره اومد و از همون روز اول رکوردها رو جابه‌جا کرد — بزرگ‌ترین لانچ تاریخ سرگرمی.';
const GAME_NAME = 'Grand Theft Auto VI';
const GAME_URL = 'https://www.rockstargames.com/VI';
const QUOTE_TEXT =
  'It is with immense gratitude that we enter a new chapter of Rockstar Games with the release of Grand Theft Auto VI.';
const QUOTE_ATTRIBUTION = 'Sam Houser';
const VERDICT = 'این تازه شروعشه — عددهای هفتهٔ اول رو هم دنبال می‌کنیم.';

/** The GTA v3 document — the stored shape behind the live msg-16 example. */
function gtaDocumentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    headlineFa: HEADLINE,
    summaryFa: SUMMARY,
    soulForm: { categoryEmoji: '🏆', trustLabel: '#تأییدشده' },
    gameName: GAME_NAME,
    gamePageUrl: GAME_URL,
    quote: { text: QUOTE_TEXT, attribution: QUOTE_ATTRIBUTION },
    figures: [
      { label: 'فروش روز اول', value: '$3.79B', main: true },
      { label: 'پیش‌خرید', value: '32.5M' },
    ],
    verdict: VERDICT,
    modelClaims: [{ text: 'فروش ۳٫۷۹ میلیارد دلار و ۳۲٫۵ میلیون نسخه بود.', status: 'unverified' }],
    sourceReport: {
      sourceItemId: 'item-1',
      sourceName: 'Gematsu',
      stance: 'mentions',
      excerptText: 'excerpt',
      truncated: false,
    },
    ...overrides,
  });
}

/** The exact v3 text for the GTA document (LRI/PDI written out). */
const GTA_TITLE_LINE = `🏆 ${HEADLINE}`;
const GTA_GAME_LINE = `${LRI}${GAME_NAME}${PDI}`;
const GTA_QUOTE_BLOCK = `«${LRI}${QUOTE_TEXT}${PDI}»\n— ${LRI}${QUOTE_ATTRIBUTION}${PDI}`;
const GTA_FIGURES_BLOCK = `فروش روز اول: ${LRI}$3.79B${PDI}\nپیش‌خرید: ${LRI}32.5M${PDI}`;
const GTA_EXPECTED_TEXT = [
  `${GTA_TITLE_LINE}\n${GTA_GAME_LINE}`,
  SUMMARY,
  GTA_QUOTE_BLOCK,
  GTA_FIGURES_BLOCK,
  VERDICT,
  EDITORIAL_POST_LABELS.footer,
].join('\n\n');

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('v3 — renderEditorialPostText reproduces the approved msg-16 form', () => {
  it('renders the full GTA form byte-for-byte: title+game line, body, quote, figures, verdict, footer', () => {
    const outcome = renderEditorialPostText(gtaDocumentJson());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe(GTA_EXPECTED_TEXT);
    expect(outcome.envelope.kind).toBe('text');
    expect(outcome.envelope.text).toBe(outcome.text);

    // Title bold; game name italic + text_link over exactly the name.
    const titleLen = GTA_TITLE_LINE.length;
    const nameOffset = outcome.text.indexOf(GAME_NAME);
    expect(outcome.envelope.entities).toContainEqual({
      type: 'bold',
      offset: 0,
      length: titleLen,
    });
    expect(outcome.envelope.entities).toContainEqual({
      type: 'italic',
      offset: nameOffset,
      length: GAME_NAME.length,
    });
    expect(outcome.envelope.entities).toContainEqual({
      type: 'text_link',
      offset: nameOffset,
      length: GAME_NAME.length,
      url: GAME_URL,
    });

    // Quote blockquote over the whole quote block (attribution on its own
    // line INSIDE it); figures: main line bold with the mono value inside,
    // second figure mono only; footer blockquote.
    const quoteOffset = outcome.text.indexOf('«');
    expect(outcome.envelope.entities).toContainEqual({
      type: 'blockquote',
      offset: quoteOffset,
      length: GTA_QUOTE_BLOCK.length,
    });
    const fig1Offset = outcome.text.indexOf('فروش روز اول:');
    const fig1Line = `فروش روز اول: ${LRI}$3.79B${PDI}`;
    expect(outcome.envelope.entities).toContainEqual({
      type: 'bold',
      offset: fig1Offset,
      length: fig1Line.length,
    });
    expect(outcome.envelope.entities).toContainEqual({
      type: 'code',
      offset: outcome.text.indexOf('$3.79B'),
      length: '$3.79B'.length,
    });
    expect(outcome.envelope.entities).toContainEqual({
      type: 'code',
      offset: outcome.text.indexOf('32.5M'),
      length: '32.5M'.length,
    });
    expect(outcome.envelope.entities).toContainEqual({
      type: 'blockquote',
      offset: outcome.text.length - EDITORIAL_POST_LABELS.footer.length,
      length: EDITORIAL_POST_LABELS.footer.length,
    });
  });

  it('never repeats a figure: each value appears exactly once, in the figures block', () => {
    const outcome = renderEditorialPostText(gtaDocumentJson());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(countOccurrences(outcome.text, '$3.79B')).toBe(1);
    expect(countOccurrences(outcome.text, '32.5M')).toBe(1);
    // The body carries no figure at all: the only '32.5' in the post is the figure itself.
    expect(outcome.text.split('32.5').length - 1).toBe(1);
  });

  it('renders Latin digits only — Persian/Arabic digits fold at render time, never stored', () => {
    const outcome = renderEditorialPostText(gtaDocumentJson());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).not.toMatch(/[۰-۹٠-٩]/);
    expect(outcome.text).not.toContain('۳٫۷۹');
    // The stored document is untouched: the source JSON still has them.
    expect(gtaDocumentJson()).toContain('۳٫۷۹');
  });

  it('never renders the trust label, the ⏺ separator, the unverified line, the حرف آخر label, or a source line', () => {
    const outcome = renderEditorialPostText(gtaDocumentJson());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).not.toContain('#تأییدشده');
    expect(outcome.text).not.toContain('تأییدشده');
    expect(outcome.text).not.toContain('⏺');
    expect(outcome.text).not.toContain('وضعیت:');
    expect(outcome.text).not.toContain('unverified');
    expect(outcome.text).not.toContain('حرف آخر');
    expect(outcome.text).not.toContain('Gematsu');
    expect(outcome.text).not.toContain('منبع');
    // The emojis stay: category emoji in the title, house footer emoji.
    expect(outcome.text).toContain('🏆');
    expect(outcome.text).toContain('👾 @pixellores');
    expect(outcome.text.endsWith(EDITORIAL_POST_LABELS.footer)).toBe(true);
  });

  it('is deterministic and round-trips through the defensive envelope reader unchanged', () => {
    const first = renderEditorialPostText(gtaDocumentJson());
    const second = renderEditorialPostText(gtaDocumentJson());
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const serialized = JSON.stringify({
      schemaVersion: first.envelope.schemaVersion,
      kind: first.envelope.kind,
      text: first.envelope.text,
      entities: first.envelope.entities,
    });
    const read = readRichTextEnvelope(serialized);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.envelope.text).toBe(first.text);
      expect(read.envelope.entities).toEqual(first.envelope.entities);
    }
  });

  it('derives the figures block from the claims when no structured figures exist', () => {
    const outcome = renderEditorialPostText(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: 'فروش خیره‌کننده در روز نخست',
        summaryFa: 'بالاخره اومد و رکوردها رو جابه‌جا کرد.',
        soulForm: { categoryEmoji: '🏆', trustLabel: '#گزارش‌شده' },
        modelClaims: [
          { text: 'فروش روز اول ۳٫۷۹ میلیارد دلار بود.', status: 'unverified' },
          { text: 'پیش‌خرید ۳۲٫۵ میلیون نسخه بود.', status: 'unverified' },
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // First derived figure is main (bold line + mono value); the second is mono only.
    expect(outcome.text).toContain(`فروش روز اول: ${LRI}$3.79B${PDI}`);
    expect(outcome.text).toContain(`پیش‌خرید: ${LRI}32.5M نسخه${PDI}`);
    expect(outcome.text).not.toMatch(/[۰-۹٠-٩]/);
    expect(countOccurrences(outcome.text, '$3.79B')).toBe(1);
    expect(countOccurrences(outcome.text, '32.5M')).toBe(1);
    const figOffset = outcome.text.indexOf('فروش روز اول:');
    expect(outcome.envelope.entities).toContainEqual({
      type: 'bold',
      offset: figOffset,
      length: `فروش روز اول: ${LRI}$3.79B${PDI}`.length,
    });
    expect(outcome.envelope.entities).toContainEqual({
      type: 'code',
      offset: outcome.text.indexOf('$3.79B'),
      length: 6,
    });
  });

  it('derives two figure lines from one two-number claim, without losing either figure', () => {
    const outcome = renderEditorialPostText(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: 'فروش خیره‌کننده در روز نخست',
        summaryFa: 'بالاخره اومد.',
        modelClaims: [
          { text: 'فروش ۳٫۷۹ میلیارد دلار و ۳۲٫۵ میلیون نسخه بود.', status: 'unverified' },
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('$3.79B');
    expect(outcome.text).toContain('32.5M');
    expect(countOccurrences(outcome.text, '$3.79B')).toBe(1);
    expect(countOccurrences(outcome.text, '32.5M')).toBe(1);
  });

  it('renders no figures block (and no invented content) when no claim carries a number', () => {
    const outcome = renderEditorialPostText(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: 'به‌روزرسانی بزرگ بازی نمونه منتشر شد',
        summaryFa: 'استودیوی نمونه از انتشار به‌روزرسانی بزرگ خبر داد.',
        modelClaims: [
          { text: 'به‌روزرسانی با بخش داستانی تازه در دسترس است.', status: 'unverified' },
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe(
      [
        'به‌روزرسانی بزرگ بازی نمونه منتشر شد',
        'استودیوی نمونه از انتشار به‌روزرسانی بزرگ خبر داد.',
        EDITORIAL_POST_LABELS.footer,
      ].join('\n\n'),
    );
  });

  it('takes the game name from the longest Latin alias in the mentions report when no gameName is stored', () => {
    const outcome = renderEditorialPostText(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: HEADLINE,
        summaryFa: SUMMARY,
        entityMentions: {
          mentionsVersion: 1,
          matched: [
            { normalizedAlias: 'GTA VI', entityId: 'e-1' },
            { normalizedAlias: 'Grand Theft Auto VI', entityId: 'e-2' },
            { normalizedAlias: 'جی‌تی‌ای', entityId: 'e-3' },
          ],
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain(`${LRI}Grand Theft Auto VI${PDI}`);
    expect(outcome.text).not.toContain('جی‌تی‌ای');
  });

  it('renders a plain italic game name when no game-page URL is stored (link is optional, never required)', () => {
    const outcome = renderEditorialPostText(gtaDocumentJson({ gamePageUrl: undefined }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe(GTA_EXPECTED_TEXT);
    const nameOffset = outcome.text.indexOf(GAME_NAME);
    expect(outcome.envelope.entities).toContainEqual({
      type: 'italic',
      offset: nameOffset,
      length: GAME_NAME.length,
    });
    expect(outcome.envelope.entities.some((entity) => entity.type === 'text_link')).toBe(false);
  });

  it('renders no quote block and no verdict when the document carries neither (never invented)', () => {
    const outcome = renderEditorialPostText(
      gtaDocumentJson({ quote: undefined, verdict: undefined, figures: undefined }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).not.toContain('«');
    expect(outcome.text).not.toContain(VERDICT);
  });

  it('uses expandable_blockquote for a long quote', () => {
    const longQuote =
      'It is with immense gratitude that we enter a new chapter of Rockstar Games with the release of Grand Theft Auto VI. '.repeat(
        3,
      );
    const outcome = renderEditorialPostText(
      gtaDocumentJson({ quote: { text: longQuote, attribution: QUOTE_ATTRIBUTION } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      outcome.envelope.entities.some((entity) => entity.type === 'expandable_blockquote'),
    ).toBe(true);
    expect(outcome.envelope.entities.some((entity) => entity.type === 'blockquote')).toBe(true); // footer
  });

  it('keeps a quote without attribution as a single-line blockquote', () => {
    const outcome = renderEditorialPostText(gtaDocumentJson({ quote: { text: QUOTE_TEXT } }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain(`«${LRI}${QUOTE_TEXT}${PDI}»`);
    // No attribution LINE (the body/verdict may still carry an em dash mid-sentence).
    expect(outcome.text).not.toContain('\n— ');
  });

  it('renders a prompt-v1 document (no soulForm) with a plain headline and no emoji', () => {
    const outcome = renderEditorialPostText(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: HEADLINE,
        summaryFa: SUMMARY,
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe([HEADLINE, SUMMARY, EDITORIAL_POST_LABELS.footer].join('\n\n'));
    expect(outcome.envelope.entities).toContainEqual({
      type: 'bold',
      offset: 0,
      length: HEADLINE.length,
    });
  });

  it('folds Persian digits and isolates Latin runs inside Persian text', () => {
    expect(foldDigitsToLatin('۳٫۷۹ میلیارد و ۳۲٫۵ میلیون')).toBe('3.79 میلیارد و 32.5 میلیون');
    expect(isolateLatinSpan('بازی GTA VI منتشر شد')).toBe(
      `بازی ${LRI}GTA${PDI} ${LRI}VI${PDI} منتشر شد`,
    );
    const outcome = renderEditorialPostText(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: 'فروش ۳٫۷۹ میلیارد دلاری در روز نخست',
        summaryFa: 'بازی GTA VI منتشر شد.',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain(`فروش ${LRI}3.79${PDI} میلیارد دلاری در روز نخست`);
    expect(outcome.text).toContain(`بازی ${LRI}GTA${PDI} ${LRI}VI${PDI} منتشر شد.`);
    expect(outcome.text).not.toMatch(/[۰-۹٠-٩]/);
  });

  it('accepts claims on their text alone: a non-unverified or missing status no longer fails the render', () => {
    const base = {
      schemaVersion: 1,
      headlineFa: HEADLINE,
      summaryFa: SUMMARY,
    };
    for (const modelClaims of [
      [{ text: 'ادعای آزمون.', status: 'verified' }],
      [{ text: 'ادعای آزمون.' }],
      [{ text: 'ادعای آزمون.', status: 'confirmed' }],
    ]) {
      const outcome = renderEditorialPostText(JSON.stringify({ ...base, modelClaims }));
      expect(outcome.ok).toBe(true);
    }
  });

  it('fails typed on malformed JSON / non-object / unsupported version', () => {
    expect(renderEditorialPostText('not json')).toEqual({
      ok: false,
      reason: 'malformed_json',
    });
    expect(renderEditorialPostText('[]')).toEqual({ ok: false, reason: 'malformed_document' });
    expect(
      renderEditorialPostText(JSON.stringify({ schemaVersion: 2, headlineFa: HEADLINE })),
    ).toEqual({ ok: false, reason: 'unsupported_version' });
  });

  it('fails typed on an empty/missing headline and wrong-typed core fields', () => {
    expect(renderEditorialPostText(JSON.stringify({ schemaVersion: 1 }))).toEqual({
      ok: false,
      reason: 'empty_headline',
    });
    expect(renderEditorialPostText(JSON.stringify({ schemaVersion: 1, headlineFa: '' }))).toEqual({
      ok: false,
      reason: 'empty_headline',
    });
    expect(renderEditorialPostText(JSON.stringify({ schemaVersion: 1, headlineFa: 42 }))).toEqual({
      ok: false,
      reason: 'malformed_document',
    });
    expect(
      renderEditorialPostText(
        JSON.stringify({ schemaVersion: 1, headlineFa: HEADLINE, summaryFa: 7 }),
      ),
    ).toEqual({ ok: false, reason: 'malformed_document' });
    expect(renderEditorialPostText(gtaDocumentJson({ sourceReport: 'not an object' }))).toEqual({
      ok: false,
      reason: 'malformed_document',
    });
  });

  it('fails typed on malformed claims (non-list, non-object, empty text) — but not on status', () => {
    expect(renderEditorialPostText(gtaDocumentJson({ modelClaims: [{ text: '' }] }))).toEqual({
      ok: false,
      reason: 'malformed_document',
    });
    expect(renderEditorialPostText(gtaDocumentJson({ modelClaims: 'not a list' }))).toEqual({
      ok: false,
      reason: 'malformed_document',
    });
  });

  it('fails typed on malformed v3 fields: bad emoji, two main figures, bad quote, bad game URL', () => {
    expect(
      renderEditorialPostText(
        gtaDocumentJson({ soulForm: { categoryEmoji: '💥', trustLabel: '#رسمی' } }),
      ),
    ).toEqual({ ok: false, reason: 'malformed_document' });
    expect(renderEditorialPostText(gtaDocumentJson({ soulForm: { categoryEmoji: '🏆' } }))).toEqual(
      { ok: false, reason: 'malformed_document' },
    );
    expect(
      renderEditorialPostText(
        gtaDocumentJson({
          figures: [
            { label: 'الف', value: '1', main: true },
            { label: 'ب', value: '2', main: true },
          ],
        }),
      ),
    ).toEqual({ ok: false, reason: 'malformed_document' });
    expect(renderEditorialPostText(gtaDocumentJson({ quote: { text: '' } }))).toEqual({
      ok: false,
      reason: 'malformed_document',
    });
    expect(
      renderEditorialPostText(gtaDocumentJson({ gamePageUrl: 'javascript:alert(1)' })),
    ).toEqual({ ok: false, reason: 'malformed_document' });
    expect(
      renderEditorialPostText(gtaDocumentJson({ gamePageUrl: 'https://example.com/VI' })),
    ).toEqual({
      ok: true,
      envelope: expect.anything(),
      text: expect.any(String),
    });
  });

  it('fails typed (no truncation) when the composed text exceeds the 4096-unit post limit', () => {
    const hugeSummary = 'خ'.repeat(4200);
    const outcome = renderEditorialPostText(
      JSON.stringify({ schemaVersion: 1, headlineFa: HEADLINE, summaryFa: hugeSummary }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('text_too_large');
  });
});

describe('v3 — renderEditorialPostCaption (photo send, 1024-unit cap)', () => {
  it('renders the same GTA form as a caption, untrimmed, when it fits', () => {
    const caption = renderEditorialPostCaption(gtaDocumentJson());
    const text = renderEditorialPostText(gtaDocumentJson());
    expect(caption.ok).toBe(true);
    expect(text.ok).toBe(true);
    if (!caption.ok || !text.ok) return;
    expect(caption.envelope.kind).toBe('caption');
    expect(caption.text).toBe(text.text);
    expect(caption.text.length).toBeLessThanOrEqual(1024);
    expect(caption.trimmed).toBe(false);
    expect(caption.envelope.entities).toEqual(text.envelope.entities);
  });

  it('trims a long body to the caption cap (photo kept, never a second send)', () => {
    const caption = renderEditorialPostCaption(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: HEADLINE,
        summaryFa: 'متن طولانی خبر. '.repeat(90),
      }),
    );
    expect(caption.ok).toBe(true);
    if (!caption.ok) return;
    expect(caption.envelope.kind).toBe('caption');
    expect(caption.text.length).toBeLessThanOrEqual(1024);
    expect(caption.trimmed).toBe(true);
    expect(caption.text).toContain(HEADLINE);
    expect(caption.text.endsWith(EDITORIAL_POST_LABELS.footer)).toBe(true);
    expect(caption.text).toContain('…');
  });

  it('drops the verdict and the quote before trimming the body, and keeps the figures', () => {
    const caption = renderEditorialPostCaption(
      gtaDocumentJson({ summaryFa: 'متن طولانی خبر. '.repeat(70) }),
    );
    expect(caption.ok).toBe(true);
    if (!caption.ok) return;
    expect(caption.text.length).toBeLessThanOrEqual(1024);
    expect(caption.trimmed).toBe(true);
    // Figures survive (keep-priority); verdict + quote were dropped first.
    expect(caption.text).toContain('$3.79B');
    expect(caption.text).toContain('32.5M');
    expect(caption.text).not.toContain(VERDICT);
    expect(caption.text).not.toContain('Sam Houser');
    expect(caption.text).toContain(HEADLINE);
    expect(caption.text.endsWith(EDITORIAL_POST_LABELS.footer)).toBe(true);
  });

  it('is deterministic: the same document bytes trim to the same caption', () => {
    const first = renderEditorialPostCaption(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: HEADLINE,
        summaryFa: 'متن طولانی خبر. '.repeat(90),
      }),
    );
    const second = renderEditorialPostCaption(
      JSON.stringify({
        schemaVersion: 1,
        headlineFa: HEADLINE,
        summaryFa: 'متن طولانی خبر. '.repeat(90),
      }),
    );
    expect(first).toEqual(second);
  });
});
