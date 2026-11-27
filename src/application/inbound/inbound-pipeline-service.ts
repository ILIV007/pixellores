import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  createInboundApproval,
  findPendingInboundApprovalBySource,
  findPublishedPostBySource,
  getInboundApproval,
  recordPublishedPost,
  transitionInboundApproval,
  updateInboundApprovalContent,
  updatePublishedPostAfterEdit,
} from '../../adapters/db/inbound-store';
import {
  readPublishingSettings,
  recordOwnerPublication,
} from '../../adapters/db/publishing-settings-store';
import { getCurrentSoulVersion } from '../../adapters/db/soul-store';
import { consumeActionToken, issueActionToken } from '../../adapters/telegram/action-tokens';
import type {
  ParsedMediaAttachment,
  ParsedRichTextExtraction,
} from '../../adapters/telegram/update-parser';
import { ADMIN_POST_STRINGS } from '../../admin/admin-post-strings';
import { INBOUND_STRINGS, type Localized } from '../../admin/inbound-strings';
import { roleHasPermission, type AdminRole } from '../../admin/roles';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBlockquote,
  wrapTelegramHtml,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import type { AdminUiLanguage } from '../../admin/ui-language';
import type { AdminPostButtons, AdminPostExecutionResult } from '../admin-post/admin-post-service';
import { createPostContentDocument } from '../../domain/admin-post/post-content';
import {
  fingerprintOfSerializedEnvelope,
  isHexDigest64,
  randomToken,
} from '../../domain/admin-post/fingerprint';
import {
  INBOUND_APPROVAL_EXPIRY_MS,
  INBOUND_APPROVAL_TTL_HOURS,
} from '../../domain/inbound/approval';
import {
  classifyGaming,
  GAMING_CATEGORIES,
  type GamingCategory,
} from '../../domain/inbound/classifier';
import { cleanInboundText } from '../../domain/inbound/cleaner';
import { hasFormMarkers } from '../../domain/inbound/form-markers';
import {
  formatInboundPost,
  INBOUND_FOOTER,
  type InboundPostPart,
} from '../../domain/inbound/persian-format';
import {
  checkPreservation,
  extractFacts,
  findUnsafeLinks,
} from '../../domain/inbound/preservation';
import { decideRichPresentation, type InboundRichMode } from '../../domain/inbound/rich-decision';
import { AppError } from '../../shared/errors/app-error';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import {
  createRichTextEnvelope,
  MESSAGE_ENTITY_TYPES,
  type RichTextEntity,
  type RichTextEnvelope,
} from '../../domain/telegram/rich-text-envelope';
import type { InboundRewriter } from './soul-rewriter';

/**
 * Slice 4 — inbound AI-admin pipeline (DESIGN §10.1/§10.2).
 *
 * The owner sends a post in the bot's PV. It flows through:
 *   clean → classify → AI rewrite (fallback: cleaned text, never fabricate)
 *   → preservation check (fallback: cleaned text) → Persian format +
 *   normalization → rich decision → route per mode (direct by default;
 *   approval → 24h-expiring preview; paused → «bot is off», nothing queued)
 *   → publish + PV copy + a `published_posts` record for later edits.
 *
 * Gating: the pipeline never sends when `livePublishEnabled` is off, and
 * owner posts never consume the daily cap (DESIGN §9.2) — they are recorded
 * in the separate `daily_posts_owner` bucket and are visible in stats.
 *
 * Edits override every mode including paused (DESIGN §10.2): an edit of a
 * source message re-runs the pipeline and edits the channel post in place
 * when the shape still fits (same kind, same media file, same part count);
 * otherwise the old channel messages are deleted and the new parts are
 * re-sent, and the `published_posts` row is updated. The media file itself
 * can never change through an edit — only the caption/text.
 *
 * Dedupe: the webhook's update_id atomic claim (ADR-0025) is the outer
 * boundary; inside the pipeline one pending approval per source message is
 * enforced by a partial unique index, and one published row per source
 * message by a unique index.
 *
 * Uncertain send outcomes (timeout / 5xx / unreadable response) are NEVER
 * auto-resent — the owner checks the channel.
 */

export const INBOUND_APPROVE_ACTION = 'inbound.approve';
export const INBOUND_REJECT_ACTION = 'inbound.reject';
/** The preview Edit button (ADR-0073 §6): arms the native message edit. */
export const INBOUND_EDIT_ACTION = 'inbound.edit';
export const INBOUND_APPROVAL_TTL_MS = INBOUND_APPROVAL_EXPIRY_MS;

/** Minimal transport: the real Bot API client is adapted to it in the webhook handler. */
export interface InboundTransport {
  sendMessageRich(input: {
    chatId: number | string;
    content: RichTextEnvelope;
  }): Promise<{ messageId: number }>;
  sendPhotoRich(input: {
    chatId: number | string;
    photo: string;
    caption?: RichTextEnvelope;
  }): Promise<{ messageId: number }>;
  sendVideoRich(input: {
    chatId: number | string;
    video: string;
    caption?: RichTextEnvelope;
  }): Promise<{ messageId: number }>;
  sendMessageClassic(input: {
    chatId: number | string;
    html: TelegramSafeHtml;
  }): Promise<{ messageId: number }>;
  editMessageTextRich(input: {
    chatId: number | string;
    messageId: number;
    content: RichTextEnvelope;
  }): Promise<boolean>;
  editMessageCaptionRich(input: {
    chatId: number | string;
    messageId: number;
    content: RichTextEnvelope;
  }): Promise<boolean>;
  editMessageTextClassic(input: {
    chatId: number | string;
    messageId: number;
    html: TelegramSafeHtml;
  }): Promise<boolean>;
  deleteMessage(input: { chatId: number | string; messageId: number }): Promise<boolean>;
}

