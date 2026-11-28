/**
 * R1.22 Phase A — the editorial→post TEXT render (the /post_from_draft
 * bridge), v3 FORM (ADR-0071, owner order 2026-11-22, approved overall
 * ~12:06 on the live msg-16 example): a PURE, DETERMINISTIC projection of
 * ONE stored editorial draft document (schemaVersion 1, ADR-0042) into a
 * validated kind-'text' rich text envelope — the exact content one admin
 * post version carries — plus the kind-'caption' variant the photo send
 * consumes (ADR-0068, trimmed to the 1024-unit caption cap by owner order).
 *
 * THE v3 FORM (blocks joined by a blank line, in this order):
 *   1. Title block — bold `{categoryEmoji} {headline}` (the emoji comes
 *      from `document.soulForm`; absent on prompt-v1 drafts = no emoji),
 *      then the Latin game name on its OWN line, italic, with an optional
 *      inline game-page link when the document carries one.
 *   2. Body — `summaryFa` as stored (never invented, never restated by the
 *      render: the no-repetition rule is enforced by the model writing
 *      the body WITHOUT figures — prompt v4 asks for the figures
 *      separately, marked by significance).
 *   3. Quote block — a REAL quote from the stored `document.quote`
 *      (model-supplied verbatim text + attribution); the attribution sits
 *      on its OWN line INSIDE the same blockquote. Long quotes ride an
 *      expandable_blockquote. Absent when the document carries no quote —
 *      a quote is never derived or invented.
 *   4. Figures block — ONE line per HEADLINE figure, `label: value`,
 *      values in mono; the MAIN figure's whole line is BOLD with the
 *      mono value inside it (the nesting Telegram preserves — see the
 *      envelope's ADR-0071 exception; equal-range bold+code flattened
 *      live on msg 16 and stays rejected). Figures come ONLY from the
 *      stored `document.figures` (model-authored, prompt v4) AND only
 *      the entries the model marked `significance: 'headline'` render —
 *      the mechanical derivation is DELETED (ADR-0080), and unmarked or
 *      `'context'` figures are dropped. Until prompt-v4 figures land,
 *      NO post has a figures block — the owner's decision.
 *   5. Verdict — the stored `document.verdict` sentence, with NO label
 *      (the old «حرف آخر:» label is gone by owner order). Absent when the
 *      document carries none — the sentence is never invented.
 *   6. House footer — the trailing `👾 @pixellores` blockquote, byte-pinned.
 *
 * Honesty contract (mirrors the whole admin-post pipeline):
 * - The stored editorial document is NOT trusted: it is parsed defensively
 *   and its core fields are type-checked before use. A malformed or
 *   unsupported-version document is a TYPED failure — nothing is guessed,
 *   repaired, or fabricated from other rows.
 * - The render composes ONLY the document's own stored fields. Empty
 *   optional sections are composed as absent — never filled with invented
 *   content. The quote, the verdict, the game-page link and the structured
 *   figures are all OPTIONAL stored fields: absent = the section is absent.
 * - NO trust label is rendered, ever (owner order 2026-11-22): the
 *   `soulForm.trustLabel` stays STORED for provenance (and its shape is
 *   still validated, like `sourceReport`) — it is simply never composed
 *   into the post text. The category emoji IS rendered in the title.
 * - NO source line is rendered, ever (owner order 2026-11-22 — footer like
 *   the other house channels, no source in posts at all). The source
 *   attribution stays STORED in the document for provenance (and its shape
 *   is still validated) — it is simply never composed into the post text.
 * - The house footer is deterministic and added by the renderer, never by
 *   the model: the trailing `👾 @pixellores` line rides a blockquote
 *   entity — the same house pattern as the other channels
 *   (`> 🌀 @ILIVIR3`, `> @TradeAgentIV`, `🪼 @PROXIV3`).
 * - NO unverified line is rendered, ever (owner order 2026-11-22 — gone,
 *   period, not conditional). The fact-guard still gates drafts
 *   internally (the auto-gate requires the fact-guard report present +
 *   total + zero non-benign findings); the render simply no longer
 *   prints the status. The claim `status` field is therefore no longer a
 *   render contract either: a claim entry is accepted on its TEXT alone
 *   (see `readClaims`) — a stored status other than `unverified` no
 *   longer fails the render.
 * - NO silent truncation in the TEXT render: if the composed text (or any
 *   envelope rule) exceeds the R1.19 limits, the envelope creation fails
 *   and its typed reason is returned verbatim. The CAPTION render is the
 *   ONE owner-authorized exception: a caption that would exceed 1024
 *   units is deterministically TRIMMED (never a second send) and reports
 *   `trimmed: true` so the scheduler can log it.
 * - NO repetition BY THE RENDER: each figure the render emits appears
 *   exactly once, in the figures block. The render never restates a
 *   figure in the body, the quote, or the verdict — the body/quote/
 *   verdict are the stored texts, and the figures block is built ONLY
 *   from the stored figures marked `'headline'`, never from the body
 *   and never from the claims.
 * - Latin digits ONLY (owner order 2026-11-22, v3): Persian/Arabic-Indic
 *   digits fold to Latin at render time (the same 1:1 map the fact-guard
 *   numbers lens uses for matching, ADR-0066). The stored document is
 *   never rewritten — folding happens on the composed text only.
 * - Persian RTL: every Latin span (game names, Latin words, figure
 *   values, quote text) is isolated with Unicode bidi isolation
 *   (LRI U+2066 … PDI U+2069); a whole-Latin span gets one wrapping pair,
 *   a Latin run inside Persian text gets per-run isolation (the inbound
 *   persian-format pattern). The house footer stays byte-pinned and is
 *   NOT re-isolated.
 * - Determinism: the same document bytes always render to the same text
 *   and the same entities, so the same editorial draft version always
 *   fingerprints identically.
 *
 * FIGURE SIGNIFICANCE (ADR-0080 §3.8i, owner decision 2026-11-28
 * 08:07): the block appears ONLY when the number IS the story — a
 * figure earns it iff it is a headline stat (remove the number and
 * there is no story left). EARNS it: sales results (day-one / week-one
 * revenue, units sold); pre-order counts; launch records; player-count
 * records / milestones; chart records with their numbers; a record
 * review score that IS the story. Does NOT earn it: release dates;
 * platform numbers; prices; bundle / item counts; episode / season
 * numbers; title fragments; counts inside a list; dates in any form.
 * The model marks each figure `significance: 'headline' | 'context'`
 * (prompt v4 carries this criterion verbatim); the render is a dumb
 * gate that renders ONLY `'headline'`. The mechanical derivation that
 * used to fill this block from the claims is DELETED, with its
 * date-cluster merger (PR #42 / ADR-0077 — the merger stays in
 * history; its month-word lists live on in
 * `src/domain/publishing/date-phrases.ts` for the freshness gate).
 *
 * The raw source excerpt is deliberately NOT part of the post: the channel
 * carries the editorial OUTPUT; the full evidence excerpt stays in the
 * editorial draft, reachable through the durable provenance link and the
 * /drafts detail surface. Neither is the source NAME rendered: no source
 * line of any form reaches a post.
 */
