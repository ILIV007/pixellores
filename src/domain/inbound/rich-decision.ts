/**
 * Slice 4 — rich decision (MERGE_MAP §7 step 7 / §11.9, DESIGN §10.3).
 *
 * Rich only when the source was rich (entity fidelity — the rich transport
 * is the only entity-faithful path in this codebase) and only in richMode
 * auto/always. `partCount` and `media` are accepted for forward
 * compatibility; in this transport both presentations share the same
 * 4096/1024 caps, so splitting never decides rich here. Every rich send
 * falls back to classic on failure (exercised in the integration suite
 * with a failing transport).
 */

export type InboundRichMode = 'off' | 'auto' | 'always';
export type InboundPresentation = 'rich' | 'classic';

export function decideRichPresentation(input: {
  /** The source message carried Telegram entities (bold/links/…). */
  readonly sourceWasRich: boolean;
  /** Total sendable parts after chunking. */
  readonly partCount: number;
  readonly media: 'none' | 'photo' | 'video';
  readonly richMode: InboundRichMode;
  /**
   * The processed content carries form #4 structure (bold / blockquote
   * from the Soul rewrite, ADR-0073 §4) — the rich transport is the
   * entity-faithful path, so structure goes rich even when the SOURCE
   * message carried no entities.
   */
  readonly contentHasEntities?: boolean;
}): InboundPresentation {
  if (input.richMode === 'off') {
    return 'classic';
  }
  if (input.richMode === 'always') {
    return 'rich';
  }
  if (input.contentHasEntities === true) {
    return 'rich';
  }
  return input.sourceWasRich ? 'rich' : 'classic';
}