export interface InboundPipelineConfig {
  readonly livePublishEnabled: boolean;
  readonly destination?: string;
  readonly richMode?: InboundRichMode;
}

export interface InboundPipelineDeps {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: InboundPipelineConfig;
  readonly transport?: InboundTransport;
  readonly rewriter?: InboundRewriter;
}

export interface InboundProcessInput {
  readonly chatId: number;
  readonly telegramUserId: number;
  readonly role: AdminRole;
  readonly uiLanguage: AdminUiLanguage;
  readonly updateId: number;
  readonly sourceMessageId?: number;
  readonly kind: 'message' | 'edited_message';
  readonly text: string | undefined;
  readonly hasText: boolean;
  readonly richText: ParsedRichTextExtraction | undefined;
  readonly media: ParsedMediaAttachment | undefined;
  readonly richCaption: ParsedRichTextExtraction | undefined;
  readonly inMediaGroup: boolean;
  readonly hasMediaAttachment: boolean;
}

export interface InboundCallbackInput {
  readonly telegramUserId: number;
  readonly role: AdminRole;
  readonly uiLanguage: AdminUiLanguage;
  readonly token: string;
}

export interface InboundPipelineService {
  processInbound(input: InboundProcessInput): Promise<AdminPostExecutionResult>;
  /** Callbacks always answer (approve / reject / expired / invalid). */
  handleCallback(
    input: InboundCallbackInput,
  ): Promise<Extract<AdminPostExecutionResult, { readonly kind: 'answer' }>>;
}

/** The durable, fingerprint-bound content stored for an approval preview. */
interface StoredInboundContent {
  readonly kind: 'text' | 'photo' | 'video';
  readonly fileId?: string;
  readonly parts: readonly InboundPostPart[];
  readonly category: GamingCategory;
  readonly presentation: 'rich' | 'classic';
}

interface ProcessedPost {
  readonly kind: 'text' | 'photo' | 'video';
  readonly fileId: string | undefined;
  readonly parts: readonly InboundPostPart[];
  readonly category: GamingCategory;
  readonly presentation: 'rich' | 'classic';
  readonly contentJson: string;
  readonly fingerprint: string;
}

interface PublishTarget {
  readonly sourceChatId: number;
  readonly sourceMessageId: number;
  readonly createdByUserId: number;
}

type SendOutcome =
  | { readonly kind: 'sent'; readonly channelMessageIds: readonly number[] }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'no_destination' }
  | { readonly kind: 'transport_unavailable' }
  | { readonly kind: 'failed_definitive'; readonly errorCode: string }
  | { readonly kind: 'uncertain'; readonly errorCode: string };

const FOOTER_BLOCK = `\n\n${INBOUND_FOOTER}`;

function localize(ui: AdminUiLanguage, entry: Localized): string {
  return entry[ui];
}

function reply(ui: AdminUiLanguage, entry: Localized): AdminPostExecutionResult {
  return { kind: 'reply', text: escapeTelegramHtml(localize(ui, entry)) };
}

function answer(
  ui: AdminUiLanguage,
  entry: Localized,
): Extract<AdminPostExecutionResult, { readonly kind: 'answer' }> {
  return { kind: 'answer', callbackText: localize(ui, entry) };
}

function toStableErrorCode(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'unknown_send_error';
}

/**
 * Definitive send failure = PROVED non-delivery (same rule as the admin
 * post service): 4xx client errors (including 429) and pre-fetch typed
 * rejections. Timeout / network / 5xx / unreadable response are UNCERTAIN.
 */
function isDefinitiveSendFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    return true;
  }
  if (error instanceof Error && error.name === 'TelegramApiError') {
    if ((error as { code?: unknown }).code === 'telegram_response_invalid') {
      return false;
    }
    return (error as { retryable?: unknown }).retryable === false;
  }
  return false;
}

function destinationChatId(destination: string): number | string {
  if (/^-?[0-9]+$/.test(destination)) {
    return Number.parseInt(destination, 10);
  }
  return destination;
}

function envelopeForPart(part: InboundPostPart) {
  return createRichTextEnvelope({
    kind: part.kind === 'caption' ? 'caption' : 'text',
    text: part.text,
    entities: part.entities ?? [],
  });
}

/**
 * Render one part's form #4 entities as classic HTML (ADR-0073 §4):
 * bold spans become <b>, blockquote spans become <blockquote>, with
 * nesting (bold inside a quote) preserved. Entities never cross — the
 * marker parser guarantees bold strictly inside blockquote; a crossing
 * or equal-range set fails closed to null and the caller falls back to
 * plain escaped text.
 */