import {
  createRichTextEnvelope,
  RICH_TEXT_LIMITS,
  type RichTextEntity,
  type RichTextEnvelope,
  type RichTextFailureReason,
} from '../telegram/rich-text-envelope';
import { SOUL_CATEGORY_EMOJIS } from '../ai/types';

/** Fixed Persian labels — stable authored constants, never user content. */
export const EDITORIAL_POST_LABELS = {
  /** The house footer line — rendered as a trailing blockquote entity. */
  footer: '👾 @pixellores',
} as const;

/** Maximum figure lines in the figures block (structured or derived). */
export const EDITORIAL_POST_MAX_FIGURES = 8 as const;

/** A quote block longer than this (UTF-16 units) rides expandable_blockquote. */
export const EDITORIAL_POST_QUOTE_EXPANDABLE_THRESHOLD = 240 as const;

export type EditorialPostRenderFailureReason =
  | 'malformed_json'
  | 'unsupported_version'
  | 'malformed_document'
  | 'empty_headline'
  | RichTextFailureReason;

export type EditorialPostRenderOutcome =
  | { readonly ok: true; readonly envelope: RichTextEnvelope; readonly text: string }
  | { readonly ok: false; readonly reason: EditorialPostRenderFailureReason };

export type EditorialPostCaptionOutcome =
  | {
      readonly ok: true;
      readonly envelope: RichTextEnvelope;
      readonly text: string;
      /** True when any block was dropped or word-trimmed to fit 1024 units. */
      readonly trimmed: boolean;
    }
  | { readonly ok: false; readonly reason: EditorialPostRenderFailureReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// Latin-only digits + bidi isolation (v3, owner order 2026-11-22)
// ---------------------------------------------------------------------------

/**
 * Fold Persian/Arabic-Indic digits to Latin for RENDERING (٫→., ٬→,) — the
 * SAME 1:1 code-point map the fact-guard numbers lens uses for MATCHING
 * (ADR-0066). 1:1, so UTF-16 lengths — and every entity offset computed
 * afterwards — are preserved exactly.
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

const LRI = '\u2066';
const PDI = '\u2069';

/**
 * Latin/URL runs embedded in Persian text get bidi isolation (LRI/PDI) —
 * the inbound `persian-format` pattern, plus a leading `$` so a figure
 * like `$3.79B` isolates whole instead of leaving the `$` outside.
 */
const LATIN_RUN =
  /[$A-Za-z0-9@][A-Za-z0-9@:/?#._~%+&=;,$-]*[A-Za-z0-9@/?#._~%+&=;$-]|[$A-Za-z0-9@]/g;
const HAS_PERSIAN = /[\u0600-\u06FF]/;
const HAS_LATIN = /[A-Za-z0-9$@]/;

/**
 * Isolate the Latin in `text` for RTL rendering: a whole-Latin span gets
 * ONE wrapping LRI…PDI pair; Latin runs inside Persian text get per-run
 * isolation. Text with no Latin is returned unchanged.
 */
export function isolateLatinSpan(text: string): string {
  if (!HAS_LATIN.test(text)) {
    return text;
  }
  if (!HAS_PERSIAN.test(text)) {
    return `${LRI}${text}${PDI}`;
  }
  return text.replace(LATIN_RUN, (run) => `${LRI}${run}${PDI}`);
}

/**
 * Isolate `text` AND report the inner range (the visible text without the
 * wrapping marks) so an entity can cover exactly the visible span: a
 * whole-wrapped span reports innerOffset 1, a per-run-isolated span
 * reports the whole text (its marks are internal, never at the edges).
 */
function isolateForEntity(text: string): {
  readonly text: string;
  readonly innerOffset: number;
  readonly innerLength: number;
} {
  const isolated = isolateLatinSpan(text);
  if (isolated.startsWith(LRI) && isolated.endsWith(PDI) && isolated.length >= 2) {
    return { text: isolated, innerOffset: 1, innerLength: isolated.length - 2 };
  }
  return { text: isolated, innerOffset: 0, innerLength: isolated.length };
}

// ---------------------------------------------------------------------------
// Stored-document readers (defensive; `null` = malformed, `undefined` = absent)
// ---------------------------------------------------------------------------

/** The claim shape the R1.12 mapper writes — re-validated here verbatim. */
interface RenderClaim {
  readonly text: string;
}

/**
 * Defensively read the model-claims list; `null` = malformed, `[]` =
 * honestly absent. ADR-0071 (owner order 2026-11-22): the claim `status`
 * is NO LONGER a render contract — the entry is accepted on its TEXT
 * alone, and the unverified line is never rendered. The internal gate
 * stays the fact-guard report (the auto-gate requires it present + total
 * + zero non-benign findings); the render no longer polices the status.
 */
function readClaims(value: unknown): RenderClaim[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const claims: RenderClaim[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return null;
    }
    if (!isNonEmptyString(entry['text'])) {
      return null;
    }
    claims.push({ text: entry['text'] });
  }
  return claims;
}

/**
 * Defensively read `document.soulForm` (prompt v2, ADR-0066). The
 * category emoji IS rendered (title prefix); the trust label is STORED
 * provenance only and NEVER rendered (owner order 2026-11-22) — but its
 * shape is still validated, like `sourceReport`, so a half-written
 * soulForm fails the render instead of silently rendering half a form.
 */
function readSoulForm(value: unknown): { readonly categoryEmoji: string } | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const categoryEmoji = value['categoryEmoji'];
  if (
    typeof categoryEmoji !== 'string' ||
    !(SOUL_CATEGORY_EMOJIS as readonly string[]).includes(categoryEmoji)
  ) {
    return null;
  }
  const trustLabel = value['trustLabel'];
  if (typeof trustLabel !== 'string') {
    return null;
  }
  return { categoryEmoji };
}

