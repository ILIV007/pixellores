/**
 * R1.22 Phase A — the editorial→post TEXT render (the /post_from_draft
 * bridge): a PURE, DETERMINISTIC projection of ONE stored editorial draft
 * document (schemaVersion 1, ADR-0042) into a validated kind-'text' rich
 * text envelope — the exact content one admin post version carries.
 *
 * Honesty contract (mirrors the whole admin-post pipeline):
 * - The stored editorial document is NOT trusted: it is parsed defensively
 *   and its core fields are type-checked before use. A malformed or
 *   unsupported-version document is a TYPED failure — nothing is guessed,
 *   repaired, or fabricated from other rows.
 * - The render composes ONLY the document's own stored fields: the Persian
 *   headline, the Persian summary, and the model claims. Empty optional
 *   sections are composed as absent — never filled with invented content.
 * - NO source line is rendered, ever (owner order 2026-11-22 — footer like
 *   the other house channels, no source in posts at all; this supersedes
 *   the old "source links only for very official/important news" rule).
 *   The source attribution stays STORED in the document for provenance
 *   (and its shape is still validated) — it is simply never composed into
 *   the post text.
 * - The house footer is deterministic and added by the renderer, never by
 *   the model: the trailing `👾 @pixellores` line rides a blockquote
 *   entity — the same house pattern as the other channels
 *   (`> 🌀 @ILIVIR3`, `> @TradeAgentIV`, `🪼 @PROXIV3`).
 * - The unverified status is PRESERVED, not laundered: the model claims are
 *   rendered with a fixed explicit unverified note. A claim entry that is
 *   not exactly the mapper's `status: 'unverified'` shape fails the render
 *   as a malformed document — a silently "confirmed" claim can never reach
 *   a post.
 * - NO silent truncation exists anywhere: if the composed text (or any
 *   envelope rule) exceeds the R1.19 limits, the envelope creation fails
 *   and its typed reason is returned verbatim. The caller answers with an
 *   explicit failure — a shortened "something like the original" post is
 *   never produced.
 * - Determinism: the same document bytes always render to the same text and
 *   the same two entities (the bold headline, the footer blockquote), so the
 *   same editorial draft version always fingerprints identically.
 *
 * The raw source excerpt is deliberately NOT part of the post: the channel
 * carries the editorial OUTPUT; the full evidence excerpt stays in the
 * editorial draft, reachable through the durable provenance link and the
 * /drafts detail surface. Neither is the source NAME rendered: no source
 * line of any form reaches a post.
 */
import {
  createRichTextEnvelope,
  type RichTextEntity,
  type RichTextEnvelope,
  type RichTextFailureReason,
} from '../telegram/rich-text-envelope';

/** Fixed Persian labels — stable authored constants, never user content. */
export const EDITORIAL_POST_LABELS = {
  unverifiedNote: 'وضعیت: ادعاهای بالا از خروجی مدل هستند و هنوز تأیید نشده‌اند (unverified).',
  /** The house footer line — rendered as a trailing blockquote entity. */
  footer: '👾 @pixellores',
} as const;

/** The claim shape the R1.12 mapper writes — re-validated here verbatim. */
interface RenderClaim {
  readonly text: string;
}

export type EditorialPostRenderFailureReason =
  | 'malformed_json'
  | 'unsupported_version'
  | 'malformed_document'
  | 'empty_headline'
  | RichTextFailureReason;

export type EditorialPostRenderOutcome =
  | { readonly ok: true; readonly envelope: RichTextEnvelope; readonly text: string }
  | { readonly ok: false; readonly reason: EditorialPostRenderFailureReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Defensively read the model-claims list; `null` = section honestly absent. */
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
    // The mapper contract fixes the status literal: a stored claim that is
    // not exactly `unverified` is a malformed document — rendering it as
    // anything else would launder an unverified model claim into a post.
    if (entry['status'] !== 'unverified') {
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
 * Render ONE stored editorial document into the canonical post text
 * envelope. Never mutates its input; never throws; every failure is typed.
 */
export function renderEditorialPostText(documentJson: string): EditorialPostRenderOutcome {
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

  // Deterministic composition: headline -> summary -> claims -> unverified
  // note -> house footer. Sections the document does not carry are absent —
  // nothing is invented to fill them.
  const sections: string[] = [headline];
  if (summary.length > 0) {
    sections.push(summary);
  }
  for (const claim of claims) {
    sections.push(`• ${claim.text}`);
  }
  sections.push(EDITORIAL_POST_LABELS.unverifiedNote);
  sections.push(EDITORIAL_POST_LABELS.footer);
  const text = sections.join('\n\n');

  // TWO entities: the bold headline at offset 0, and the blockquote over
  // the trailing footer line (the footer starts its own line by
  // construction — the '\n\n' separator precedes it). Lengths are the
  // headline's / footer's UTF-16 code-unit counts — the exact unit the
  // envelope contract offsets are expressed in.
  const footerOffset = text.length - EDITORIAL_POST_LABELS.footer.length;
  const entities: readonly RichTextEntity[] = [
    { type: 'bold', offset: 0, length: headline.length },
    { type: 'blockquote', offset: footerOffset, length: EDITORIAL_POST_LABELS.footer.length },
  ];
  const outcome = createRichTextEnvelope({ kind: 'text', text, entities });
  if (!outcome.ok) {
    // Overflow (or any envelope-rule violation) fails TYPED — no
    // truncation-to-fit is ever attempted.
    return { ok: false, reason: outcome.reason };
  }
  return { ok: true, envelope: outcome.envelope, text };
}