export function renderInboundEntitiesToHtml(
  text: string,
  entities: readonly RichTextEntity[],
): TelegramSafeHtml | null {
  if (entities.length === 0) {
    return escapeTelegramHtml(text);
  }
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const aEnd = a.offset + a.length;
      const bEnd = b.offset + b.length;
      if (aEnd <= b.offset || bEnd <= a.offset) {
        continue;
      }
      const aContainsB = a.offset <= b.offset && aEnd >= bEnd;
      const bContainsA = b.offset <= a.offset && bEnd >= aEnd;
      if (!aContainsB && !bContainsA) {
        return null;
      }
      if (a.offset === b.offset && aEnd === bEnd) {
        return null;
      }
    }
  }
  // Recursive render over the sorted entities: direct children of a
  // range are emitted in order, each wrapped in its tag. `fromIndex`
  // keeps the recursion from re-entering the entity being rendered —
  // children always sort after their parent (offset asc, length desc),
  // so the child scan starts just past the parent.
  const renderRange = (start: number, end: number, fromIndex: number): TelegramSafeHtml | null => {
    const parts: TelegramSafeHtml[] = [];
    let cursor = start;
    for (let i = fromIndex; i < sorted.length; i += 1) {
      const entity = sorted[i]!;
      if (entity.offset < start || entity.offset + entity.length > end) {
        continue;
      }
      // Skip entities already consumed as a child of an earlier sibling.
      if (entity.offset < cursor) {
        continue;
      }
      if (entity.type !== 'bold' && entity.type !== 'blockquote') {
        return null;
      }
      if (entity.offset > cursor) {
        parts.push(escapeTelegramHtml(text.slice(cursor, entity.offset)));
      }
      const inner = renderRange(entity.offset, entity.offset + entity.length, i + 1);
      if (inner === null) {
        return null;
      }
      parts.push(wrapTelegramHtml(entity.type === 'bold' ? 'b' : 'blockquote', inner));
      cursor = entity.offset + entity.length;
    }
    if (end > cursor) {
      parts.push(escapeTelegramHtml(text.slice(cursor, end)));
    }
    return parts.join('') as TelegramSafeHtml;
  };
  return renderRange(0, text.length, 0);
}

/**
 * Classic HTML rendering of one formatted part: plain text is escaped, and
 * the rendered footer (never modeled) becomes a trailing blockquote — the
 * AI-admin classic style — instead of plain footer text. When the part
 * carries form #4 entities they render as <b> / <blockquote> HTML.
 */
function classicHtmlForPart(part: InboundPostPart): TelegramSafeHtml {
  if (part.text.endsWith(FOOTER_BLOCK)) {
    const body = part.text.slice(0, -FOOTER_BLOCK.length);
    const rendered =
      part.entities !== undefined && part.entities.length > 0
        ? renderInboundEntitiesToHtml(body, part.entities)
        : escapeTelegramHtml(body);
    return composeTelegramHtml([
      rendered ?? escapeTelegramHtml(body),
      telegramBlockquote(INBOUND_FOOTER),
    ]);
  }
  if (part.entities !== undefined && part.entities.length > 0) {
    return renderInboundEntitiesToHtml(part.text, part.entities) ?? escapeTelegramHtml(part.text);
  }
  return escapeTelegramHtml(part.text);
}

function parseStoredContent(json: string): StoredInboundContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'text' && kind !== 'photo' && kind !== 'video') {
    return null;
  }
  const fileId = record.fileId;
  if (fileId !== undefined && typeof fileId !== 'string') {
    return null;
  }
  if (kind === 'text' && fileId !== undefined) {
    return null;
  }
  if (kind !== 'text' && typeof fileId !== 'string') {
    return null;
  }
  const parts = record.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return null;
  }
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) {
      return null;
    }
    const partRecord = part as Record<string, unknown>;
    if (partRecord.kind !== 'text' && partRecord.kind !== 'caption') {
      return null;
    }
    if (typeof partRecord.text !== 'string' || partRecord.text.length === 0) {
      return null;
    }
    // Form #4 entities (ADR-0073 §3): the bare {type, offset, length}
    // shape only, in-range against the part text. A corrupt entity set
    // rejects the whole stored content (the approve path answers
    // storedContentCorrupt, never publishes).
    const entities = partRecord.entities;
    if (entities !== undefined) {
      if (!Array.isArray(entities)) {
        return null;
      }
      for (const entity of entities) {
        if (typeof entity !== 'object' || entity === null) {
          return null;
        }
        const entityRecord = entity as Record<string, unknown>;
        for (const key of Object.keys(entityRecord)) {
          if (key !== 'type' && key !== 'offset' && key !== 'length') {
            return null;
          }
        }
        if (
          typeof entityRecord.type !== 'string' ||
          !(MESSAGE_ENTITY_TYPES as readonly string[]).includes(entityRecord.type)
        ) {
          return null;
        }
        if (
          typeof entityRecord.offset !== 'number' ||
          !Number.isSafeInteger(entityRecord.offset) ||
          (entityRecord.offset as number) < 0
        ) {
          return null;
        }
        if (
          typeof entityRecord.length !== 'number' ||
          !Number.isSafeInteger(entityRecord.length) ||
          (entityRecord.length as number) <= 0
        ) {
          return null;
        }
        if (
          (entityRecord.offset as number) + (entityRecord.length as number) >
          (partRecord.text as string).length
        ) {
          return null;
        }
      }
    }
  }
  const category = record.category;
  if (
    typeof category !== 'string' ||
    !(GAMING_CATEGORIES as readonly string[]).includes(category)
  ) {
    return null;
  }
  const presentation = record.presentation;
  if (presentation !== 'rich' && presentation !== 'classic') {
    return null;
  }
  return {
    kind,
    fileId: typeof fileId === 'string' ? fileId : undefined,
    parts: parts as readonly InboundPostPart[],
    category: category as GamingCategory,
    presentation,
  };
}