/**
 * One figure line of the figures block. `significance` is the MODEL's
 * marker (ADR-0080 §3.8i): `'headline'` = a headline stat — remove the
 * number and there is no story left — and ONLY those render. `'context'`
 * (or an absent marker, the old-document shape) never renders: the
 * render is a dumb gate, fail-closed toward NO block.
 */
interface RenderFigure {
  readonly label: string;
  readonly value: string;
  readonly main: boolean;
  readonly significance?: 'headline' | 'context';
}

/**
 * Defensively read the model-authored `document.figures` (prompt v4 —
 * the ONLY source of figures since the mechanical derivation was
 * deleted, ADR-0080). Absent (or an empty list) = no figures block;
 * malformed = the render fails. At most ONE main figure; labels/values
 * are bounded plain strings; `significance`, when present, must be
 * `'headline'` or `'context'` (anything else is malformed, never
 * silently treated as headline).
 */
function readStructuredFigures(value: unknown): readonly RenderFigure[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > EDITORIAL_POST_MAX_FIGURES) {
    return null;
  }
  const figures: RenderFigure[] = [];
  let mainCount = 0;
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return null;
    }
    const label = entry['label'];
    const figureValue = entry['value'];
    if (!isNonEmptyString(label) || label.length > 120) {
      return null;
    }
    if (!isNonEmptyString(figureValue) || figureValue.length > 40) {
      return null;
    }
    const main = entry['main'];
    if (main !== undefined && typeof main !== 'boolean') {
      return null;
    }
    if (main === true) {
      mainCount += 1;
    }
    const significance = entry['significance'];
    if (significance !== undefined && significance !== 'headline' && significance !== 'context') {
      return null;
    }
    figures.push({
      label,
      value: figureValue,
      main: main === true,
      ...(significance !== undefined ? { significance } : {}),
    });
  }
  if (mainCount > 1) {
    return null;
  }
  return figures;
}

