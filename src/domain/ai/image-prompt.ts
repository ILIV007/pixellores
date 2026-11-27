/**
 * The AI IMAGE prompt builder (ADR-0072, plan §7 + step 5) — PURE.
 *
 * The prompt is built from the draft's own stored fields ONLY: the
 * Persian headline + the Soul category emoji. It is English, technical
 * and neutral — Soul (voice, register, persona) belongs to the TEXT
 * draft and never reaches the image prompt.
 *
 * Rules (plan §7):
 * - Illustrative, never a fake: the prompt asks for a generic cinematic
 *   scene related to the news, NEVER a fake screenshot, fake box art,
 *   or "the real photo of the game". It never claims the image IS an
 *   official image of the game.
 * - No text in the image (flux mangles text/hands), no logo, no
 *   watermark — always appended.
 * - The headline is Persian; the model prompt is English. Only the
 *   headline's LATIN tokens survive (game names, studios, titles are
 *   Latin in the source text — e.g. GTA VI, Elden Ring); Persian words
 *   are dropped rather than transliterated by guesswork. At most 4
 *   tokens, de-duplicated, in headline order. A headline with no Latin
 *   tokens still yields a valid prompt from the category scene alone —
 *   the prompt never fails for that.
 * - Aspect: news/breaking/trailer categories ask for a wide cinematic
 *   composition (16:9 intent, 1344x768 request); everything else asks
 *   for a square composition (1:1 intent, 1024x1024 request). The
 *   primary model (flux-1-schnell) takes no dimensions, so the request
 *   is advisory in v1 — the adapter passes dimensions only to models
 *   whose typed input accepts them — but the intent is recorded here
 *   so a future model can honor it.
 */

import { SOUL_CATEGORY_EMOJIS, type SoulCategoryEmoji } from './types';

/** Prompt bounds (flux input: prompt 1..2048 chars). */
export const IMAGE_PROMPT_LIMITS = {
  maxPromptChars: 2048,
  maxHeadlineTokens: 4,
  maxTokenChars: 32,
} as const;

export type ImageAspect = '16:9' | '1:1';

export interface ImagePromptInput {
  readonly headline: string;
  readonly categoryEmoji?: SoulCategoryEmoji;
}

export interface BuiltImagePrompt {
  readonly prompt: string;
  readonly aspect: ImageAspect;
  /** The requested pixel size for the aspect (advisory in v1). */
  readonly width: number;
  readonly height: number;
  /** The Latin headline tokens that reached the prompt (audit trail). */
  readonly headlineTokens: readonly string[];
}

/** The fixed neutral tail — every prompt ends with it. */
export const IMAGE_PROMPT_TAIL = 'no text in image, no logo, no watermark';

/**
 * Category -> scene hint (fixed English vocabulary, never user content
 * beyond the headline tokens). The hint sets the mood only; it never
 * names a real screenshot or official art.
 */
export const IMAGE_CATEGORY_SCENES: Readonly<Record<SoulCategoryEmoji, string>> = {
  '🔴': 'dramatic breaking-news scene, moody atmosphere, urgent energy',
  '🚨': 'official announcement stage, dramatic lighting, grand reveal',
  '🏆': 'celebration scene, golden light, trophy moment',
  '🎮': 'cinematic video game trailer scene, dynamic action',
  '🟢': 'bright cheerful gaming scene, hopeful mood',
  '🔵': 'calm gaming news scene, clean modern setting',
} as const;

const DEFAULT_SCENE = 'cinematic gaming scene, atmospheric game world';

/** Wide (news/breaking/trailer) categories ask for a 16:9 composition. */
const WIDE_CATEGORIES: readonly SoulCategoryEmoji[] = ['🔴', '🚨', '🎮'];

const LATIN_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9'&:.-]{1,31}/g;

/**
 * The headline's Latin tokens (game/studio/title names), at most 4,
 * de-duplicated case-insensitively, in headline order. Persian (and any
 * other non-Latin) words are dropped, never transliterated.
 */
export function extractHeadlineTokens(headline: string): readonly string[] {
  if (typeof headline !== 'string' || headline.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of headline.matchAll(LATIN_TOKEN_PATTERN)) {
    const token = match[0].slice(0, IMAGE_PROMPT_LIMITS.maxTokenChars);
    const key = token.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tokens.push(token);
    if (tokens.length >= IMAGE_PROMPT_LIMITS.maxHeadlineTokens) {
      break;
    }
  }
  return tokens;
}

/**
 * Build the English image prompt for one draft. Never throws; an empty
 * or missing headline yields the category-scene prompt (the image is
 * still generatable — the caller decides whether a missing headline
 * should block generation).
 */
export function buildImagePrompt(input: ImagePromptInput): BuiltImagePrompt {
  const headline = typeof input.headline === 'string' ? input.headline : '';
  const tokens = extractHeadlineTokens(headline);
  const category = input.categoryEmoji;
  const scene =
    category !== undefined && SOUL_CATEGORY_EMOJIS.includes(category)
      ? IMAGE_CATEGORY_SCENES[category]
      : DEFAULT_SCENE;
  const wide = category !== undefined && WIDE_CATEGORIES.includes(category);
  const subject = tokens.length > 0 ? `, featuring ${tokens.join(' ')}` : '';
  const prompt = `Cinematic wide shot, ${scene}${subject}, atmospheric game-world illustration, detailed, ${IMAGE_PROMPT_TAIL}`;
  return {
    prompt:
      prompt.length > IMAGE_PROMPT_LIMITS.maxPromptChars
        ? prompt.slice(0, IMAGE_PROMPT_LIMITS.maxPromptChars)
        : prompt,
    aspect: wide ? '16:9' : '1:1',
    width: wide ? 1344 : 1024,
    height: wide ? 768 : 1024,
    headlineTokens: tokens,
  };
}

/** The prompt inputs read from a stored editorial document. */
export interface ImagePromptDocumentInput {
  readonly headline: string;
  readonly categoryEmoji?: SoulCategoryEmoji;
}

/**
 * Defensively read the headline + category emoji from a stored
 * editorial document (schemaVersion 1, the same shape
 * `renderEditorialPostText` validates). Returns null when the document
 * is unparseable, the wrong version, or has no usable headline — never
 * a throw, never a guess. A missing/invalid category emoji degrades to
 * "no category" (the default scene); only the headline is required.
 */
export function extractImagePromptInput(documentJson: string): ImagePromptDocumentInput | null {
  if (typeof documentJson !== 'string' || documentJson.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record['schemaVersion'] !== 1) {
    return null;
  }
  const headline = record['headlineFa'];
  if (typeof headline !== 'string' || headline.trim().length === 0) {
    return null;
  }
  const emoji = record['categoryEmoji'];
  const categoryEmoji =
    typeof emoji === 'string' && (SOUL_CATEGORY_EMOJIS as readonly string[]).includes(emoji)
      ? (emoji as SoulCategoryEmoji)
      : undefined;
  return categoryEmoji === undefined ? { headline } : { headline, categoryEmoji };
}
