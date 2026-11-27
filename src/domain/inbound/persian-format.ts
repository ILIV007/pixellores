/**
 * Slice 4 — Persian format + normalization (blueprint persona §4, DESIGN
 * §10.1/§10.3).
 *
 * The deterministic renderer-side step: Arabic ي/ك/ة → Persian, whitespace
 * normalization, ZWNJ preserved, bidirectional isolation for Latin/URL
 * runs, and chunking that NEVER silently truncates — long text splits on
 * paragraph/line/word boundaries with `i/N` page numbers, the footer lives
 * only on the last part.
 *
 * The footer `👾 @pixellores` is rendered here, never by the model.
 * Pure: same input, same output.
 */

import type { RichTextEntity } from '../telegram/rich-text-envelope';
import { parseFormMarkers } from './form-markers';

export const INBOUND_FOOTER = '👾 @pixellores';

/** Telegram text limit (RICH_TEXT_LIMITS.maxTextUnits) and caption limit. */
export const INBOUND_TEXT_LIMIT = 4096;
export const INBOUND_CAPTION_LIMIT = 1024;

const FOOTER_BLOCK = `\n\n${INBOUND_FOOTER}`;

/** Latin/URL runs embedded in Persian text get bidi isolation (LRI/PDI). */
const LATIN_RUN = /[A-Za-z0-9@][A-Za-z0-9@:/?#._~%+&=;,-]*[A-Za-z0-9@/?#._~%+&=;-]|[A-Za-z0-9@]/g;
const HAS_PERSIAN = /[\u0600-\u06FF]/;

export function normalizePersianText(text: string): string {
  let normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ى/g, 'ی')
    .replace(/ة/g, 'ه')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  if (HAS_PERSIAN.test(normalized)) {
    normalized = normalized.replace(LATIN_RUN, (run) => `\u2066${run}\u2069`);
  }
  return normalized;
}

/**
 * Fold Persian/Arabic digits to Latin (ADR-0066 mapping, reused here
 * for the render: form #4 is Latin digits only). A 1:1 code-point map,
 * so entity offsets are preserved exactly.
 */
export function foldDigitsToLatin(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9\u066B\u066C]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    if (code >= 0x0660 && code <= 0x0669) {
      return String(code - 0x0660);
    }
    if (code >= 0x06f0 && code <= 0x06f9) {
      return String(code - 0x06f0);
    }
    return code === 0x066b ? '.' : ',';
  });
}

/**
 * Drop a trailing footer line (`👾 @pixellores`) when other content
 * exists — the formatter always appends the footer itself, so a
 * model- or owner-supplied one would otherwise duplicate it. A text
 * that IS only the footer is left untouched (degenerate input keeps
 * the old behavior).
 */
function stripTrailingFooterLine(text: string): string {
  const lines = text.split('\n');
  const last = lines[lines.length - 1]?.trim();
  if (last !== INBOUND_FOOTER || lines.length < 2) {
    return text;
  }
  const kept = lines.slice(0, -1);
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') {
    kept.pop();
  }
  return kept.join('\n');
}

export interface InboundPostPart {
  /** 'caption' = the media caption (first part of a media post). */
  readonly kind: 'text' | 'caption';
  readonly text: string;
  /**
   * Form #4 entities (bold / blockquote) in this part's coordinates.
   * Empty (or absent) when the part carries no structure.
   */
  readonly entities?: readonly RichTextEntity[];
}

/** Clamp entities to [start, start+length) in the source text, rebased to 0. */
function clampEntities(
  entities: readonly RichTextEntity[],
  start: number,
  partText: string,
): RichTextEntity[] {
  const end = start + partText.length;
  const out: RichTextEntity[] = [];
  for (const entity of entities) {
    const entityStart = entity.offset;
    const entityEnd = entity.offset + entity.length;
    if (entityEnd <= start || entityStart >= end) {
      continue;
    }
    let s = Math.max(entityStart, start) - start;
    let e = Math.min(entityEnd, end) - start;
    // Never split a surrogate pair at a clamp boundary: shrink the
    // range to the pair boundary instead (the envelope validator
    // rejects a range that splits a pair).
    if (s > 0 && s < partText.length) {
      const before = partText.charCodeAt(s - 1);
      const at = partText.charCodeAt(s);
      if (before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff) {
        s += 1;
      }
    }
    if (e > 0 && e < partText.length) {
      const before = partText.charCodeAt(e - 1);
      const at = partText.charCodeAt(e);
      if (before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff) {
        e -= 1;
      }
    }
    if (e > s) {
      out.push({ ...entity, offset: s, length: e - s });
    }
  }
  return out;
}

/** Chunk text with its entities: chunks partition the input exactly. */
function splitParts(
  text: string,
  entities: readonly RichTextEntity[],
  maxUnits: number,
  kind: 'text' | 'caption',
): InboundPostPart[] {
  const chunks = chunkPostText(text, maxUnits);
  const parts: InboundPostPart[] = [];
  let start = 0;
  for (const chunk of chunks) {
    parts.push({ kind, text: chunk, entities: clampEntities(entities, start, chunk) });
    start += chunk.length;
  }
  return parts;
}

/** Prepend the `i/N` page-number prefix, shifting each part's entities. */
function addPageNumbersToParts(parts: readonly InboundPostPart[]): InboundPostPart[] {
  if (parts.length <= 1) {
    return [...parts];
  }
  return parts.map((part, index) => {
    const prefix = `${index + 1}/${parts.length}\n\n`;
    return {
      ...part,
      text: `${prefix}${part.text}`,
      entities: (part.entities ?? []).map((entity) => ({
        ...entity,
        offset: entity.offset + prefix.length,
      })),
    };
  });
}