/** A real quote: verbatim text + optional attribution. */
interface RenderQuote {
  readonly text: string;
  readonly attribution?: string;
}

/**
 * Defensively read the model-supplied `document.quote` (prompt v3). Absent
 * = no quote block (a quote is never derived or invented); malformed =
 * the render fails. The text is the VERBATIM quote from the evidence;
 * the attribution is the quoted person's name.
 */
function readQuote(value: unknown): RenderQuote | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const text = value['text'];
  if (!isNonEmptyString(text) || text.length > 600) {
    return null;
  }
  const attribution = value['attribution'];
  if (attribution !== undefined && (!isNonEmptyString(attribution) || attribution.length > 120)) {
    return null;
  }
  return { text, ...(attribution !== undefined ? { attribution } : {}) };
}

function readVerdict(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isNonEmptyString(value) || value.length > 300) {
    return null;
  }
  return value;
}

function readGameName(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isNonEmptyString(value) || value.length > 120) {
    return null;
  }
  return value;
}

/**
 * Defensively read the optional `document.gamePageUrl` (prompt v3): the
 * game-page link (official site / Steam / Epic store page — informational,
 * never a purchase link) the game-name line links to when present. The
 * link is OPTIONAL — absent = a plain italic name — but a present-but-
 * invalid URL fails the render instead of emitting a broken link.
 */
function readGamePageUrl(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }
  if (new TextEncoder().encode(value).byteLength > 2048) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return null;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  return value;
}