export function createInboundPipelineService(deps: InboundPipelineDeps): InboundPipelineService {
  const { executor, clock, logger, config, transport, rewriter } = deps;
  const richMode: InboundRichMode = config.richMode ?? 'auto';

  async function processPipeline(
    input: InboundProcessInput,
    options?: { readonly skipRewrite?: boolean },
  ): Promise<
    | { readonly ok: true; readonly processed: ProcessedPost }
    | {
        readonly ok: false;
        readonly reason: 'no_text_content' | 'unsafe_link' | 'unsupported_media' | 'album';
      }
  > {
    // Document + album are slice-8 work (media/R2): an explicit honest
    // rejection, never a silent drop. Documents (and every other
    // non-photo/video shape) arrive as media kind 'unsupported'.
    const media = input.media;
    if (input.inMediaGroup) {
      return { ok: false, reason: 'album' };
    }
    if (media?.kind === 'unsupported') {
      return { ok: false, reason: 'unsupported_media' };
    }

    const sourceText = input.text ?? '';
    if (!input.hasText && media === undefined) {
      return { ok: false, reason: 'no_text_content' };
    }
    const cleaned = cleanInboundText(sourceText);
    if (cleaned.length === 0 && media === undefined) {
      return { ok: false, reason: 'no_text_content' };
    }

    const unsafe = findUnsafeLinks(cleaned);
    if (unsafe.length > 0) {
      logger.warn('inbound.pipeline.unsafe_link', { count: unsafe.length });
      return { ok: false, reason: 'unsafe_link' };
    }

    const category = classifyGaming(cleaned).category;
    const isCaption = media !== undefined;

    // AI rewrite with the Pixel persona; any failure falls back to the
    // cleaned text — never fabricate. `skipRewrite` (the pending-preview
    // edit path, ADR-0073 §6) keeps the owner's correction authoritative:
    // no AI pass over text the owner just fixed by hand.
    let bodyText = cleaned;
    let rewriteUsed = false;
    if (rewriter !== undefined && cleaned.length > 0 && options?.skipRewrite !== true) {
      const outcome = await rewriter.rewrite({ text: cleaned, category, isCaption });
      if (outcome.kind === 'ok') {
        bodyText = outcome.text;
        rewriteUsed = true;
      } else {
        logger.info('inbound.pipeline.rewrite_fallback', { reason: outcome.reason });
      }
    }

    // Preservation: every fact the owner sent must survive the rewrite.
    // If anything is lost, fall back to the cleaned text wholesale.
    if (rewriteUsed) {
      const sourceFacts = extractFacts(cleaned);
      const kept = checkPreservation(sourceFacts, bodyText);
      if (!kept.ok) {
        logger.info('inbound.pipeline.preservation_fallback', { missing: kept.missing });
        bodyText = cleaned;
        rewriteUsed = false;
      }
    }

    // Rich only preserves entities when the text was NOT rewritten — a
    // rewrite invalidates every source offset.
    const sourceWasRich =
      (input.richText !== undefined || input.richCaption !== undefined) && !rewriteUsed;
    const kind: 'text' | 'photo' | 'video' =
      media === undefined ? 'text' : media.kind === 'photo' ? 'photo' : 'video';
    const fileId = media?.fileId;
    const presentation = decideRichPresentation({
      sourceWasRich,
      partCount: 1,
      media: kind === 'text' ? 'none' : kind,
      richMode,
      // A rewritten post carrying form #4 markers goes rich (ADR-0073 §4).
      contentHasEntities: rewriteUsed && hasFormMarkers(bodyText),
    });
    const parts = formatInboundPost({
      text: bodyText,
      media: kind === 'text' ? 'none' : kind,
      markers: rewriteUsed,
    });
    const content: StoredInboundContent = {
      kind,
      ...(fileId !== undefined ? { fileId } : {}),
      parts,
      category,
      presentation,
    };
    const contentJson = JSON.stringify(content);
    const fingerprint = await fingerprintOfSerializedEnvelope(contentJson);
    return {
      ok: true,
      processed: { kind, fileId, parts, category, presentation, contentJson, fingerprint },
    };
  }

  function previewDocument(processed: ProcessedPost) {
    const first = processed.parts[0];
    if (first === undefined) {
      return null;
    }
    const envelope = envelopeForPart(first);
    if (!envelope.ok) {
      return null;
    }
    if (processed.kind === 'text') {
      return createPostContentDocument({ media: 'none', text: envelope.envelope });
    }
    return createPostContentDocument({
      media: processed.kind,
      fileId: processed.fileId ?? '',
      caption: envelope.envelope,
    });
  }

  /**
   * Send ONE text part, rich first. A DEFINITIVE rich failure (proved
   * non-delivery: 4xx / pre-fetch rejection) falls back to classic HTML
   * for the same part. An UNCERTAIN failure (timeout / 5xx / unreadable
   * response — the send may have succeeded) is never retried, so the
   * channel can never receive the part twice.
   */
  async function sendTextPart(
    chatId: number | string,
    part: InboundPostPart,
    presentation: 'rich' | 'classic',
  ): Promise<{ messageId: number }> {
    if (transport === undefined) {
      throw new AppError('service_unavailable');
    }
    if (presentation === 'classic') {
      return transport.sendMessageClassic({ chatId, html: classicHtmlForPart(part) });
    }
    const envelope = envelopeForPart(part);
    if (!envelope.ok) {
      throw new AppError('internal_error');
    }
    try {
      return await transport.sendMessageRich({ chatId, content: envelope.envelope });
    } catch (error) {
      if (!isDefinitiveSendFailure(error)) {
        throw error;
      }
      logger.info('inbound.publish.rich_fallback_classic', { errorCode: toStableErrorCode(error) });
      return transport.sendMessageClassic({ chatId, html: classicHtmlForPart(part) });
    }
  }

  /**
   * Edit ONE text part in place, rich first with the same definitive-only
   * classic fallback as `sendTextPart` (an uncertain edit failure is never
   * retried — the edit may already have applied).
   */
  async function editTextPart(
    chatId: number | string,
    messageId: number,
    part: InboundPostPart,
    presentation: 'rich' | 'classic',
  ): Promise<void> {
    if (transport === undefined) {
      throw new AppError('service_unavailable');
    }
    if (presentation === 'classic') {
      await transport.editMessageTextClassic({ chatId, messageId, html: classicHtmlForPart(part) });
      return;
    }
    const envelope = envelopeForPart(part);
    if (!envelope.ok) {
      throw new AppError('internal_error');
    }
    try {
      await transport.editMessageTextRich({ chatId, messageId, content: envelope.envelope });
    } catch (error) {
      if (!isDefinitiveSendFailure(error)) {
        throw error;
      }
      logger.info('inbound.edit.rich_fallback_classic', { errorCode: toStableErrorCode(error) });
      await transport.editMessageTextClassic({ chatId, messageId, html: classicHtmlForPart(part) });
    }
  }

  async function sendParts(processed: ProcessedPost, destination: string): Promise<SendOutcome> {
    if (!config.livePublishEnabled) {
      return { kind: 'disabled' };
    }
    if (destination === '') {
      return { kind: 'no_destination' };
    }
    if (transport === undefined) {
      return { kind: 'transport_unavailable' };
    }
    const chatId = destinationChatId(destination);
    const channelMessageIds: number[] = [];
    try {
      for (let index = 0; index < processed.parts.length; index += 1) {
        const part = processed.parts[index];
        if (part === undefined) {
          break;
        }
        // Media part: the first part is the caption on the photo/video.
        // Media always travels on the rich-entity transport (no classic
        // media send exists in the client); the presentation applies to
        // TEXT parts.
        if (index === 0 && processed.kind !== 'text') {
          const envelope = envelopeForPart(part);
          if (!envelope.ok) {
            return { kind: 'failed_definitive', errorCode: 'caption_envelope_invalid' };
          }
          const sent =
            processed.kind === 'photo'
              ? await transport.sendPhotoRich({
                  chatId,
                  photo: processed.fileId ?? '',
                  caption: envelope.envelope,
                })
              : await transport.sendVideoRich({
                  chatId,
                  video: processed.fileId ?? '',
                  caption: envelope.envelope,
                });
          channelMessageIds.push(sent.messageId);
          continue;
        }
        const sent = await sendTextPart(chatId, part, processed.presentation);
        channelMessageIds.push(sent.messageId);
      }
    } catch (error) {
      const errorCode = toStableErrorCode(error);
      logger.warn('inbound.publish.send_failed', { errorCode });
      return isDefinitiveSendFailure(error)
        ? { kind: 'failed_definitive', errorCode }
        : { kind: 'uncertain', errorCode };
    }
    return { kind: 'sent', channelMessageIds };
  }

  async function copyToPv(processed: ProcessedPost, pvChatId: number): Promise<void> {
    if (transport === undefined) {
      return;
    }
    try {
      for (let index = 0; index < processed.parts.length; index += 1) {
        const part = processed.parts[index];
        if (part === undefined) {
          break;
        }
        if (index === 0 && processed.kind !== 'text') {
          const envelope = envelopeForPart(part);
          if (!envelope.ok) {
            return;
          }
          if (processed.kind === 'photo') {
            await transport.sendPhotoRich({
              chatId: pvChatId,
              photo: processed.fileId ?? '',
              caption: envelope.envelope,
            });
          } else {
            await transport.sendVideoRich({
              chatId: pvChatId,
              video: processed.fileId ?? '',
              caption: envelope.envelope,
            });
          }
          continue;
        }
        await sendTextPart(pvChatId, part, processed.presentation);
      }
    } catch (error) {
      // A PV-copy failure never fails the publish; it is logged only.
      logger.warn('inbound.publish.pv_copy_failed', { errorCode: toStableErrorCode(error) });
    }
  }

  async function publishProcessed(
    processed: ProcessedPost,
    target: PublishTarget,
  ): Promise<SendOutcome> {
    const outcome = await sendParts(processed, config.destination ?? '');
    if (outcome.kind !== 'sent') {
      return outcome;
    }
    // Record FIRST, then copy to the PV: the published_posts row is what
    // makes the post editable later, and it must exist before any reply.
    // Slice 8 — stamp the active Soul version (DESIGN §9.3); NULL when no
    // Soul is recorded yet (the lookup is fail-soft and never fails a
    // publish).
    const soulVersion = await getCurrentSoulVersion(executor);
    await recordPublishedPost(executor, {
      id: randomToken(),
      sourceChatId: target.sourceChatId,
      sourceMessageId: target.sourceMessageId,
      channelMessageIds: outcome.channelMessageIds,
      kind: processed.kind,
      mediaFileId: processed.fileId ?? null,
      category: processed.category,
      presentation: processed.presentation,
      createdByUserId: target.createdByUserId,
      soulVersion,
      nowMs: clock.now(),
    });
    await recordOwnerPublication(executor, { nowMs: clock.now() });
    await copyToPv(processed, target.sourceChatId);
    return outcome;
  }

  function sendOutcomeReply(
    ui: AdminUiLanguage,
    outcome: SendOutcome,
    category: GamingCategory,
  ): AdminPostExecutionResult {
    switch (outcome.kind) {
      case 'sent':
        return reply(ui, INBOUND_STRINGS.inboundPublished(category));
      case 'disabled':
        return reply(ui, ADMIN_POST_STRINGS.publishDisabled);
      case 'no_destination':
        return reply(ui, ADMIN_POST_STRINGS.publishMissingDestination);
      case 'transport_unavailable':
        return reply(ui, ADMIN_POST_STRINGS.publishTransportUnavailable);
      case 'failed_definitive':
        return reply(ui, ADMIN_POST_STRINGS.publishFailedDefinitive);
      case 'uncertain':
        return reply(ui, ADMIN_POST_STRINGS.publishUncertain);
    }
  }

  function sendOutcomeEntry(outcome: SendOutcome, category: GamingCategory): Localized {
    switch (outcome.kind) {
      case 'sent':
        return INBOUND_STRINGS.inboundPublished(category);
      case 'disabled':
        return ADMIN_POST_STRINGS.publishDisabled;
      case 'no_destination':
        return ADMIN_POST_STRINGS.publishMissingDestination;
      case 'transport_unavailable':
        return ADMIN_POST_STRINGS.publishTransportUnavailable;
      case 'failed_definitive':
        return ADMIN_POST_STRINGS.publishFailedDefinitive;
      case 'uncertain':
        return ADMIN_POST_STRINGS.publishUncertain;
    }
  }

  /**
   * Build the approval preview for an EXISTING approval row: mint fresh
   * single-use tokens (approve / reject / edit) and return the preview
   * result. Shared by `routeApproval` (new approval) and the pending-
   * edit path (updated approval, ADR-0073 §6).
   */
  async function buildApprovalPreview(
    input: InboundProcessInput,
    processed: ProcessedPost,
    approvalId: string,
  ): Promise<AdminPostExecutionResult> {
    const ui = input.uiLanguage;
    const nowMs = clock.now();
    const document = previewDocument(processed);
    if (document === null || !document.ok) {
      return reply(ui, ADMIN_POST_STRINGS.captureInvalidContent);
    }
    // The tokens are minted first so the buttons can carry them
    // (`a:<token>`, the opaque callback contract); the approval row already
    // exists, so a token minted here always has a live target.
    const approveToken = randomToken();
    const rejectToken = randomToken();
    const editToken = randomToken();
    await issueActionToken(executor, {
      token: approveToken,
      telegramUserId: input.telegramUserId,
      permission: 'publication.publish',
      action: INBOUND_APPROVE_ACTION,
      targetType: 'inbound_approval',
      targetId: approvalId,
      payloadJson: JSON.stringify({ approvalId }),
      expiresAtMs: nowMs + INBOUND_APPROVAL_TTL_MS,
      nowMs,
    });
    await issueActionToken(executor, {
      token: rejectToken,
      telegramUserId: input.telegramUserId,
      permission: 'draft.approve',
      action: INBOUND_REJECT_ACTION,
      targetType: 'inbound_approval',
      targetId: approvalId,
      payloadJson: JSON.stringify({ approvalId }),
      expiresAtMs: nowMs + INBOUND_APPROVAL_TTL_MS,
      nowMs,
    });
    await issueActionToken(executor, {
      token: editToken,
      telegramUserId: input.telegramUserId,
      permission: 'draft.approve',
      action: INBOUND_EDIT_ACTION,
      targetType: 'inbound_approval',
      targetId: approvalId,
      payloadJson: JSON.stringify({ approvalId }),
      expiresAtMs: nowMs + INBOUND_APPROVAL_TTL_MS,
      nowMs,
    });
    const header = localize(
      ui,
      INBOUND_STRINGS.inboundApprovalPreviewHeader(
        processed.category,
        processed.parts.length,
        INBOUND_APPROVAL_TTL_HOURS,
      ),
    );
    const buttons: AdminPostButtons = [
      [
        {
          text: localize(ui, INBOUND_STRINGS.inboundEditButton),
          callbackData: `a:${editToken}`,
        },
        {
          text: localize(ui, INBOUND_STRINGS.inboundApproveButton),
          callbackData: `a:${approveToken}`,
        },
        {
          text: localize(ui, INBOUND_STRINGS.inboundRejectButton),
          callbackData: `a:${rejectToken}`,
        },
      ],
    ];
    const firstPart = processed.parts[0] as InboundPostPart;
    return {
      kind: 'preview',
      content: document.document,
      classicText: processed.presentation === 'classic' ? classicHtmlForPart(firstPart) : undefined,
      control: escapeTelegramHtml(header),
      buttons,
    };
  }

  async function routeApproval(
    input: InboundProcessInput,
    processed: ProcessedPost,
  ): Promise<AdminPostExecutionResult> {
    const ui = input.uiLanguage;
    const nowMs = clock.now();
    const created = await createInboundApproval(executor, {
      id: randomToken(),
      sourceChatId: input.chatId,
      sourceMessageId: input.sourceMessageId ?? 0,
      sourceUpdateId: input.updateId,
      createdByUserId: input.telegramUserId,
      contentJson: processed.contentJson,
      fingerprint: processed.fingerprint,
      category: processed.category,
      presentation: processed.presentation,
      expiresAtMs: nowMs + INBOUND_APPROVAL_TTL_MS,
      nowMs,
    });
    if (created.kind === 'already_pending') {
      return reply(ui, INBOUND_STRINGS.inboundAlreadyPending);
    }
    return buildApprovalPreview(input, processed, created.id);
  }

  async function processNewInbound(input: InboundProcessInput): Promise<AdminPostExecutionResult> {
    const ui = input.uiLanguage;
    const processed = await processPipeline(input);
    if (!processed.ok) {
      switch (processed.reason) {
        case 'album':
          return reply(ui, ADMIN_POST_STRINGS.captureAlbumRejected);
        case 'unsupported_media':
          return reply(ui, ADMIN_POST_STRINGS.captureMediaRejected);
        case 'unsafe_link':
          return reply(ui, INBOUND_STRINGS.inboundUnsafeLink);
        case 'no_text_content':
          return reply(ui, ADMIN_POST_STRINGS.noTextContent);
      }
    }

    // Routing per mode (DESIGN §10.2, ADR-0073 §5): every mode except
    // paused goes through the approval preview — auto / safe-auto no
    // longer publish directly. The preview IS the approval: Publish
    // approves and sends in one act (there is no held-approved queue
    // for owner posts). Edits override every mode including paused and
    // go through processEdit, never here.
    const settings = await readPublishingSettings(executor);
    if (settings.mode === 'paused') {
      logger.info('inbound.route.paused', {});
      return reply(ui, ADMIN_POST_STRINGS.pausedBotOff);
    }
    return routeApproval(input, processed.processed);
  }

  async function processEdit(input: InboundProcessInput): Promise<AdminPostExecutionResult> {
    const ui = input.uiLanguage;
    const sourceMessageId = input.sourceMessageId ?? 0;
    const row = await findPublishedPostBySource(executor, {
      sourceChatId: input.chatId,
      sourceMessageId,
    });
    if (row === null) {
      // ADR-0073 §6: an edit of a message with a PENDING approval
      // preview updates the preview — the owner's correction is
      // authoritative, so it re-processes WITHOUT an AI rewrite, then
      // re-shows the preview with fresh tokens. The 24h expiry is NOT
      // extended by an edit.
      const pending = await findPendingInboundApprovalBySource(executor, {
        sourceChatId: input.chatId,
        sourceMessageId,
      });
      if (pending === null) {
        // An edit of a never-published, never-pending message stays silent (legacy).
        return { kind: 'none' };
      }
      const processed = await processPipeline(input, { skipRewrite: true });
      if (!processed.ok) {
        switch (processed.reason) {
          case 'album':
            return reply(ui, ADMIN_POST_STRINGS.captureAlbumRejected);
          case 'unsupported_media':
            return reply(ui, ADMIN_POST_STRINGS.captureMediaRejected);
          case 'unsafe_link':
            return reply(ui, INBOUND_STRINGS.inboundUnsafeLink);
          case 'no_text_content':
            return reply(ui, ADMIN_POST_STRINGS.noTextContent);
        }
      }
      const next = processed.processed;
      const updated = await updateInboundApprovalContent(executor, {
        id: pending.id,
        contentJson: next.contentJson,
        fingerprint: next.fingerprint,
        nowMs: clock.now(),
      });
      if (!updated) {
        // The approval was decided concurrently — the old preview's
        // buttons already answer honestly for a non-pending row.
        logger.info('inbound.edit.preview_already_decided', {});
        return reply(ui, INBOUND_STRINGS.inboundPreviewAlreadyDecided);
      }
      logger.info('inbound.edit.preview_updated', {});
      return buildApprovalPreview(input, next, pending.id);
    }
    // Edits override every mode, including paused (DESIGN §10.2) — but the
    // live gate still applies, and it is checked BEFORE any channel
    // mutation (an edit must never delete a post it cannot re-send).
    if (!config.livePublishEnabled) {
      return reply(ui, ADMIN_POST_STRINGS.publishDisabled);
    }
    const destination = config.destination ?? '';
    if (destination === '') {
      return reply(ui, ADMIN_POST_STRINGS.publishMissingDestination);
    }
    if (transport === undefined) {
      return reply(ui, ADMIN_POST_STRINGS.publishTransportUnavailable);
    }
    const processed = await processPipeline(input);
    if (!processed.ok) {
      switch (processed.reason) {
        case 'album':
          return reply(ui, ADMIN_POST_STRINGS.captureAlbumRejected);
        case 'unsupported_media':
          return reply(ui, ADMIN_POST_STRINGS.captureMediaRejected);
        case 'unsafe_link':
          return reply(ui, INBOUND_STRINGS.inboundUnsafeLink);
        case 'no_text_content':
          return reply(ui, ADMIN_POST_STRINGS.noTextContent);
      }
    }
    const next = processed.processed;
    const chatId = destinationChatId(destination);
    const oldIds = row.channelMessageIds;
    const fitsInPlace =
      next.parts.length === oldIds.length &&
      next.kind === row.kind &&
      (next.kind === 'text' || next.fileId === row.mediaFileId);

    if (fitsInPlace) {
      try {
        for (let index = 0; index < next.parts.length; index += 1) {
          const part = next.parts[index];
          const messageId = oldIds[index];
          if (part === undefined || messageId === undefined) {
            break;
          }
          if (index === 0 && next.kind !== 'text') {
            const envelope = envelopeForPart(part);
            if (!envelope.ok) {
              return reply(ui, INBOUND_STRINGS.inboundEditFailed);
            }
            await transport.editMessageCaptionRich({
              chatId,
              messageId,
              content: envelope.envelope,
            });
            continue;
          }
          await editTextPart(chatId, messageId, part, next.presentation);
        }
      } catch (error) {
        logger.warn('inbound.edit.failed', { errorCode: toStableErrorCode(error) });
        return reply(ui, INBOUND_STRINGS.inboundEditFailed);
      }
      await updatePublishedPostAfterEdit(executor, {
        id: row.id,
        channelMessageIds: oldIds,
        kind: next.kind,
        mediaFileId: next.fileId ?? null,
        category: next.category,
        presentation: next.presentation,
        nowMs: clock.now(),
      });
      return reply(ui, INBOUND_STRINGS.inboundEdited);
    }

    // Shape changed (part count, kind, or media file): delete the old
    // channel messages and re-send the new parts.
    try {
      for (const messageId of oldIds) {
        await transport.deleteMessage({ chatId, messageId });
      }
    } catch (error) {
      logger.warn('inbound.edit.delete_failed', { errorCode: toStableErrorCode(error) });
      return reply(ui, INBOUND_STRINGS.inboundEditFailed);
    }
    const outcome = await sendParts(next, destination);
    if (outcome.kind !== 'sent') {
      return sendOutcomeReply(ui, outcome, next.category);
    }
    await updatePublishedPostAfterEdit(executor, {
      id: row.id,
      channelMessageIds: outcome.channelMessageIds,
      kind: next.kind,
      mediaFileId: next.fileId ?? null,
      category: next.category,
      presentation: next.presentation,
      nowMs: clock.now(),
    });
    await copyToPv(next, input.chatId);
    return reply(ui, INBOUND_STRINGS.inboundEdited);
  }

  async function handleCallback(
    input: InboundCallbackInput,
  ): Promise<Extract<AdminPostExecutionResult, { readonly kind: 'answer' }>> {
    const ui = input.uiLanguage;
    const nowMs = clock.now();
    const consumed = await consumeActionToken(executor, {
      token: input.token,
      telegramUserId: input.telegramUserId,
      nowMs,
    });
    if (consumed.kind === 'invalid') {
      return answer(ui, ADMIN_POST_STRINGS.callbackInvalidToken);
    }
    const record = consumed.record;
    // Defense in depth: the role must STILL hold the token's permission.
    if (!roleHasPermission(input.role, record.permission)) {
      logger.warn('inbound.callback.permission_revoked', { action: record.action });
      return answer(ui, ADMIN_POST_STRINGS.permissionRevoked);
    }
    if (
      record.action !== INBOUND_APPROVE_ACTION &&
      record.action !== INBOUND_REJECT_ACTION &&
      record.action !== INBOUND_EDIT_ACTION
    ) {
      return answer(ui, ADMIN_POST_STRINGS.callbackInvalidToken);
    }
    let approvalId = '';
    try {
      const payload = JSON.parse(record.payloadJson) as unknown;
      if (typeof payload === 'object' && payload !== null) {
        const value = (payload as Record<string, unknown>).approvalId;
        if (typeof value === 'string') {
          approvalId = value;
        }
      }
    } catch {
      approvalId = '';
    }
    if (approvalId === '') {
      return answer(ui, ADMIN_POST_STRINGS.callbackInvalidToken);
    }
    const approval = await getInboundApproval(executor, approvalId);
    if (approval === null) {
      return answer(ui, ADMIN_POST_STRINGS.callbackInvalidToken);
    }
    if (approval.state !== 'pending') {
      return answer(ui, ADMIN_POST_STRINGS.callbackInvalidToken);
    }
    if (approval.expiresAtMs <= nowMs) {
      await transitionInboundApproval(executor, {
        id: approvalId,
        from: 'pending',
        to: 'expired',
        nowMs,
      });
      return answer(ui, INBOUND_STRINGS.inboundApprovalExpired);
    }

    if (record.action === INBOUND_EDIT_ACTION) {
      // ADR-0073 §6: the Edit button arms the native message edit — the
      // owner edits the original message and the pending-preview branch
      // of processEdit re-shows the preview. The token is single-use;
      // the fresh preview carries a fresh Edit token.
      return answer(ui, INBOUND_STRINGS.inboundEditInstructions);
    }

    if (record.action === INBOUND_REJECT_ACTION) {
      await transitionInboundApproval(executor, {
        id: approvalId,
        from: 'pending',
        to: 'rejected',
        nowMs,
      });
      return answer(ui, INBOUND_STRINGS.inboundRejected);
    }

    // Approve: verify the stored content (fingerprint-bound) BEFORE the
    // state transition, so a corrupt row is never marked approved.
    const content = parseStoredContent(approval.contentJson);
    if (content === null) {
      logger.warn('inbound.approve.content_corrupt', {});
      return answer(ui, ADMIN_POST_STRINGS.storedContentCorrupt);
    }
    const fingerprint = await fingerprintOfSerializedEnvelope(approval.contentJson);
    if (fingerprint !== approval.fingerprint || !isHexDigest64(approval.fingerprint)) {
      logger.warn('inbound.approve.fingerprint_mismatch', {});
      return answer(ui, ADMIN_POST_STRINGS.storedContentCorrupt);
    }
    // The live gate stops BEFORE any state change or Bot API call.
    if (!config.livePublishEnabled) {
      return answer(ui, ADMIN_POST_STRINGS.publishDisabled);
    }
    if ((config.destination ?? '') === '') {
      return answer(ui, ADMIN_POST_STRINGS.publishMissingDestination);
    }
    if (transport === undefined) {
      return answer(ui, ADMIN_POST_STRINGS.publishTransportUnavailable);
    }
    const moved = await transitionInboundApproval(executor, {
      id: approvalId,
      from: 'pending',
      to: 'approved',
      nowMs,
    });
    if (!moved) {
      return answer(ui, ADMIN_POST_STRINGS.callbackInvalidToken);
    }
    const processed: ProcessedPost = {
      kind: content.kind,
      fileId: content.fileId,
      parts: content.parts,
      category: content.category,
      presentation: content.presentation,
      contentJson: approval.contentJson,
      fingerprint: approval.fingerprint,
    };
    const outcome = await publishProcessed(processed, {
      sourceChatId: approval.sourceChatId,
      sourceMessageId: approval.sourceMessageId,
      createdByUserId: input.telegramUserId,
    });
    if (outcome.kind !== 'sent') {
      // The send failed: roll the approval back to pending so the row is
      // never stuck in 'approved' with nothing published. (The token is
      // single-use, so the owner re-sends the post as a new message.)
      await transitionInboundApproval(executor, {
        id: approvalId,
        from: 'approved',
        to: 'pending',
        nowMs: clock.now(),
      });
      return answer(ui, sendOutcomeEntry(outcome, content.category));
    }
    await transitionInboundApproval(executor, {
      id: approvalId,
      from: 'approved',
      to: 'published',
      nowMs: clock.now(),
    });
    return answer(ui, INBOUND_STRINGS.inboundPublished(content.category));
  }

  return {
    async processInbound(input) {
      if (input.kind === 'edited_message') {
        return processEdit(input);
      }
      return processNewInbound(input);
    },
    handleCallback,
  };
}
