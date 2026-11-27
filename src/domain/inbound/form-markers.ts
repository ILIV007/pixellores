/**
 * Form #4 marker converter (ADR-0073 §3): the deterministic bridge
 * between the Soul rewrite's markup and Telegram entities.
 *
 * The model returns `**…**` bold spans (headline + main figure) and
 * `> …` quote lines (quote + attribution). This module turns them into
 * Telegram entities (bold / blockquote) on the marker-stripped text.
 *
 * Fail-closed by construction:
 * - a `**` pair is converted only when it is single-line, non-empty and
 *   not whitespace-only; any leftover `**` (unbalanced, empty, or
 *   whitespace-only) is STRIPPED, never sent as literal `**`;
 * - quote lines are whole lines starting with `> `; consecutive quote
 *   lines merge into ONE blockquote entity (the newlines between them
 *   are inside the quote); a lone `> ` line with no content contributes
 *   nothing;
 * - bold spans never cross a line boundary, so a bold span inside a
 *   quote line is always strictly contained in that line's blockquote
 *   (the envelope validator's nesting rule is satisfied by
 *   construction);
 * - the input is trusted to be already-normalized text (the formatter
 *   runs this AFTER normalize + digit folding), so offsets are computed
 *   on the final text — no normalization ever shifts them afterwards.
 *
 * Pure: same input, same output.
 */

import type { RichTextEntity } from '../telegram/rich-text-envelope';

export interface FormMarkersResult {
  readonly text: string;
  readonly entities: readonly RichTextEntity[];
}

/** True when the text carries any form #4 marker (cheap pre-check for the rich decision). */
export function hasFormMarkers(text: string): boolean {
  return /\*\*[^\n*]+\*\*/.test(text) || /^> /m.test(text);
}

/**
 * Parse form #4 markers into text + entities. Runs in a single
 * left-to-right pass so every entity offset is computed on the output
 * text as it is built — no post-hoc offset repair.
 */
export function parseFormMarkers(text: string): FormMarkersResult {
  const lines = text.split('\n');
  let out = '';
  const bold: RichTextEntity[] = [];
  const quoteRuns: Array<{ start: number; end: number }> = [];
  let currentQuote: { start: number; end: number } | null = null;

  const flushQuote = (): void => {
    if (currentQuote !== null) {
      quoteRuns.push(currentQuote);
      currentQuote = null;
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? '';
    const isQuote = rawLine.startsWith('> ');
    const content = isQuote ? rawLine.slice(2) : rawLine;

    if (lineIndex > 0) {
      out += '\n';
      // The newline between two quote lines is INSIDE the quote run.
      if (currentQuote !== null && isQuote) {
        currentQuote.end += 1;
      }
    }
    const lineStart = out.length;

    // Bold spans within this line's content. Segments between matches
    // are emitted with any leftover `**` stripped (unbalanced markers
    // never reach the channel as literal text).
    const pattern = /\*\*([^\n*]+)\*\*/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const inner = match[1] ?? '';
      const matchStart = match.index;
      if (inner.trim().length === 0) {
        // Whitespace-only pair: not a bold span — leave it for the
        // segment strip below (markers go, the whitespace stays).
        continue;
      }
      out += content.slice(cursor, matchStart).replaceAll('**', '');
      const spanStart = out.length;
      out += inner;
      bold.push({ type: 'bold', offset: spanStart, length: inner.length });
      cursor = matchStart + match[0].length;
    }
    out += content.slice(cursor).replaceAll('**', '');
    const lineEnd = out.length;

    if (isQuote && content.length > 0) {
      if (currentQuote === null) {
        currentQuote = { start: lineStart, end: lineEnd };
      } else {
        currentQuote.end = lineEnd;
      }
    } else if (!isQuote) {
      flushQuote();
    }
    // An empty quote line ("> " with no content) neither starts nor
    // breaks a run — it contributes no characters.
  }
  flushQuote();

  const entities: RichTextEntity[] = [
    ...bold,
    ...quoteRuns
      .filter((run) => run.end > run.start)
      .map((run) => ({
        type: 'blockquote' as const,
        offset: run.start,
        length: run.end - run.start,
      })),
  ];
  return { text: out, entities };
}