/** A Latin-script alias is a plausible game name for the own-line slot. */
function isLatinGameAlias(alias: string): boolean {
  if (alias.length === 0 || alias.length > 120) {
    return false;
  }
  if (!/[A-Za-z]/.test(alias)) {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9 .'\-&]*$/.test(alias);
}

/**
 * The Latin game-name fallback: the LONGEST Latin-script alias in the
 * stored entity-mentions report (`entityMentions.matched`, ascending
 * (alias, entityId) by construction — first-longest wins ties). The
 * report is AUXILIARY presentation data, not the render's authority: a
 * missing or malformed report simply yields no game line, never a
 * failure — and the alias is only ever DISPLAYED, never treated as a
 * verified game identity (mentions mean `mentioned`, confidence 0).
 */
function readLatinGameAlias(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const matched = value['matched'];
  if (!Array.isArray(matched)) {
    return undefined;
  }
  let best: string | undefined;
  for (const entry of matched) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const alias = entry['normalizedAlias'];
    if (typeof alias !== 'string' || !isLatinGameAlias(alias)) {
      continue;
    }
    if (best === undefined || alias.length > best.length) {
      best = alias;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Block composition
// ---------------------------------------------------------------------------

type BlockRole = 'title' | 'body' | 'quote' | 'figures' | 'verdict' | 'footer';

interface RenderBlock {
  readonly role: BlockRole;
  readonly text: string;
  readonly entities: readonly RichTextEntity[];
}

interface ParsedEditorialDocument {
  readonly headline: string;
  readonly summary: string;
  readonly claims: readonly RenderClaim[];
  readonly categoryEmoji: string | undefined;
  readonly figures: readonly RenderFigure[] | undefined;
  readonly quote: RenderQuote | undefined;
  readonly verdict: string | undefined;
  readonly gameName: string | undefined;
  readonly gamePageUrl: string | undefined;
}

type ParseResult =
  | { readonly ok: true; readonly document: ParsedEditorialDocument }
  | { readonly ok: false; readonly reason: EditorialPostRenderFailureReason };

function parseEditorialDocument(documentJson: string): ParseResult {
  if (typeof documentJson !== 'string' || documentJson.length === 0) {
    return { ok: false, reason: 'malformed_json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson) as unknown;
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'malformed_document' };
  }
  if (parsed['schemaVersion'] !== 1) {
    return { ok: false, reason: 'unsupported_version' };
  }
  const headline = parsed['headlineFa'];
  if (!isNonEmptyString(headline)) {
    return {
      ok: false,
      reason: headline === undefined || headline === '' ? 'empty_headline' : 'malformed_document',
    };
  }
  const rawSummary = parsed['summaryFa'];
  if (rawSummary !== undefined && typeof rawSummary !== 'string') {
    return { ok: false, reason: 'malformed_document' };
  }
  // An absent summary is an honestly absent section (never invented) —
  // normalized to the empty string for the composition below.
  const summary: string = rawSummary ?? '';
  // The source attribution is STORED provenance only: its shape is still
  // validated (a malformed document fails), but it is NEVER rendered into
  // the post (owner order 2026-11-22: no source in posts at all).
  const sourceReport = parsed['sourceReport'];
  if (sourceReport !== undefined) {
    if (!isPlainObject(sourceReport)) {
      return { ok: false, reason: 'malformed_document' };
    }
    const rawSourceName = sourceReport['sourceName'];
    if (rawSourceName !== undefined && typeof rawSourceName !== 'string') {
      return { ok: false, reason: 'malformed_document' };
    }
  }
  const claims = readClaims(parsed['modelClaims']);
  if (claims === null) {
    return { ok: false, reason: 'malformed_document' };
  }
  const soulForm = readSoulForm(parsed['soulForm']);
  if (soulForm === null) {
    return { ok: false, reason: 'malformed_document' };
  }
  const figures = readStructuredFigures(parsed['figures']);
  if (figures === null) {
    return { ok: false, reason: 'malformed_document' };
  }
  const quote = readQuote(parsed['quote']);
  if (quote === null) {
    return { ok: false, reason: 'malformed_document' };
  }
  const verdict = readVerdict(parsed['verdict']);
  if (verdict === null) {
    return { ok: false, reason: 'malformed_document' };
  }
  const structuredGameName = readGameName(parsed['gameName']);
  if (structuredGameName === null) {
    return { ok: false, reason: 'malformed_document' };
  }
  const gamePageUrl = readGamePageUrl(parsed['gamePageUrl']);
  if (gamePageUrl === null) {
    return { ok: false, reason: 'malformed_document' };
  }
  // The game name: the stored `gameName` wins; else the longest Latin
  // alias the item's mentions report observed (never a lookup, never
  // invented). A game-page URL renders ONLY with a name to attach to.
  const gameName = structuredGameName ?? readLatinGameAlias(parsed['entityMentions']);
  return {
    ok: true,
    document: {
      headline,
      summary,
      claims,
      categoryEmoji: soulForm?.categoryEmoji,
      figures: figures ?? undefined,
      quote: quote ?? undefined,
      verdict: verdict ?? undefined,
      gameName,
      gamePageUrl: gameName !== undefined ? (gamePageUrl ?? undefined) : undefined,
    },
  };
}

function buildTitleBlock(document: ParsedEditorialDocument): RenderBlock {
  const headline = isolateLatinSpan(foldDigitsToLatin(document.headline));
  const titleLine =
    document.categoryEmoji !== undefined ? `${document.categoryEmoji} ${headline}` : headline;
  const entities: RichTextEntity[] = [{ type: 'bold', offset: 0, length: titleLine.length }];
  let text = titleLine;
  if (document.gameName !== undefined) {
    const isolated = isolateForEntity(foldDigitsToLatin(document.gameName));
    const nameOffset = text.length + 1;
    entities.push({
      type: 'italic',
      offset: nameOffset + isolated.innerOffset,
      length: isolated.innerLength,
    });
    if (document.gamePageUrl !== undefined) {
      entities.push({
        type: 'text_link',
        offset: nameOffset + isolated.innerOffset,
        length: isolated.innerLength,
        url: document.gamePageUrl,
      });
    }
    text = `${text}\n${isolated.text}`;
  }
  return { role: 'title', text, entities };
}

function buildBodyBlock(summary: string): RenderBlock {
  return {
    role: 'body',
    text: isolateLatinSpan(foldDigitsToLatin(summary)),
    entities: [],
  };
}

/** Strip ONE layer of outer quote marks (Persian «» or straight/curly ""). */
function stripOuterQuoteMarks(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('«') && trimmed.endsWith('»')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith('“') && trimmed.endsWith('”')))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function buildQuoteBlock(quote: RenderQuote): RenderBlock {
  const quoted = stripOuterQuoteMarks(quote.text);
  let text = `«${isolateLatinSpan(foldDigitsToLatin(quoted))}»`;
  if (quote.attribution !== undefined) {
    // The attribution goes on its OWN line INSIDE the same blockquote
    // (owner refinement 2026-11-22) — never on the quote's line, never
    // outside/below the blockquote element.
    const attribution = isolateLatinSpan(foldDigitsToLatin(quote.attribution));
    text = `${text}\n— ${attribution}`;
  }
  const type =
    text.length > EDITORIAL_POST_QUOTE_EXPANDABLE_THRESHOLD
      ? 'expandable_blockquote'
      : 'blockquote';
  return { role: 'quote', text, entities: [{ type, offset: 0, length: text.length }] };
}

function buildFiguresBlock(figures: readonly RenderFigure[]): RenderBlock {
  let text = '';
  const entities: RichTextEntity[] = [];
  figures.forEach((figure, index) => {
    if (index > 0) {
      text += '\n';
    }
    const lineStart = text.length;
    const label = isolateLatinSpan(foldDigitsToLatin(figure.label));
    text += `${label}: `;
    // The value is ALWAYS wrapped in one LRI…PDI pair: it isolates the
    // Latin figure for RTL AND it keeps the mono span strictly inside
    // the main line's bold (a shared end boundary would break the
    // ADR-0071 strict-containment rule — see the envelope module).
    const foldedValue = foldDigitsToLatin(figure.value);
    const valueStart = text.length + 1;
    text += `${LRI}${foldedValue}${PDI}`;
    entities.push({ type: 'code', offset: valueStart, length: foldedValue.length });
    if (figure.main) {
      entities.push({ type: 'bold', offset: lineStart, length: text.length - lineStart });
    }
  });
  return { role: 'figures', text, entities };
}

function buildVerdictBlock(verdict: string): RenderBlock {
  return {
    role: 'verdict',
    text: isolateLatinSpan(foldDigitsToLatin(verdict)),
    entities: [],
  };
}

function buildFooterBlock(): RenderBlock {
  return {
    role: 'footer',
    text: EDITORIAL_POST_LABELS.footer,
    entities: [
      {
        type: 'blockquote',
        offset: 0,
        length: EDITORIAL_POST_LABELS.footer.length,
      },
    ],
  };
}

/**
 * Compose the v3 blocks in canonical order: title, body, quote, figures,
 * verdict, footer. Sections the document does not carry are absent —
 * nothing is invented to fill them.
 */
function buildBlocks(document: ParsedEditorialDocument): RenderBlock[] {
  const blocks: RenderBlock[] = [buildTitleBlock(document)];
  if (document.summary.length > 0) {
    blocks.push(buildBodyBlock(document.summary));
  }
  if (document.quote !== undefined) {
    blocks.push(buildQuoteBlock(document.quote));
  }
  // ADR-0080 §3.8i — the figures block exists ONLY for headline stats:
  // the derivation fallback is DELETED, and the significance gate
  // renders ONLY figures the model marked `'headline'`. Unmarked or
  // `'context'` figures are dropped; old documents without the field
  // are not-significant. Until the prompt-v4 mapper writes marked
  // figures, NO post has a figures block — the owner's decision for
  // ordinary posts (better no block than a junk block).
  const figures = (document.figures ?? []).filter((figure) => figure.significance === 'headline');
  if (figures.length > 0) {
    blocks.push(buildFiguresBlock(figures));
  }
  if (document.verdict !== undefined) {
    blocks.push(buildVerdictBlock(document.verdict));
  }
  blocks.push(buildFooterBlock());
  return blocks;
}

/** Join blocks with a blank line, shifting each block's entities by its offset. */
function composeBlocks(blocks: readonly RenderBlock[]): {
  readonly text: string;
  readonly entities: readonly RichTextEntity[];
} {
  let text = '';
  const entities: RichTextEntity[] = [];
  blocks.forEach((block, index) => {
    if (index > 0) {
      text += '\n\n';
    }
    const offset = text.length;
    text += block.text;
    for (const entity of block.entities) {
      entities.push({ ...entity, offset: entity.offset + offset });
    }
  });
  return { text, entities };
}

/**
 * Render ONE stored editorial document into the canonical post text
 * envelope. Never mutates its input; never throws; every failure is typed.
 */
export function renderEditorialPostText(documentJson: string): EditorialPostRenderOutcome {
  const parsed = parseEditorialDocument(documentJson);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const { text, entities } = composeBlocks(buildBlocks(parsed.document));
  const outcome = createRichTextEnvelope({ kind: 'text', text, entities });
  if (!outcome.ok) {
    // Overflow (or any envelope-rule violation) fails TYPED — no
    // truncation-to-fit is ever attempted in the TEXT render.
    return { ok: false, reason: outcome.reason };
  }
  return { ok: true, envelope: outcome.envelope, text };
}

// ---------------------------------------------------------------------------
// Caption variant (photo send): the same form, trimmed to 1024 units
// ---------------------------------------------------------------------------

/** Keep-priority of the middle blocks when the caption must shrink. */
const CAPTION_ROLE_PRIORITY: Readonly<Record<BlockRole, number>> = {
  title: 0,
  figures: 1,
  body: 2,
  quote: 3,
  verdict: 4,
  footer: 5,
};

/** Drop the game line, then hard-trim the title line with '…' (absurd-headline edge). */
function trimTitleBlock(title: RenderBlock, budget: number): RenderBlock {
  const firstLine = title.text.split('\n')[0]!;
  if (firstLine.length <= budget) {
    return {
      role: 'title',
      text: firstLine,
      entities: [{ type: 'bold', offset: 0, length: firstLine.length }],
    };
  }
  const maxLen = Math.max(budget - 1, 0);
  let cut = firstLine.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) {
    cut = cut.slice(0, lastSpace);
  }
  if (/[\uD800-\uDBFF]$/.test(cut)) {
    cut = cut.slice(0, -1);
  }
  const trimmedLine = `${cut}…`;
  return {
    role: 'title',
    text: trimmedLine,
    entities: [{ type: 'bold', offset: 0, length: trimmedLine.length }],
  };
}

/** Word-trim a block to `room` units with a trailing '…'; null when too small to keep. */
function wordTrimBlock(block: RenderBlock, room: number): RenderBlock | null {
  if (room < 20) {
    return null;
  }
  const maxLen = room - 1;
  let cut = block.text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) {
    cut = cut.slice(0, lastSpace);
  }
  if (/[\uD800-\uDBFF]$/.test(cut)) {
    cut = cut.slice(0, -1);
  }
  if (cut.length === 0) {
    return null;
  }
  const text = `${cut}…`;
  const entities = block.entities.filter((entity) => entity.offset + entity.length <= text.length);
  return { ...block, text, entities };
}