/**
 * Append the footer to the last part, re-chunking it (with its entities)
 * when it cannot hold the footer — the entity-aware twin of `withFooter`.
 */
function addFooterToParts(parts: readonly InboundPostPart[], maxUnits: number): InboundPostPart[] {
  if (parts.length === 0) {
    return [];
  }
  const result = [...parts];
  const last = result[result.length - 1] as InboundPostPart;
  if (last.text.length + FOOTER_BLOCK.length <= maxUnits) {
    result[result.length - 1] = { ...last, text: `${last.text}${FOOTER_BLOCK}` };
    return result;
  }
  const rechunked = splitParts(
    last.text,
    last.entities ?? [],
    maxUnits - FOOTER_BLOCK.length,
    last.kind,
  );
  // Only the first re-chunked piece keeps the last part's kind — the
  // overflow pieces are plain text parts (a caption re-chunked for the
  // footer must not produce a second 'caption' part).
  const fixed = rechunked.map((piece, index) =>
    index === 0 ? piece : { ...piece, kind: 'text' as const },
  );
  result.splice(result.length - 1, 1, ...fixed);
  const finalLast = result[result.length - 1] as InboundPostPart;
  result[result.length - 1] = { ...finalLast, text: `${finalLast.text}${FOOTER_BLOCK}` };
  return result;
}

/**
 * Split text into chunks of at most `maxUnits` UTF-16 units, on paragraph,
 * line, then word boundaries — never mid-word unless a single word exceeds
 * the limit (then it is hard-split: the only way to stay within the bound).
 * The chunks partition the input exactly: joining them reproduces it.
 */
export function chunkPostText(text: string, maxUnits: number): string[] {
  if (text.length <= maxUnits) {
    return text === '' ? [] : [text];
  }
  // Atoms keep their separators, so the chunk join reproduces the input.
  const atoms = text.split(/(\n\n|\n| )/g).filter((atom) => atom !== '');
  const chunks: string[] = [];
  let current = '';
  for (const atom of atoms) {
    if (current.length + atom.length <= maxUnits) {
      current += atom;
      continue;
    }
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
    if (atom.length <= maxUnits) {
      current = atom;
      continue;
    }
    // One atom longer than the limit: hard-split it (a single word/URL).
    for (let offset = 0; offset < atom.length; offset += maxUnits) {
      const piece = atom.slice(offset, offset + maxUnits);
      if (offset + maxUnits >= atom.length) {
        current = piece;
      } else {
        chunks.push(piece);
      }
    }
  }
  if (current !== '') {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Format one processed post into sendable parts. Media posts: the first
 * part is the caption (≤1024), the overflow continues as text parts
 * (AI-admin v2.19.1 pattern — never silently truncated). Every part is
 * ≤ its Telegram limit including page number and footer.
 *
 * Form #4 (ADR-0073 §3): digits fold to Latin on every path, and when
 * `markers` is true (the text came from the Soul rewrite) the `**…**` /
 * `> …` markers are parsed into entities that travel on the parts —
 * the rich path sends them as entities, the classic path renders them
 * as HTML. A fallback (unrewritten) text never goes through the marker
 * parser, so the owner's literal `**` is preserved.
 */
export function formatInboundPost(input: {
  readonly text: string;
  readonly media: 'none' | 'photo' | 'video';
  readonly markers?: boolean;
}): InboundPostPart[] {
  const normalized = normalizePersianText(input.text);
  const folded = foldDigitsToLatin(normalized);
  const deduped = stripTrailingFooterLine(folded);
  const { text, entities } =
    input.markers === true
      ? parseFormMarkers(deduped)
      : { text: deduped, entities: [] as RichTextEntity[] };
  // Multi-part posts carry an `i/N` page-number prefix (at most `NN/NN\n\n`
  // = 8 units); the body budget reserves it on every part so no part can
  // exceed its Telegram limit after the prefix is added.
  const PAGE_PREFIX_RESERVE = 8;
  if (input.media === 'none') {
    const body = splitParts(text, entities, INBOUND_TEXT_LIMIT - PAGE_PREFIX_RESERVE, 'text');
    const withNumbers = addPageNumbersToParts(body);
    return addFooterToParts(withNumbers, INBOUND_TEXT_LIMIT);
  }
  // Room for the `i/N` page-number prefix on the caption part (at most
  // `NN/NN\n\n` = 8 units) so the caption never exceeds its 1024 limit.
  const captionParts = splitParts(text, entities, INBOUND_CAPTION_LIMIT - 8, 'caption');
  const firstCaption = captionParts[0] ?? {
    kind: 'caption' as const,
    text: '',
    entities: [] as RichTextEntity[],
  };
  const restRaw = text.slice(firstCaption.text.length);
  const restText = restRaw.replace(/^\s+/, '');
  const stripped = restRaw.length - restText.length;
  const restStart = firstCaption.text.length + stripped;
  const restEntities = clampEntities(entities, restStart, restText);
  const overflow = splitParts(
    restText,
    restEntities,
    INBOUND_TEXT_LIMIT - PAGE_PREFIX_RESERVE,
    'text',
  );
  const rawParts: InboundPostPart[] = [firstCaption, ...overflow];
  const numbered = addPageNumbersToParts(rawParts);
  // The footer budget belongs to the LAST part: the caption limit for a
  // single-part media post, the text limit otherwise.
  const lastLimit = numbered.length === 1 ? INBOUND_CAPTION_LIMIT : INBOUND_TEXT_LIMIT;
  return addFooterToParts(numbered, lastLimit);
}