/**
 * Shrink the block list to the caption budget (1024 units incl. footer):
 * title + footer are mandatory; the middle blocks are kept in
 * figures > body > quote > verdict priority while they fit; the body —
 * the only prose block — may be word-trimmed to the remaining room, and
 * is dropped when even a trimmed sliver would not fit. Deterministic:
 * the same blocks always shrink to the same caption.
 */
function selectCaptionBlocks(blocks: readonly RenderBlock[]): {
  readonly blocks: readonly RenderBlock[];
  readonly trimmed: boolean;
} {
  const title = blocks[0]!;
  const footer = blocks[blocks.length - 1]!;
  const middle = blocks.slice(1, -1);
  const budget = RICH_TEXT_LIMITS.maxCaptionUnits - footer.text.length - 2;
  let titleBlock = title;
  let trimmed = false;
  if (titleBlock.text.length > budget) {
    titleBlock = trimTitleBlock(titleBlock, budget);
    trimmed = true;
  }
  let used = titleBlock.text.length;
  const keptIndices = new Set<number>();
  const replacements = new Map<number, RenderBlock>();
  const byPriority = middle
    .map((block, index) => ({ block, index }))
    .sort((a, b) => CAPTION_ROLE_PRIORITY[a.block.role] - CAPTION_ROLE_PRIORITY[b.block.role]);
  for (const { block, index } of byPriority) {
    const need = 2 + block.text.length;
    if (used + need <= budget) {
      keptIndices.add(index);
      used += need;
      continue;
    }
    if (block.role === 'body') {
      const room = budget - used - 2;
      const wordTrimmed = wordTrimBlock(block, room);
      if (wordTrimmed !== null) {
        keptIndices.add(index);
        replacements.set(index, wordTrimmed);
        used += 2 + wordTrimmed.text.length;
      }
    }
    trimmed = true;
  }
  const finalMiddle = middle
    .map((block, index) => replacements.get(index) ?? block)
    .filter((_block, index) => keptIndices.has(index));
  return { blocks: [titleBlock, ...finalMiddle, footer], trimmed };
}

/**
 * Render ONE stored editorial document into the kind-'caption' envelope
 * the photo send uses. Same form as the text render, deterministically
 * TRIMMED to the 1024-unit caption cap (owner order 2026-11-22: trim if
 * needed, never a second send) — `trimmed` reports whether anything was
 * dropped or word-trimmed, so the scheduler can log it honestly.
 */
export function renderEditorialPostCaption(documentJson: string): EditorialPostCaptionOutcome {
  const parsed = parseEditorialDocument(documentJson);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const { blocks, trimmed } = selectCaptionBlocks(buildBlocks(parsed.document));
  const { text, entities } = composeBlocks(blocks);
  const outcome = createRichTextEnvelope({ kind: 'caption', text, entities });
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }
  return { ok: true, envelope: outcome.envelope, text, trimmed };
}
