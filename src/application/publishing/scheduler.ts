/**
 * Phase 8.2 — the DURABLE publication scheduler (the application
 * composition). The engine that turns the 8.1 pure policy layer (psp1) into
 * durable, reconciled sends over the blueprint-approved `publications`
 * outbox (schema 6 — consumed, zero DDL; ADR-0058).
 *
 * THE ADR-0032 GATE (the reason this slice exists): before autonomous
 * channel publishing is enabled, publishing needs a duplicate mitigation and
 * reconciliation layer with stronger at-most-once protection than raw
 * webhook responses. This engine delivers it:
 *
 *  - the per-candidate decision is made INSIDE the claimed section (fresh
 *    history every time — the policy always sees the current world);
 *  - the send is preceded by the EVIDENCE CHECK (`publication_messages`): a
 *    recorded delivery from a crashed earlier generation heals the row to
 *    `published` WITHOUT a second send — the recorded sub-window of the
 *    ambiguous window is CLOSED;
 *  - the message record (with the exact-bytes content hash) is written
 *    BEFORE the terminal — a crash between the two is healed by the next
 *    generation's evidence check;
 *  - the ledger's UNIQUE(chat_id, message_id) rejects a reused/forged
 *    message id — the honest outcome is `uncertain`, never a claimed
 *    published;
 *  - an uncertain outcome is NEVER auto-resent and never asserts
 *    proved-non-delivery (the machine has no such transition);
 *  - the retry family is bounded: only PROVED non-delivery with the
 *    server's retry_after (429) retries, on the SAME row with the SAME
 *    idempotency key, bounded by the blueprint §7 budget (3 normal / 5 P0)
 *    enforced AT the claim boundary.
 *
 * The LIVE surfaces stay BLOCKED_LIVE (Posidon only): the transport is
 * injected by the caller — nothing in this module can reach the network by
 * itself. A gate enabled WITHOUT a transport is a LOUD misconfiguration
 * (zero writes); a gate disabled makes the whole scan DECISION-ONLY
 * (zero durable writes — observation, not simulation).
 *
 * THE ALBUM WIRING (ADR-0060, the V4 carry): the send path consumes the
 * durable album content documents (the 7.3/7.4 contracts) through the
 * dedicated `PublicationMediaGroupTransport` seam — file_id-only (the
 * attachments array is always empty at send time), the send identity key
 * re-derived from the SAME shared derivation the upload path pins, the
 * ledger binding fail-closed BEFORE any send, the per-ordinal delivery +
 * usage records after the shape-gated reply. The gate carried over INTACT:
 * the evidence heal is shape-blind, the uncertain family is never
 * auto-resent, 429 retries on the same row through the same classifier.
 * The gate-ON scan WITHOUT the media seam is a LOUD misconfiguration
 * (zero writes) ONLY when an album is due — a text-only deployment keeps
 * working, and the text path's byte-level behavior is unchanged.
 *
 * The story-layer inputs (the same-game cooldown keys, the event-driven
 * bypass) are carried: no durable story-layer mapping exists yet, so the
 * context provider defaults them CONSERVATIVELY (no bypass, no cooldown
 * rule, relatedness derived from the durable story identity alone).
 */

import type { DbExecutor } from '../../adapters/db/db-executor';
import { AppError } from '../../shared/errors/app-error';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import {
  claimPublication,
  countDuePublications,
  listDuePublications,
  listFailedPublications,
  listPublicationMediaUsages,
  listPublicationMessages,
  listRecentPublishedHistory,
  markClaimedDeadLetter,
  markClaimedFailed,
  markClaimedPublished,
  markClaimedRetryWait,
  markClaimedSendStarted,
  markClaimedUncertain,
  markWaitingPublicationDeadLetter,
  parkExpiredPublishingUncertain,
  reclaimExpiredClaims,
  healFailedToPublished,
  healClaimedToPublished,
  recordPublicationMediaUsages,
  recordPublicationMessage,
  releaseClaimed,
  type PublicationRow,
} from '../../adapters/db/publication-outbox-store';
import { classifySendOutcome } from '../../domain/publishing/send-outcome';
import {
  planReleaseAfterScheduleDecision,
  planRetryAfterProvedFailure,
} from '../../domain/publishing/outbox-lifecycle';
import {
  classifyPriority,
  type PublicationPriorityClass,
} from '../../domain/publishing/priority-classes';
import { planPublicationTime } from '../../domain/publishing/publication-schedule';
import type { MixCategory } from '../../domain/publishing/anti-robot';
import {
  renderEditorialPostCaption,
  renderEditorialPostText,
} from '../../domain/admin-post/editorial-post-render';
import { contentTextHash } from '../../domain/publishing/publication-identity';
import { findSourceItemRawJson, findStoryReferenceItems } from '../../adapters/db/editorial-store';
import { extractImageUrlFromRawJson, imageUrlHost } from '../../domain/media/image-url';
import {
  createRichTextEnvelope,
  type RichTextEnvelope,
} from '../../domain/telegram/rich-text-envelope';
import {
  discriminateAlbumDocument,
  deriveAlbumSendPlan,
  evaluateAlbumDeliveryEvidence,
  type AlbumSendPlanV1,
} from '../../domain/media/album-send-plan';
import type { MediaAssetStore, MediaGroupSendInputV1 } from '../../domain/media/media-ports';
import { isPublishableRightsStatus } from '../../domain/media/media-usage';
import { POST_ALBUM_MAX_ITEMS } from '../../domain/media/post-album';
import { extractImagePromptInput } from '../../domain/ai/image-prompt';
import {
  AI_IMAGE_DISCLOSURE_LINE,
  AI_IMAGE_DISCLOSURE_SEPARATOR,
} from '../../domain/ai/image-policy';
import type { ImageGenerationServicePort } from '../../domain/ai/image-types';
import { mapContentTypeToMixCategory, scanJitterForCandidate } from './scheduler-policy';
import {
  pinChannelPost,
  readPostManagementSettings,
} from '../../adapters/db/post-management-store';
import { randomToken } from '../../domain/admin-post/fingerprint';

/** The channel transport seam (the ONLY artificial piece in tests). */
export interface PublicationChannelTransport {
  sendMessageRich(input: {
    readonly chatId: number | string;
    readonly content: {
      readonly kind: string;
      readonly text: string;
      readonly entities: readonly unknown[];
    };
  }): Promise<{ readonly messageId: number }>;
  /**
   * ADR-0068: the single-photo send (optional — a transport without it
   * keeps the old text-only behavior). The caption is a REQUIRED-kind
   * 'caption' envelope; the photo is a file_id or a bounded https URL.
   * The reply carries the photo's file_id when Telegram returns one.
   */
  sendPhotoRich?: (input: {
    readonly chatId: number | string;
    readonly photo: string;
    readonly caption?: {
      readonly kind: string;
      readonly text: string;
      readonly entities: readonly unknown[];
    };
  }) => Promise<{ readonly messageId: number; readonly photoFileId?: string }>;
  /**
   * ADR-0071: the editorial multi-photo album (optional — a transport
   * without it degrades a multi-photo post to the single-photo path with
   * the FIRST photo, never to a failure). One media group of 2..4 photos;
   * the caption rides the FIRST item only (the client's house invariant);
   * each item's media is a file_id or a bounded https URL, the same
   * reference shape `sendPhotoRich` takes. The reply carries one message
   * per item, IN ORDINAL ORDER, each with the returned file_id when
   * Telegram returns one.
   */
  sendMediaGroupRich?: (input: {
    readonly chatId: number | string;
    readonly items: readonly {
      readonly type: 'photo';
      readonly media: string;
      readonly caption?: {
        readonly kind: string;
        readonly text: string;
        readonly entities: readonly unknown[];
      };
    }[];
  }) => Promise<readonly PublicationSentMediaGroupMessage[]>;
  /**
   * ADR-0072: the generated-image send (optional — a transport without
   * it keeps the old behavior: a no-photo post goes out as text). The
   * photo is fresh BYTES uploaded as multipart; the caption is a
   * REQUIRED-kind 'caption' envelope. The reply carries the photo's
   * file_id when Telegram returns one.
   */
  sendPhotoBytesRich?: (input: {
    readonly chatId: number | string;
    readonly photo: { readonly bytes: Uint8Array; readonly contentType: string };
    readonly caption?: {
      readonly kind: string;
      readonly text: string;
      readonly entities: readonly unknown[];
    };
  }) => Promise<{ readonly messageId: number; readonly photoFileId?: string }>;
}

/** ONE message of a media-group reply, IN ORDINAL ORDER (the ADR-0060 seam). */
export interface PublicationSentMediaGroupMessage {
  readonly messageId: number;
  /** The returned file_id when the reply carries one; the ledger never requires it. */
  readonly fileId?: string;
}

/**
 * THE ALBUM WIRING SEAM (ADR-0060): the media-group send the album send
 * path consumes. The input IS the A5 `MediaGroupSendInputV1` contract
 * (items + the fresh-bytes attachments — which the send-time album always
 * leaves EMPTY, the file_id-only rule) extended with the re-derived send
 * identity key (the A4 scaffold consumed at the send boundary). Failures
 * THROW — the album path classifies them through the SAME sop1 classifier
 * as the text path (one honest outcome vocabulary).
 */
export interface PublicationMediaGroupSendInputV1 extends MediaGroupSendInputV1 {
  /** The versioned send identity re-derived from the durable document. */
  readonly sendIdentityKey: string;
}

export interface PublicationMediaGroupTransport {
  sendMediaGroup(
    input: PublicationMediaGroupSendInputV1,
  ): Promise<readonly PublicationSentMediaGroupMessage[]>;
}

export interface StoryLayerContext {
  /** Is the candidate related to the previous send? (durable default: same story). */
  readonly related: boolean;
  /** The explicit story-layer event-driven flag (carried: default false). */
  readonly eventDriven: boolean;
  /** The same-game cooldown context (carried: no durable game-key mapping yet). */
  readonly sameGame: {
    readonly gameKey: string | null;
    readonly lastPublishMs: number | null;
    readonly meaningfulUpdate: boolean;
  } | null;
}

export type PolicyContextResult =
  | { readonly ok: true; readonly context: StoryLayerContext }
  | { readonly ok: false; readonly reason: 'provider_failed' };

/**
 * The story-layer context seam. The SHIPPED default derives `related` from
 * the durable story identity (the candidate's story is the last published
 * story) and defaults the carried inputs conservatively; the carried real
 * provider (the story-layer game keys and event flags) replaces it when the
 * producing pipeline exists.
 */
export interface PublicationPolicyContextProvider {
  buildContext(input: {
    readonly storyId: string;
    readonly nowMs: number;
  }): Promise<PolicyContextResult>;
}

export function createStoriesPolicyContextProvider(
  executor: DbExecutor,
): PublicationPolicyContextProvider {
  return {
    async buildContext(input) {
      try {
        const lastPublished = await executor.first<{
          readonly story_id: string;
        }>({
          sql: `SELECT story_id FROM publications
                WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= ?
                ORDER BY published_at DESC LIMIT 1`,
          params: [input.nowMs],
        });
        return {
          ok: true,
          context: {
            related: lastPublished !== null && lastPublished.story_id === input.storyId,
            eventDriven: false,
            sameGame: null,
          },
        };
      } catch {
        return { ok: false, reason: 'provider_failed' };
      }
    },
  };
}

const RECONCILIATION_LIMIT = 25;
const DEFAULT_SCAN_LIMIT = 10;
const MAX_LAYOUT_HISTORY = 64;
const MAX_CATEGORY_HISTORY = 512;
const MIX_WINDOW_MS = 168 * 3_600_000;
const PUBLISH_LEASE_MS = 60_000;
/**
 * THE IN-FLIGHT SEND LEASE (the independent review d65d811 P1-1 fix): the
 * lease EXTENSION written durably at the send-started marker — far longer
 * than any honest Bot API send, so a healthy in-flight send is never
 * reclaimed mid-flight; a generation that dies inside the window parks in
 * the ambiguous family after the extension expires (bounded recovery),
 * never an auto-resend.
 */
const SEND_IN_FLIGHT_LEASE_MS = 600_000;
const MAX_DESTINATION_LENGTH = 256;

export interface ScanDetail {
  readonly publicationId: string;
  readonly draftId: string;
  readonly outcome:
    | 'sent'
    | 'healed_from_evidence'
    | 'failed_unconfirmed'
    | 'retry_scheduled'
    | 'failed_hold'
    | 'dead_lettered'
    | 'deferred_time'
    | 'deferred_policy'
    | 'decision_only'
    | 'not_claimable'
    | 'fence_rejected'
    | 'policy_input_invalid';
  readonly dueAtMs?: number;
  readonly code?: string;
  readonly priorityClass?: string;
}

export interface SchedulerScanReport {
  readonly scannedAtMs: number;
  readonly gateEnabled: boolean;
  readonly decisionOnly: boolean;
  /**
   * The LOUD misconfiguration family: 'transport_absent' = the send gate
   * enabled without the text transport; 'media_transport_absent' = the gate
   * enabled, the text transport present, but an ALBUM publication is due
   * while the media-group seam is absent. Both write NOTHING.
   */
  readonly misconfigured: false | 'transport_absent' | 'media_transport_absent';
  readonly dueCount: number;
  readonly processed: number;
  readonly reclaimed: number;
  /**
   * The ambiguous in-flight windows parked this scan (the send-started
   * generations whose extended lease expired without a terminal — the
   * `send_may_have_started` family; NEVER auto-resent, healed only by
   * recorded evidence or the human dispositions).
   */
  readonly uncertainParked: number;
  readonly uncertaintyHealed: number;
  readonly details: readonly ScanDetail[];
}

interface DraftRead {
  readonly id: string;
  readonly status: string;
  readonly layout: string;
  readonly document_json: string;
}

function storyLayerOf(
  row: PublicationRow,
  provider: PublicationPolicyContextProvider,
  nowMs: number,
) {
  return provider.buildContext({ storyId: row.story_id, nowMs });
}

export function createPublicationScheduler(deps: {
  readonly executor: DbExecutor;
  readonly destination: string;
  readonly transport?: PublicationChannelTransport;
  /**
   * The album send seam (ADR-0060). OPTIONAL so a text-only deployment
   * keeps working, but the pair rule below makes it impossible to hold a
   * send-capable media seam without the ledger it binds to.
   */
  readonly mediaTransport?: PublicationMediaGroupTransport;
  /**
   * The ledger the album binding is verified against — REQUIRED with
   * the media seam. ADR-0068: it ALSO serves the single-photo path
   * (URL-asset insert + file_id save), so it may exist WITHOUT the
   * media seam; the media seam still requires it (pair rule below).
   * ADR-0072: it ALSO serves the generated-image path (generated-asset
   * insert + file_id save).
   */
  readonly mediaAssets?: Pick<
    MediaAssetStore,
    'findAssetsByUrls' | 'insertUrlAsset' | 'insertGeneratedAsset' | 'markUploaded'
  >;
  /**
   * ADR-0072 — the image-generation service (OPTIONAL: without it, a
   * no-photo post goes out as text, exactly as before). The service
   * owns its own budget/breaker/books; the scheduler only consumes
   * its typed outcome and never calls a provider itself.
   */
  readonly imageGeneration?: ImageGenerationServicePort;
  /**
   * Slice 6 — the P0 auto-pin seam. OPTIONAL: without it, a sent P0 is
   * never pinned (the panel toggle alone cannot pin). When present, a
   * terminally-sent P0 publication pins its FIRST channel message
   * through this transport + the durable pin ledger, best-effort: a
   * pin failure is logged and the outcome stays `sent` — a pin never
   * fails a publication.
   */
  readonly autoPin?: {
    readonly pin: (input: {
      readonly chatId: number | string;
      readonly messageId: number;
    }) => Promise<boolean>;
  };
  readonly sendGate: { readonly enabled: boolean };
  readonly contextProvider: PublicationPolicyContextProvider;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly scanLimit?: number;
}) {
  const destination = deps.destination;
  if (
    typeof destination !== 'string' ||
    destination.length === 0 ||
    destination.length > MAX_DESTINATION_LENGTH
  ) {
    throw new AppError('config_invalid');
  }
  // THE PAIR RULE (fail-closed): a media-group seam without the ledger it
  // binds to is a construction-time misconfiguration — the wiring can
  // never half-exist. ADR-0068: the ledger MAY exist without the seam
  // (the single-photo path uses the ledger alone); the reverse is still
  // forbidden.
  if (deps.mediaTransport !== undefined && deps.mediaAssets === undefined) {
    throw new AppError('config_invalid');
  }
  const scanLimit = Math.max(1, Math.min(64, Math.floor(deps.scanLimit ?? DEFAULT_SCAN_LIMIT)));

  /**
   * Slice 6 — the P0 auto-pin AFTER a terminal `sent`: the panel toggle
   * is the authority (OFF ⇒ skip silently), the priority class must be
   * P0 (score >= 90), and the pin is best-effort — ANY failure is
   * logged and swallowed, never thrown into the send path (a pin never
   * fails a publication, and a healed/re-sent publication re-pins
   * idempotently through the ledger's already-pinned no-op).
   */
  async function maybeAutoPinP0(input: {
    readonly publicationId: string;
    readonly priority: number;
    readonly messageId: number;
    readonly nowMs: number;
  }): Promise<void> {
    if (deps.autoPin === undefined) {
      return;
    }
    try {
      const classified = classifyPriority(input.priority);
      if (!classified.ok || classified.value.class !== 'P0') {
        return;
      }
      const settings = await readPostManagementSettings(deps.executor);
      if (!settings.autoPinP0Enabled) {
        return;
      }
      const pinned = await deps.autoPin.pin({
        chatId: destination,
        messageId: input.messageId,
      });
      if (!pinned) {
        deps.logger.warn('publication.scheduler.auto_pin_failed');
        return;
      }
      await pinChannelPost(deps.executor, {
        id: `pin:${randomToken()}`,
        channelMessageId: input.messageId,
        postRefType: 'publication',
        postRefId: input.publicationId,
        pinnedBy: 0,
        nowMs: input.nowMs,
      });
    } catch (error) {
      deps.logger.warn('publication.scheduler.auto_pin_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /**
   * THE LEDGER BINDING + THE SEND-TIME RIGHTS GATE (the ADR-0060 binding,
   * extended by the independent review d65d811 P1-3 fix): every plan item
   * must resolve to an UPLOADED ledger asset whose telegram_file_id matches
   * the document AND whose DURABLE rights echo is an affirmative clearance
   * (PUBLICATION_MEDIA_RIGHTS_V1). The rights are re-read from the ledger
   * HERE — at the moment of use and publication: a `blocked` revocation or
   * a never-cleared `unknown` fails closed BEFORE any transport effect (a
   * source being "official" was never, by itself, a republish license —
   * the gate trusts the honest durable echo, never the source's name).
   */
  async function resolveAlbumLedgerBindings(plan: AlbumSendPlanV1): Promise<
    | {
        readonly ok: true;
        readonly bindings: readonly { readonly ordinal: number; readonly mediaAssetId: string }[];
      }
    | {
        readonly ok: false;
        readonly reason: 'ledger_binding_unresolved' | 'media_rights_not_publishable';
      }
  > {
    if (deps.mediaAssets === undefined) {
      // Unreachable on the gate-ON album path (the LOUD per-shape
      // misconfiguration check runs before any claim); typed for safety.
      return { ok: false, reason: 'ledger_binding_unresolved' };
    }
    const assets = await deps.mediaAssets.findAssetsByUrls(
      plan.items.map((item) => item.canonicalUrl),
    );
    const bindings: { readonly ordinal: number; readonly mediaAssetId: string }[] = [];
    for (const item of plan.items) {
      const match = assets.find(
        (asset) =>
          asset.canonicalUrl === item.canonicalUrl &&
          asset.telegramFileId === item.media &&
          asset.status === 'uploaded',
      );
      if (match === undefined) {
        return { ok: false, reason: 'ledger_binding_unresolved' };
      }
      if (!isPublishableRightsStatus(match.rightsStatus)) {
        return { ok: false, reason: 'media_rights_not_publishable' };
      }
      bindings.push({ ordinal: item.ordinal, mediaAssetId: match.id });
    }
    return { ok: true, bindings };
  }

  /**
   * The album binding dead-letter shared by the send and evidence paths —
   * a document the ledger cannot vouch for (or the rights gate refuses)
   * never reaches a transport.
   */
  async function deadLetterAlbumBinding(
    row: PublicationRow,
    generation: number,
    code: 'ledger_binding_unresolved' | 'media_rights_not_publishable',
    nowMs: number,
  ): Promise<ScanDetail> {
    const deadLetter = await markClaimedDeadLetter(deps.executor, {
      publicationId: row.id,
      generation,
      errorCode: code,
      nowMs,
    });
    return deadLetter.kind === 'written'
      ? { publicationId: row.id, draftId: row.draft_id, outcome: 'dead_lettered', code }
      : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
  }

  /** The bounded PK draft read (the shape discriminator's input). */
  async function readDraftOf(draftId: string): Promise<DraftRead | null> {
    return deps.executor.first<DraftRead>({
      sql: `SELECT id, status, layout, document_json FROM drafts WHERE id = ?`,
      params: [draftId],
    });
  }

  /**
   * THE ALBUM EVIDENCE VERDICT (the independent review d65d811 P1-2 fix,
   * DEEPENED by the independent review a279e13 finding 1): the
   * completeness proof is evaluated over the PLAN's ordinal count — a
   * partial witness parks uncertain and NEVER heals, NEVER re-sends — AND
   * the per-ordinal usage bindings must match the plan-resolved assets
   * EXACTLY: a swapped/foreign binding parks `album_usage_mismatch`, the
   * evidence stays intact, nothing is rewritten, nothing is re-sent. The
   * expected bindings come from the SAME ledger resolution the send path
   * uses — so the rights gate re-reads the durable echo HERE, at the
   * verification/heal moment, exactly as it does at the send moment.
   * Returns the action the caller must take.
   */
  async function evaluateAlbumEvidenceAction(
    row: PublicationRow,
    plan: AlbumSendPlanV1,
    messages: readonly { readonly ordinal: number; readonly chat_id: string }[],
    nowMs: number,
  ): Promise<
    | { readonly action: 'heal' }
    | { readonly action: 'park'; readonly code: string }
    | {
        readonly action: 'dead_letter';
        readonly code: 'ledger_binding_unresolved' | 'media_rights_not_publishable';
      }
  > {
    // THE PLAN-RESOLVED EXPECTATION (the a279e13 fix): the bindings the
    // ledger must show are derived from the plan + the ledger AT THIS
    // moment — unresolved provenance or a non-publishable rights echo
    // (blocked/unknown) dead-letters BEFORE any heal, the F3 gate at the
    // verification moment.
    const binding = await resolveAlbumLedgerBindings(plan);
    if (!binding.ok) {
      return { action: 'dead_letter', code: binding.reason };
    }
    const usages = await listPublicationMediaUsages(deps.executor, row.id);
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: plan.items.length,
      destination,
      messages: messages.map((message) => ({ ordinal: message.ordinal, chatId: message.chat_id })),
      boundUsageOrdinals: usages.map((usage) => usage.ordinal),
      boundUsages: usages.map((usage) => ({
        ordinal: usage.ordinal,
        mediaAssetId: usage.media_asset_id,
      })),
      expectedBindings: binding.bindings,
    });
    if (verdict.kind === 'complete') {
      return { action: 'heal' };
    }
    if (verdict.reason === 'usage_binding_mismatch') {
      // The durable usages CONTRADICT the plan (a swap, a foreign asset,
      // a malformed row): the recorded evidence may not match what the
      // channel actually received. Park for the human dispositions — the
      // records AND the wrong bindings stay EXACTLY as recorded (never
      // rewritten into a story), ZERO sends, never auto-resent.
      return { action: 'park', code: 'album_usage_mismatch' };
    }
    if (verdict.reason === 'unbound_usages') {
      // Every ordinal is PROVEN and every bound usage MATCHES the plan —
      // the missing piece is the durable usage binding itself. Reconcile
      // it from the resolved expectation (the honest rebinding); a
      // binding write failure parks uncertain.
      try {
        const written = await recordPublicationMediaUsages(deps.executor, {
          publicationId: row.id,
          usages: binding.bindings,
          nowMs,
        });
        if (written.kind !== 'recorded') {
          return { action: 'park', code: 'usage_record_rejected' };
        }
      } catch {
        return { action: 'park', code: 'usage_record_failed' };
      }
      return { action: 'heal' };
    }
    // A PARTIAL or foreign-destination proof: the ambiguous family — the
    // recorded ordinals may already be in the channel; a re-send would
    // duplicate them. Park for the human dispositions, records intact.
    return { action: 'park', code: 'album_evidence_incomplete' };
  }

  /**
   * ADR-0072 — the EDITORIAL-album evidence verdict: the same
   * completeness proof as the album-document path, but the expectation
   * is RE-DERIVED, not read from a durable document — the editorial
   * photos are re-resolved NOW (same deterministic resolution the send
   * path used: reference items ordered by id, ledger state re-read),
   * and the expected bindings are the resolved asset ids per ordinal.
   * A resolution that no longer yields an album of exactly the recorded
   * message count proves nothing: park, never heal on a changed
   * expectation. (A generated single photo heals through the text
   * branch — one message, one usage — exactly like a source photo.)
   */
  async function evaluateEditorialAlbumEvidenceAction(
    row: PublicationRow,
    messages: readonly { readonly ordinal: number; readonly chat_id: string }[],
    nowMs: number,
  ): Promise<{ readonly action: 'heal' } | { readonly action: 'park'; readonly code: string }> {
    const resolved = await resolveEditorialPhotoAssets({ row, nowMs });
    if (resolved.kind === 'none' || resolved.items.length !== messages.length) {
      return { action: 'park', code: 'album_evidence_incomplete' };
    }
    const usages = await listPublicationMediaUsages(deps.executor, row.id);
    const expectedBindings = resolved.items.map((item, ordinal) => ({
      ordinal,
      mediaAssetId: item.assetId,
    }));
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: resolved.items.length,
      destination,
      messages: messages.map((message) => ({
        ordinal: message.ordinal,
        chatId: message.chat_id,
      })),
      boundUsageOrdinals: usages.map((usage) => usage.ordinal),
      boundUsages: usages.map((usage) => ({
        ordinal: usage.ordinal,
        mediaAssetId: usage.media_asset_id,
      })),
      expectedBindings,
    });
    if (verdict.kind === 'complete') {
      return { action: 'heal' };
    }
    if (verdict.reason === 'usage_binding_mismatch') {
      return { action: 'park', code: 'album_usage_mismatch' };
    }
    if (verdict.reason === 'unbound_usages') {
      // Every ordinal is PROVEN and every bound usage MATCHES — the
      // missing piece is the durable usage binding itself. Reconcile
      // it from the resolved expectation; a binding write failure
      // parks uncertain.
      try {
        const written = await recordPublicationMediaUsages(deps.executor, {
          publicationId: row.id,
          usages: expectedBindings,
          nowMs,
        });
        if (written.kind !== 'recorded') {
          return { action: 'park', code: 'usage_record_rejected' };
        }
      } catch {
        return { action: 'park', code: 'usage_record_failed' };
      }
      return { action: 'heal' };
    }
    return { action: 'park', code: 'album_evidence_incomplete' };
  }

  async function reconcileFailedWithEvidence(nowMs: number): Promise<number> {
    const parked = await listFailedPublications(deps.executor, {
      limit: RECONCILIATION_LIMIT,
    });
    let healed = 0;
    for (const row of parked) {
      const messages = await listPublicationMessages(deps.executor, row.id);
      if (messages.length === 0) {
        continue;
      }
      // THE SHAPE-AWARE HEAL (the d65d811 P1-2 fix): the proof must match
      // the content shape — a text publication proves with its ONE record
      // to THIS destination; an album proves only with EVERY ordinal to
      // THIS destination AND the usages bound (the unbound-usages family
      // reconciles its binding here, then heals). Anything else stays
      // parked for the human dispositions (never auto-resent).
      const draft = await readDraftOf(row.draft_id);
      if (!draft) {
        continue;
      }
      if (discriminateAlbumDocument(draft.document_json) === 'album') {
        const planned = await deriveAlbumSendPlan({
          documentJson: draft.document_json,
          destination,
        });
        if (!planned.ok) {
          continue;
        }
        const action = await evaluateAlbumEvidenceAction(row, planned.plan, messages, nowMs);
        if (action.action !== 'heal') {
          continue;
        }
      } else if (messages.length > 1) {
        // ADR-0072: a text document with several recorded messages may
        // be a completed editorial album — heal only on the full
        // ordinal+usage proof, never on a partial witness.
        const action = await evaluateEditorialAlbumEvidenceAction(row, messages, nowMs);
        if (action.action !== 'heal') {
          continue;
        }
      } else if (messages.length !== 1 || messages[0]!.chat_id !== destination) {
        // ADR-0071: a multi-record ledger may be an editorial album's
        // proof — heal it only on the exact ordinal set + bound usages.
        const albumAction = await evaluateEditorialAlbumEvidence({ row, messages, nowMs });
        if (albumAction.action !== 'heal') {
          continue;
        }
      }
      const outcome = await healFailedToPublished(deps.executor, {
        publicationId: row.id,
        nowMs,
      });
      if (outcome.kind === 'healed') {
        healed += 1;
        deps.logger.info('publication_scheduler.evidence_healed', { publicationId: row.id });
      }
    }
    return healed;
  }

  /**
   * ADR-0076 — the due scan's mix-category pool, computed ONCE per
   * scan from the loaded due rows (one bounded DISTINCT query over
   * their story ids): the category cap can only shape a mix when the
   * pool holds another category. A failure throws — the scan fails
   * closed with zero sends, like an unreadable published history.
   */
  async function duePoolCategories(
    rows: readonly PublicationRow[],
  ): Promise<ReadonlySet<MixCategory>> {
    const storyIds = [...new Set(rows.map((row) => row.story_id))];
    if (storyIds.length === 0) return new Set<MixCategory>();
    const placeholders = storyIds.map(() => '?').join(',');
    const found = await deps.executor.query<{ content_type: string }>({
      sql: `SELECT DISTINCT content_type FROM stories WHERE id IN (${placeholders})`,
      params: storyIds,
    });
    const pool = new Set<MixCategory>();
    for (const entry of found.rows) {
      const mapped = mapContentTypeToMixCategory(entry.content_type);
      if (mapped.ok) pool.add(mapped.category);
    }
    return pool;
  }

  async function buildPolicyDecision(
    row: PublicationRow,
    draft: DraftRead,
    nowMs: number,
    poolCategories: ReadonlySet<MixCategory>,
  ): Promise<
    | {
        readonly ok: true;
        readonly decision: ReturnType<typeof planPublicationTime>;
        readonly priorityClass: string;
      }
    | { readonly ok: false; readonly code: string }
  > {
    const contentRow = await deps.executor.first<{ readonly content_type: string }>({
      sql: `SELECT content_type FROM stories WHERE id = ?`,
      params: [row.story_id],
    });
    if (!contentRow || typeof contentRow.content_type !== 'string') {
      return { ok: false, code: 'policy_input_invalid' };
    }
    const mapped = mapContentTypeToMixCategory(contentRow.content_type);
    if (!mapped.ok) {
      return { ok: false, code: 'unknown_content_type' };
    }
    const layer = await storyLayerOf(row, deps.contextProvider, nowMs);
    if (!layer.ok) {
      return { ok: false, code: 'policy_provider_failed' };
    }
    const history = await listRecentPublishedHistory(deps.executor, {
      nowMs,
      limit: MAX_CATEGORY_HISTORY,
    });
    const trail = history.slice(-MAX_LAYOUT_HISTORY);
    const recentLayouts = trail.map((entry) => entry.layout);
    const recentCategories: { readonly category: MixCategory; readonly atMs: number }[] = [];
    for (const entry of history) {
      if (entry.publishedAtMs < nowMs - MIX_WINDOW_MS) {
        continue;
      }
      const entryMapped = mapContentTypeToMixCategory(entry.contentType);
      if (entryMapped.ok) {
        recentCategories.push({ category: entryMapped.category, atMs: entry.publishedAtMs });
      }
      // A history row of an unknown future content type is skipped: the
      // trail stays usable; the candidate's own unknown type fails loud.
    }
    const lastEntry = trail.length > 0 ? trail[trail.length - 1] : undefined;
    let previousSend: {
      readonly atMs: number;
      readonly related: boolean;
      readonly priorityClass: PublicationPriorityClass;
    } | null = null;
    if (lastEntry) {
      const classified = classifyPriority(lastEntry.priority);
      if (classified.ok) {
        previousSend = {
          atMs: lastEntry.publishedAtMs,
          related: layer.context.related,
          priorityClass: classified.value.class,
        };
      }
    }
    const jitter = scanJitterForCandidate({
      candidateId: row.id,
      priorityScore: row.priority,
      hasPreviousSend: previousSend !== null,
      related: layer.context.related,
    });
    if (!jitter.ok) {
      return { ok: false, code: 'invalid_score' };
    }
    const decision = planPublicationTime({
      schemaVersion: 1,
      nowMs,
      category: mapped.category,
      candidateLayout: draft.layout,
      priorityScore: row.priority,
      jitterMs: jitter.jitterMs,
      // Slice 9: the P1 latency runs from the publication's enqueue
      // instant (row.created_at), a FIXED past event — never from the
      // scan instant, which would re-apply the latency on every scan and
      // make a P1 row undeferrable-forever (each scan deferred it to
      // now + jitter again while the stored scheduled_at went unread).
      latencyAnchorMs: row.created_at,
      previousSend,
      recentLayouts,
      recentCategories,
      sameGame: layer.context.sameGame,
      eventDriven: layer.context.eventDriven,
      // ADR-0076 — the pool holds an alternative for this row iff it
      // contains a mix category OTHER than the row's own.
      alternativeCategoryAvailable: [...poolCategories].some(
        (poolCategory) => poolCategory !== mapped.category,
      ),
    });
    return { ok: true, decision, priorityClass: jitter.priorityClass };
  }

  /**
   * ADR-0068 + ADR-0071 — the editorial photo resolution (the photos are
   * resolved BEFORE the send-started marker, so every failure here
   * degrades to the text send with the row still claimable):
   *   draft → story → up to EDITORIAL_ALBUM_MAX_PHOTOS reference source
   *   items → each stored `raw_json.imageUrl` (distinct URLs, source
   *   order) → per URL the `media_assets` row by canonical URL (an
   *   uploaded row reuses its file_id; a validated row sends by URL; no
   *   row → one URL asset is inserted, validated /
   *   attribution_required) → the send-time rights gate → the caption
   *   from `renderEditorialPostCaption` (ADR-0071: the SAME v3 form as
   *   the text render, deterministically TRIMMED to the 1024-unit
   *   caption cap — an over-long caption NO LONGER degrades to text;
   *   the photo is kept and the trim is logged).
   * One usable photo → the single-photo plan (ADR-0068, unchanged).
   * Two or more → ONE media-group album (the caption rides the FIRST
   * photo only) — unless the transport has no media-group seam, in
   * which case the album degrades to the single-photo plan with the
   * FIRST photo (logged, never a failure). A URL that fails its own
   * resolution (rights, ledger) is SKIPPED fail-soft — it never kills
   * the usable photos; only when NO URL resolves does the plan degrade
   * to text, with the FIRST failure's reason. ADR-0072 extends it: a
   * `none` plan with reason `photo_no_image` / `photo_no_source_item`
   * (no source photo exists at all) lets the caller try the
   * generated-image path — a refused/unusable real photo is never
   * replaced by a generated one. A missing seam, a missing image, an
   * unusable ledger row, or a refused rights echo all degrade to text
   * — never a dead-letter, never a throw: the photos are an
   * enhancement, the post is the requirement.
   */
  /** The owner-ordered editorial album bound (2026-11-22): at most 4 source photos in one media group. */
  const EDITORIAL_ALBUM_MAX_PHOTOS = 4;

  type EditorialPhotoItem = {
    /** The Telegram reference: a file_id or a bounded https URL. */
    readonly photo: string;
    readonly assetId: string;
    /** True when the send rides the URL (a file_id is saved after). */
    readonly sentByUrl: boolean;
  };

  type EditorialPhotoPlan =
    | { readonly kind: 'none'; readonly reason: string }
    | {
        readonly kind: 'photo';
        readonly photo: string;
        readonly caption: RichTextEnvelope;
        readonly assetId: string;
        /** True when the send rides the URL (a file_id is saved after). */
        readonly sentByUrl: boolean;
      }
    | {
        readonly kind: 'album';
        readonly items: readonly EditorialPhotoItem[];
        readonly caption: RichTextEnvelope;
      }
    | {
        readonly kind: 'generated';
        readonly bytes: Uint8Array;
        readonly contentType: string;
        readonly caption: RichTextEnvelope;
        readonly assetId: string;
        /**
         * Always true: the send rides fresh bytes, never a file_id —
         * so the returned file_id is saved after (same transition as
         * a URL send).
         */
        readonly sentByUrl: true;
      };

  /**
   * Resolve ONE source image URL to a sendable ledger asset (the
   * ADR-0068 per-URL logic, factored out for the multi-photo path):
   * uploaded-with-file_id wins, validated rides by URL, no row inserts
   * one URL asset. Returns the asset or the typed refusal reason.
   */
  async function resolveOneEditorialPhotoAsset(input: {
    readonly imageUrl: string;
    readonly sourceItemId: string;
    readonly nowMs: number;
  }): Promise<
    | { readonly ok: true; readonly item: EditorialPhotoItem }
    | { readonly ok: false; readonly reason: string }
  > {
    const assets = await deps.mediaAssets!.findAssetsByUrls([input.imageUrl]);
    const candidates = assets.filter((asset) => asset.canonicalUrl === input.imageUrl);
    const usable = candidates.filter(
      (asset) =>
        isPublishableRightsStatus(asset.rightsStatus) &&
        ((asset.status === 'uploaded' && asset.telegramFileId !== undefined) ||
          asset.status === 'validated'),
    );
    let asset =
      usable.find((candidate) => candidate.status === 'uploaded') ??
      usable.find((candidate) => candidate.status === 'validated');
    if (asset === undefined) {
      if (candidates.some((candidate) => !isPublishableRightsStatus(candidate.rightsStatus))) {
        return { ok: false, reason: 'photo_rights_not_publishable' };
      }
      if (candidates.length > 0) {
        // A ledger row owns this URL in another lifecycle (e.g. an
        // R2-staged candidate) — the photo path never forks it.
        return { ok: false, reason: 'photo_ledger_row_unusable' };
      }
      const created = await deps.mediaAssets!.insertUrlAsset({
        id: `mda:${randomToken()}`,
        type: 'photo',
        canonicalUrl: input.imageUrl,
        sourceItemId: input.sourceItemId,
        rightsStatus: 'attribution_required',
        attribution: imageUrlHost(input.imageUrl) ?? undefined,
        createdAt: input.nowMs,
        updatedAt: input.nowMs,
      });
      if (!created.ok) {
        return { ok: false, reason: 'photo_ledger_write_failed' };
      }
      const reRead = await deps.mediaAssets!.findAssetsByUrls([input.imageUrl]);
      asset = reRead.find(
        (candidate) =>
          candidate.canonicalUrl === input.imageUrl &&
          isPublishableRightsStatus(candidate.rightsStatus) &&
          candidate.status === 'validated',
      );
      if (asset === undefined) {
        return { ok: false, reason: 'photo_ledger_write_failed' };
      }
    }
    const sentByUrl = asset.telegramFileId === undefined;
    return {
      ok: true,
      item: {
        photo: asset.telegramFileId ?? input.imageUrl,
        assetId: asset.id,
        sentByUrl,
      },
    };
  }

  /**
   * Resolve the story's source photos (no caption — the evidence path
   * reuses this): up to POST_ALBUM_MAX_ITEMS items, in reference-item
   * order. A refused/unusable item is SKIPPED with a debug log (the
   * rest of the album still sends); the `none` reason names the
   * first failure class seen when nothing usable remains.
   */
  async function resolveEditorialPhotoAssets(input: {
    readonly row: PublicationRow;
    readonly nowMs: number;
  }): Promise<
    | { readonly kind: 'items'; readonly items: readonly EditorialPhotoItem[] }
    | { readonly kind: 'none'; readonly reason: string }
  > {
    // The resolution needs the LEDGER only — which transport seam the
    // plan rides (single photo / album / generated) is the caller's
    // decision; a missing seam degrades there, never here.
    if (deps.mediaAssets === undefined) {
      return { kind: 'none', reason: 'photo_seam_absent' };
    }
    try {
      const sourceItems = await findStoryReferenceItems(
        deps.executor,
        input.row.story_id,
        POST_ALBUM_MAX_ITEMS,
      );
      if (sourceItems.length === 0) {
        return { kind: 'none', reason: 'photo_no_source_item' };
      }
      const items: EditorialPhotoItem[] = [];
      let firstReason: string | null = null;
      let sawImageUrl = false;
      // Distinct image URLs in source order (the same image on two
      // items, or twice on one item, is ONE photo — the ADR-0071
      // invariant, preserved from the inline resolver).
      const seenUrls = new Set<string>();
      for (const sourceItem of sourceItems) {
        const rawJson = await findSourceItemRawJson(deps.executor, sourceItem.id);
        const imageUrl = rawJson === null ? null : extractImageUrlFromRawJson(rawJson);
        if (imageUrl === null || seenUrls.has(imageUrl)) {
          continue;
        }
        seenUrls.add(imageUrl);
        sawImageUrl = true;
        const resolved = await resolveOneEditorialPhotoAsset({
          imageUrl,
          sourceItemId: sourceItem.id,
          nowMs: input.nowMs,
        });
        if (!resolved.ok) {
          if (firstReason === null) {
            firstReason = resolved.reason;
          }
          deps.logger.debug('publication.scheduler.photo_item_skipped', {
            reason: resolved.reason,
          });
          continue;
        }
        items.push(resolved.item);
      }
      if (items.length > 0) {
        return { kind: 'items', items };
      }
      if (!sawImageUrl) {
        return { kind: 'none', reason: 'photo_no_image' };
      }
      return { kind: 'none', reason: firstReason ?? 'photo_ledger_row_unusable' };
    } catch {
      // A D1 failure degrades to text — the publication must never
      // fail because its photo lookup did.
      return { kind: 'none', reason: 'photo_resolution_failed' };
    }
  }
  async function resolveEditorialPhoto(input: {
    readonly row: PublicationRow;
    readonly documentJson: string;
    readonly nowMs: number;
  }): Promise<EditorialPhotoPlan> {
    const resolved = await resolveEditorialPhotoAssets(input);
    if (resolved.kind === 'none') {
      return resolved;
    }
    try {
      // ADR-0071: the caption is the SAME v3 form, trimmed to the
      // 1024-unit cap by the caption render — an over-long caption keeps
      // the photo (trimmed, logged) instead of degrading to text. The
      // failure here is near-unreachable (the text render already
      // proved the same document) but stays a typed text fallback.
      const captionRender = renderEditorialPostCaption(input.documentJson);
      if (!captionRender.ok) {
        return { kind: 'none', reason: 'photo_caption_invalid' };
      }
      if (captionRender.trimmed) {
        deps.logger.debug('publication.scheduler.caption_trimmed', {
          reason: 'caption_over_1024_units',
        });
      }
      // The resolver already collected the usable items (distinct URLs,
      // source order, at most POST_ALBUM_MAX_ITEMS); the plan is the
      // same photo/album shape the inline resolver built.
      const items = resolved.items;
      if (items.length === 1) {
        const item = items[0]!;
        return {
          kind: 'photo',
          photo: item.photo,
          caption: captionRender.envelope,
          assetId: item.assetId,
          sentByUrl: item.sentByUrl,
        };
      }
      if (deps.transport?.sendMediaGroupRich === undefined) {
        // No media-group seam: the album degrades to the single-photo
        // plan with the FIRST photo — the post still carries a photo.
        deps.logger.debug('publication.scheduler.photo_album_degraded', {
          reason: 'media_group_seam_absent',
        });
        const item = items[0]!;
        return {
          kind: 'photo',
          photo: item.photo,
          caption: captionRender.envelope,
          assetId: item.assetId,
          sentByUrl: item.sentByUrl,
        };
      }
      return { kind: 'album', items, caption: captionRender.envelope };
    } catch {
      // A D1 failure degrades to text — the publication must never
      // fail because its photo lookup did.
      return { kind: 'none', reason: 'photo_resolution_failed' };
    }
  }

  /**
   * The READ-ONLY editorial album re-derivation (the evidence path):
   * the same URL collection + the same usable-asset predicate as the
   * send path, but WITHOUT inserting URL assets — a heal-time write
   * would invent provenance. An unresolvable URL (a missing ledger row,
   * a non-publishable rights echo) makes the proof underivable, never
   * a guess: the caller parks.
   */
  async function resolveEditorialAlbumBindings(input: {
    readonly row: PublicationRow;
  }): Promise<
    | { readonly ok: true; readonly items: readonly EditorialPhotoItem[] }
    | { readonly ok: false; readonly reason: string }
  > {
    if (deps.mediaAssets === undefined) {
      return { ok: false, reason: 'photo_seam_absent' };
    }
    const sourceItems = await findStoryReferenceItems(
      deps.executor,
      input.row.story_id,
      EDITORIAL_ALBUM_MAX_PHOTOS,
    );
    const imageUrls: string[] = [];
    const seenUrls = new Set<string>();
    for (const sourceItem of sourceItems) {
      const rawJson = await findSourceItemRawJson(deps.executor, sourceItem.id);
      const imageUrl = rawJson === null ? null : extractImageUrlFromRawJson(rawJson);
      if (imageUrl === null || seenUrls.has(imageUrl)) {
        continue;
      }
      seenUrls.add(imageUrl);
      imageUrls.push(imageUrl);
    }
    if (imageUrls.length === 0) {
      return { ok: false, reason: 'photo_no_image' };
    }
    const assets = await deps.mediaAssets.findAssetsByUrls(imageUrls);
    const items: EditorialPhotoItem[] = [];
    for (const imageUrl of imageUrls) {
      const candidates = assets.filter((asset) => asset.canonicalUrl === imageUrl);
      const usable = candidates.filter(
        (asset) =>
          isPublishableRightsStatus(asset.rightsStatus) &&
          ((asset.status === 'uploaded' && asset.telegramFileId !== undefined) ||
            asset.status === 'validated'),
      );
      const asset =
        usable.find((candidate) => candidate.status === 'uploaded') ??
        usable.find((candidate) => candidate.status === 'validated');
      if (asset === undefined) {
        // A URL the send path resolved no longer resolves (a ledger row
        // vanished, a rights echo changed): the proof is underivable.
        return { ok: false, reason: 'album_evidence_underivable' };
      }
      items.push({
        photo: asset.telegramFileId ?? imageUrl,
        assetId: asset.id,
        sentByUrl: asset.telegramFileId === undefined,
      });
    }
    return { ok: true, items };
  }

  /**
   * THE EDITORIAL ALBUM EVIDENCE VERDICT (ADR-0071 — the d65d811 P1-2
   * shape-aware proof, applied to the editorial album): a media-group
   * send is ONE Telegram acceptance, so the proof is the EXACT ordinal
   * set {0..N-1} over the re-derived album size N, all to THIS
   * destination, AND the per-ordinal usage bindings matching the
   * re-derived assets EXACTLY. A partial witness parks uncertain (the
   * recorded ordinals may already be in the channel — a re-send would
   * duplicate them); a swapped/foreign binding parks `album_usage_
   * mismatch`; the unbound-usages family reconciles its binding here,
   * then heals. A ledger that is NOT an album's proof at all (a single
   * ordinal-0 record, a foreign record) is `not_album` — the caller's
   * existing single-record / anomalous-shape handling decides.
   * The re-derivation is deterministic (source order + ledger rows),
   * so a drift between the send-time album and now (a late-arriving
   * source item, a revoked rights echo) parks conservatively for the
   * human dispositions — never a heal on a guess.
   */
  async function evaluateEditorialAlbumEvidence(input: {
    readonly row: PublicationRow;
    readonly messages: readonly { readonly ordinal: number; readonly chat_id: string }[];
    readonly nowMs: number;
  }): Promise<
    | { readonly action: 'heal' }
    | { readonly action: 'park'; readonly code: string }
    | { readonly action: 'not_album' }
  > {
    const looksAlbum =
      input.messages.length > 1 || input.messages.some((message) => message.ordinal > 0);
    if (!looksAlbum) {
      return { action: 'not_album' };
    }
    const bindings = await resolveEditorialAlbumBindings({ row: input.row });
    if (!bindings.ok || bindings.items.length < 2) {
      // The story no longer resolves to an album — the recorded set
      // cannot be the album this proof needs.
      return { action: 'park', code: 'album_evidence_incomplete' };
    }
    const expectedBindings = bindings.items.map((item, ordinal) => ({
      ordinal,
      mediaAssetId: item.assetId,
    }));
    const usages = await listPublicationMediaUsages(deps.executor, input.row.id);
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: bindings.items.length,
      destination,
      messages: input.messages.map((message) => ({
        ordinal: message.ordinal,
        chatId: message.chat_id,
      })),
      boundUsageOrdinals: usages.map((usage) => usage.ordinal),
      boundUsages: usages.map((usage) => ({
        ordinal: usage.ordinal,
        mediaAssetId: usage.media_asset_id,
      })),
      expectedBindings,
    });
    if (verdict.kind === 'complete') {
      return { action: 'heal' };
    }
    if (verdict.reason === 'usage_binding_mismatch') {
      // The durable usages CONTRADICT the re-derived album (a swap, a
      // foreign asset): the recorded evidence may not match what the
      // channel actually received. Park for the human dispositions —
      // the records AND the wrong bindings stay EXACTLY as recorded
      // (never rewritten), ZERO sends, never auto-resent.
      return { action: 'park', code: 'album_usage_mismatch' };
    }
    if (verdict.reason === 'unbound_usages') {
      // Every ordinal is PROVEN and every bound usage MATCHES the
      // re-derived album — the missing piece is the durable usage
      // binding itself. Reconcile it from the resolved expectation
      // (the honest rebinding); a binding write failure parks
      // uncertain.
      try {
        const written = await recordPublicationMediaUsages(deps.executor, {
          publicationId: input.row.id,
          usages: expectedBindings,
          nowMs: input.nowMs,
        });
        if (written.kind !== 'recorded') {
          return { action: 'park', code: 'usage_record_rejected' };
        }
      } catch {
        return { action: 'park', code: 'usage_record_failed' };
      }
      return { action: 'heal' };
    }
    return { action: 'park', code: 'album_evidence_incomplete' };
  }

  /**
   * THE EDITORIAL ALBUM SEND (ADR-0071): one media group of 2..4 photos,
   * the v3 caption on the FIRST photo only, mirroring the durable-album
   * path's (ADR-0060) discipline:
   *  - the response shape gate runs BEFORE any ledger write (the A2
   *    lesson): one message per item, in ordinal order, each id usable;
   *  - the delivery records land per ordinal with the FULL-text hash on
   *    ordinal 0 ONLY (ADR-0071: the ledger hash stays the full-text
   *    hash — the correction engine re-renders the stored document and
   *    compares against it); a rejected record parks the row uncertain
   *    — never a claimed published, never a re-send;
   *  - a URL send's returned file_id is saved best-effort (a ledger
   *    failure here never un-sends the post);
   *  - the usage binding lands AFTER the delivery proof and BEFORE the
   *    terminal: a failure parks uncertain and the NEXT scan's evidence
   *    check heals from the recorded messages (the binding can never
   *    orphan a proof);
   *  - transport failures classify through the SAME sop1 classifier as
   *    the text path (429 retryable with the 60s floor, 4xx hold, the
   *    rest uncertain and never auto-resent).
   * The media-group call is ONE Telegram acceptance — the evidence check
   * heals from the exact ordinal set (see evaluateEditorialAlbumEvidence).
   */
  async function sendEditorialAlbum(input: {
    readonly row: PublicationRow;
    readonly generation: number;
    readonly album: Extract<EditorialPhotoPlan, { readonly kind: 'album' }>;
    readonly textHash: string;
    readonly nowMs: number;
  }): Promise<ScanDetail> {
    const { row, generation, album, textHash, nowMs } = input;
    if (deps.transport?.sendMediaGroupRich === undefined) {
      // Unreachable: the resolver only plans an album when the seam
      // exists. The typed guard keeps the send honest under any cast.
      throw new AppError('config_invalid');
    }
    let sentMessages: readonly PublicationSentMediaGroupMessage[];
    try {
      sentMessages = await deps.transport.sendMediaGroupRich({
        chatId: destination,
        items: album.items.map((item, ordinal) => ({
          type: 'photo' as const,
          media: item.photo,
          ...(ordinal === 0 ? { caption: album.caption } : {}),
        })),
      });
    } catch (error) {
      const outcome = classifySendOutcome(error);
      if (outcome.kind === 'uncertain') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: outcome.code,
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: outcome.code,
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      if (outcome.retryable) {
        const retryPlan = planRetryAfterProvedFailure({
          attempts: generation,
          maxAttempts: row.max_attempts,
          retryAfterMs: outcome.retryAfterMs,
          nowMs,
        });
        if (retryPlan.ok && retryPlan.action === 'retry_wait') {
          const marked = await markClaimedRetryWait(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: outcome.code,
            runAfterMs: retryPlan.runAfterMs,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'retry_scheduled',
                code: outcome.code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'attempt_budget_spent',
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'dead_lettered',
              code: 'attempt_budget_spent',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const marked = await markClaimedFailed(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: outcome.code,
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_hold',
            code: outcome.code,
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // THE RESPONSE SHAPE GATE — before ANY ledger write (the A2 lesson).
    const shapeValid =
      Array.isArray(sentMessages) &&
      sentMessages.length === album.items.length &&
      sentMessages.every(
        (message) => Number.isInteger(message?.messageId) && message.messageId > 0,
      );
    if (!shapeValid) {
      const marked = await markClaimedUncertain(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: 'response_media_group_shape_invalid',
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_unconfirmed',
            code: 'response_media_group_shape_invalid',
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // THE PER-ORDINAL DELIVERY RECORDS — the at-most-once ledger.
    for (let ordinal = 0; ordinal < sentMessages.length; ordinal += 1) {
      const message = sentMessages[ordinal]!;
      const recorded = await recordPublicationMessage(deps.executor, {
        publicationId: row.id,
        chatId: destination,
        messageId: message.messageId,
        textHash: ordinal === 0 ? textHash : null,
        nowMs,
        ordinal,
      });
      if (recorded.kind === 'duplicate_message') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'delivery_record_rejected',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'delivery_record_rejected',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
    }
    // A URL send's returned file_id is saved for reuse (best-effort: a
    // ledger failure here never un-sends the post).
    try {
      if (deps.mediaAssets !== undefined) {
        for (let ordinal = 0; ordinal < sentMessages.length; ordinal += 1) {
          const item = album.items[ordinal]!;
          const message = sentMessages[ordinal]!;
          if (item.sentByUrl && message.fileId !== undefined) {
            await deps.mediaAssets.markUploaded(item.assetId, message.fileId, nowMs);
          }
        }
      }
    } catch {
      deps.logger.warn('publication.scheduler.photo_ledger_save_failed');
    }
    // THE USAGE BINDING — after the delivery proof, before the terminal;
    // a failure parks the row uncertain and the NEXT scan's evidence
    // check heals from the recorded messages.
    try {
      const usages = await recordPublicationMediaUsages(deps.executor, {
        publicationId: row.id,
        usages: album.items.map((item, ordinal) => ({
          ordinal,
          mediaAssetId: item.assetId,
        })),
        nowMs,
      });
      if (usages.kind === 'duplicate_usage') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'usage_record_rejected',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'usage_record_rejected',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
    } catch {
      const marked = await markClaimedUncertain(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: 'usage_record_failed',
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_unconfirmed',
            code: 'usage_record_failed',
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // THE TERMINAL — fenced by the claim's attempts generation.
    const terminal = await markClaimedPublished(deps.executor, {
      publicationId: row.id,
      generation,
      nowMs,
    });
    if (terminal.kind === 'written') {
      // Slice 6 — a terminally-sent P0 album pins its FIRST message
      // (toggle-gated, best-effort: never fails the publication).
      const firstMessage = sentMessages[0];
      if (firstMessage !== undefined) {
        await maybeAutoPinP0({
          publicationId: row.id,
          priority: row.priority,
          messageId: firstMessage.messageId,
          nowMs,
        });
      }
    }
    return terminal.kind === 'written'
      ? { publicationId: row.id, draftId: row.draft_id, outcome: 'sent' }
      : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
  }

  /**
   * ADR-0072 — the generated-image resolution, tried ONLY when the
   * editorial photo resolution found no source photo at all
   * (`photo_no_image` / `photo_no_source_item`):
   *   draft document → headline + category emoji → image service
   *   (own budget/breaker/books) → generated bytes → ONE generated
   *   ledger row (validated / official / ai_* provenance) → the
   *   rendered text + the AI disclosure line as a `caption` envelope.
   * The disclosure is NEVER dropped: if render text + disclosure does
   * not fit the 1024-unit caption envelope, the plan is `none` and the
   * post goes out as text. Every failure degrades to text — never a
   * dead-letter, never a throw.
   */
  async function resolveGeneratedImage(input: {
    readonly draft: DraftRead;
    readonly render: { readonly envelope: RichTextEnvelope; readonly text: string };
    readonly nowMs: number;
  }): Promise<EditorialPhotoPlan> {
    if (
      deps.imageGeneration === undefined ||
      deps.transport?.sendPhotoBytesRich === undefined ||
      deps.mediaAssets === undefined
    ) {
      return { kind: 'none', reason: 'image_seam_absent' };
    }
    // The disclosure rides the caption: appending plain text AFTER the
    // rendered text never shifts the existing entity offsets. The
    // envelope is validated FIRST — a post whose text + disclosure
    // cannot fit the 1024-unit caption cap must never spend image
    // budget on a generation it cannot carry.
    const captionText =
      input.render.text + AI_IMAGE_DISCLOSURE_SEPARATOR + AI_IMAGE_DISCLOSURE_LINE;
    const caption = createRichTextEnvelope({
      kind: 'caption',
      text: captionText,
      entities: input.render.envelope.entities,
    });
    if (!caption.ok) {
      return { kind: 'none', reason: 'image_caption_invalid' };
    }
    const promptInput = extractImagePromptInput(input.draft.document_json);
    if (promptInput === null) {
      return { kind: 'none', reason: 'image_prompt_invalid' };
    }
    const outcome = await deps.imageGeneration.generateImage(promptInput);
    if (outcome.kind !== 'generated') {
      deps.logger.debug('publication.scheduler.image_fallback', { reason: outcome.reason });
      return { kind: 'none', reason: `image_${outcome.reason}` };
    }
    const image = outcome.image;
    const assetId = `mda:${randomToken()}`;
    const inserted = await deps.mediaAssets.insertGeneratedAsset({
      id: assetId,
      sha256Hex: image.sha256Hex,
      mimeType: image.contentType,
      byteLength: image.bytes.byteLength,
      aiProvider: 'workers-ai',
      aiModel: image.modelId,
      aiPrompt: image.prompt,
      aiSeed: image.seed,
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
    });
    if (!inserted.ok) {
      return { kind: 'none', reason: 'image_ledger_write_failed' };
    }
    return {
      kind: 'generated',
      bytes: image.bytes,
      contentType: image.contentType,
      caption: caption.envelope,
      assetId,
      sentByUrl: true,
    };
  }

  async function sendClaimed(
    row: PublicationRow,
    generation: number,
    draft: DraftRead,
    nowMs: number,
  ): Promise<ScanDetail> {
    if (deps.transport === undefined) {
      // Unreachable: the gate-ON path validated the transport before any
      // claim. The typed guard keeps the send honest under any cast.
      throw new AppError('config_invalid');
    }
    // The pre-send evidence check: a recorded delivery from a crashed
    // earlier generation heals WITHOUT a second send (the ADR-0032 gate).
    // THE SHAPE-AWARE PROOF (the d65d811 P1-2 fix): the heal asserts the
    // COMPLETE delivery — a text publication proves with its ONE record to
    // THIS destination; an album proves only with EVERY ordinal recorded
    // here AND the usages bound. A partial album witness parks uncertain
    // (the recorded ordinals may already be in the channel — a re-send
    // would duplicate them); it is NEVER healed on a non-empty ledger and
    // NEVER auto-resent.
    const messages = await listPublicationMessages(deps.executor, row.id);
    if (messages.length > 0) {
      if (discriminateAlbumDocument(draft.document_json) === 'album') {
        const planned = await deriveAlbumSendPlan({
          documentJson: draft.document_json,
          destination,
        });
        if (!planned.ok) {
          const code = `album_content_invalid:${planned.reason}`;
          const deadLetter = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: code,
            nowMs,
          });
          return deadLetter.kind === 'written'
            ? { publicationId: row.id, draftId: row.draft_id, outcome: 'dead_lettered', code }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
        const action = await evaluateAlbumEvidenceAction(row, planned.plan, messages, nowMs);
        if (action.action === 'dead_letter') {
          return deadLetterAlbumBinding(row, generation, action.code, nowMs);
        }
        if (action.action === 'park') {
          const marked = await markClaimedUncertain(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: action.code,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'failed_unconfirmed',
                code: action.code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
      } else if (messages.length > 1) {
        // ADR-0072: a text document with several recorded messages is
        // either a completed EDITORIAL album (several real photos sent
        // as one media group) — healed by the same ordinal+usage proof
        // as album documents — or a ledger anomaly. Either way: never
        // a re-send; a park keeps the records for the human dispositions.
        const action = await evaluateEditorialAlbumEvidenceAction(row, messages, nowMs);
        if (action.action === 'park') {
          const marked = await markClaimedUncertain(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: action.code,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'failed_unconfirmed',
                code: action.code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
        // Heal: falls through to healClaimedToPublished below.
      } else if (messages.length !== 1 || messages[0]!.chat_id !== destination) {
        // ADR-0071: a multi-record ledger may be an editorial album's
        // proof — evaluate it shape-aware before parking. An exact album
        // proof falls through to the shared heal below; anything else
        // parks uncertain for the human reconciliation, never re-sends.
        const albumAction = await evaluateEditorialAlbumEvidence({ row, messages, nowMs });
        if (albumAction.action !== 'heal') {
          const code =
            albumAction.action === 'park' ? albumAction.code : 'evidence_shape_anomalous';
          const marked = await markClaimedUncertain(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: code,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'failed_unconfirmed',
                code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
      }
      const healed = await healClaimedToPublished(deps.executor, {
        publicationId: row.id,
        generation,
        nowMs,
      });
      return healed.kind === 'written'
        ? { publicationId: row.id, draftId: row.draft_id, outcome: 'healed_from_evidence' }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // THE ALBUM BRANCH (ADR-0060): a durable album content document routes
    // to the media-group send path; EVERYTHING else (a text document, an
    // unparseable string, an oversized string) keeps the text path's exact
    // prior-phase behavior — the discriminator never guesses.
    if (discriminateAlbumDocument(draft.document_json) === 'album') {
      const planned = await deriveAlbumSendPlan({
        documentJson: draft.document_json,
        destination,
      });
      if (!planned.ok) {
        const code = `album_content_invalid:${planned.reason}`;
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: code,
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? { publicationId: row.id, draftId: row.draft_id, outcome: 'dead_lettered', code }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      return sendClaimedAlbum(row, generation, draft, nowMs, planned.plan);
    }
    const render = renderEditorialPostText(draft.document_json);
    if (!render.ok) {
      const deadLetter = await markClaimedDeadLetter(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: `render_failed:${render.reason}`,
        nowMs,
      });
      return deadLetter.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'dead_lettered',
            code: `render_failed:${render.reason}`,
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    const hash = await contentTextHash(render.text);
    if (!hash.ok) {
      const deadLetter = await markClaimedDeadLetter(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: 'content_hash_failed',
        nowMs,
      });
      return deadLetter.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'dead_lettered',
            code: 'content_hash_failed',
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // ADR-0068: the photo is resolved BEFORE the send-started marker —
    // a photo miss degrades to the text send with the row still
    // claimable (the resolver never throws; every reason is logged).
    // ADR-0072: a generated image is attempted ONLY when no source photo exists.
    let photo = await resolveEditorialPhoto({ row, documentJson: draft.document_json, nowMs });
    if (photo.kind === 'none') {
      deps.logger.debug('publication.scheduler.photo_fallback', { reason: photo.reason });
      if (photo.reason === 'photo_no_image' || photo.reason === 'photo_no_source_item') {
        const generated = await resolveGeneratedImage({ draft, render, nowMs });
        if (generated.kind === 'none') {
          deps.logger.debug('publication.scheduler.image_fallback', {
            reason: generated.reason,
          });
        } else {
          photo = generated;
        }
      }
    }
    // THE DURABLE SEND-STARTED MARKER (the d65d811 P1-1 fix): the last
    // write BEFORE any network effect — the machine's `mark_send_started`
    // (claimed -> publishing) with the in-flight lease extension. From
    // here the row can only exit through THIS generation's fenced
    // terminals: a concurrent scan can neither claim nor reclaim it, so a
    // lease expiry mid-flight can never become a second send. A generation
    // that dies inside the window parks in the `send_may_have_started`
    // family (the ambiguous window — held for the human dispositions,
    // healed only by recorded evidence).
    const started = await markClaimedSendStarted(deps.executor, {
      publicationId: row.id,
      generation,
      nowMs,
      leaseMs: SEND_IN_FLIGHT_LEASE_MS,
    });
    if (started.kind !== 'marked') {
      return { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    try {
      // ADR-0071: the editorial album rides its own send (one media
      // group, caption on the first photo) — the single-photo/text
      // flow below is untouched.
      if (photo.kind === 'album') {
        return sendEditorialAlbum({
          row,
          generation,
          album: photo,
          textHash: hash.hash,
          nowMs,
        });
      }
      // The two sends share one result shape (the photo send adds
      // the optional file_id); the annotation keeps the union honest
      // for the ledger save below.
      const sent: { readonly messageId: number; readonly photoFileId?: string } =
        photo.kind === 'photo' && deps.transport.sendPhotoRich !== undefined
          ? await deps.transport.sendPhotoRich({
              chatId: destination,
              photo: photo.photo,
              caption: photo.caption,
            })
          : photo.kind === 'generated' && deps.transport.sendPhotoBytesRich !== undefined
            ? await deps.transport.sendPhotoBytesRich({
                chatId: destination,
                photo: { bytes: photo.bytes, contentType: photo.contentType },
                caption: photo.caption,
              })
            : await deps.transport.sendMessageRich({
                chatId: destination,
                content: render.envelope,
              });
      if (!Number.isInteger(sent.messageId) || sent.messageId <= 0) {
        // A response without a usable message id proves nothing: uncertain,
        // and NOTHING is recorded (the ledger never records a guess).
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'response_message_id_invalid',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'response_message_id_invalid',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const recorded = await recordPublicationMessage(deps.executor, {
        publicationId: row.id,
        chatId: destination,
        messageId: sent.messageId,
        textHash: hash.hash,
        nowMs,
      });
      if (recorded.kind === 'duplicate_message') {
        // The ledger rejected the response's message id (reused/forged or a
        // racing generation): the honest outcome is uncertain — never a
        // claimed published, never a re-send.
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'delivery_record_rejected',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'delivery_record_rejected',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const terminal = await markClaimedPublished(deps.executor, {
        publicationId: row.id,
        generation,
        nowMs,
      });
      if (terminal.kind === 'written') {
        // ADR-0068/0070: after the delivery proof — a URL/bytes send
        // saves its returned file_id for reuse, and the usage row
        // records the photo on this publication. Best-effort: a ledger
        // failure here never un-sends the post (the next send
        // re-resolves by URL and the evidence check still heals from
        // the recorded message).
        if (photo.kind === 'photo' || photo.kind === 'generated') {
          try {
            if (
              photo.sentByUrl &&
              sent.photoFileId !== undefined &&
              deps.mediaAssets !== undefined
            ) {
              await deps.mediaAssets.markUploaded(photo.assetId, sent.photoFileId, nowMs);
            }
            // The usage row records the photo on this publication;
            // 'duplicate_usage' is the idempotent absorption (a
            // re-run of the same terminal never writes twice).
            await recordPublicationMediaUsages(deps.executor, {
              publicationId: row.id,
              usages: [{ ordinal: 0, mediaAssetId: photo.assetId }],
              nowMs,
            });
          } catch {
            deps.logger.warn('publication.scheduler.photo_ledger_save_failed');
          }
        }
        // Slice 6 — a terminally-sent P0 pins itself (toggle-gated,
        // best-effort: never fails the publication).
        await maybeAutoPinP0({
          publicationId: row.id,
          priority: row.priority,
          messageId: sent.messageId,
          nowMs,
        });
      }
      return terminal.kind === 'written'
        ? { publicationId: row.id, draftId: row.draft_id, outcome: 'sent' }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    } catch (error) {
      const outcome = classifySendOutcome(error);
      if (outcome.kind === 'uncertain') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: outcome.code,
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: outcome.code,
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      if (outcome.retryable) {
        const plan = planRetryAfterProvedFailure({
          attempts: generation,
          maxAttempts: row.max_attempts,
          retryAfterMs: outcome.retryAfterMs,
          nowMs,
        });
        if (plan.ok && plan.action === 'retry_wait') {
          const marked = await markClaimedRetryWait(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: outcome.code,
            runAfterMs: plan.runAfterMs,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'retry_scheduled',
                code: outcome.code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'attempt_budget_spent',
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'dead_lettered',
              code: 'attempt_budget_spent',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const marked = await markClaimedFailed(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: outcome.code,
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_hold',
            code: outcome.code,
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
  }

  /**
   * THE ALBUM SEND PATH (ADR-0060): the outbox claim consumes the durable
   * album content document through the media-group seam, with the ADR-0032
   * gate carried over INTACT:
   *  - the plan derivation is typed and BEFORE any effect — a document the
   *    strict reader refuses dead-letters with ZERO transport calls;
   *  - the LEDGER BINDING is fail-closed: every item must resolve to an
   *    UPLOADED asset whose telegram_file_id matches the document — a
   *    document the ledger cannot vouch for is dead-lettered BEFORE any
   *    send (the send identity is never accepted on faith);
   *  - the send is file_id-only (the attachments array is empty by
   *    construction — the fresh-bytes contract belongs to the upload path);
   *  - the response shape gate runs BEFORE any ledger write (the A2
   *    lesson): one message per item, in ordinal order, each id usable;
   *  - the delivery records land per ordinal with the caption hash on
   *    ordinal 0 ONLY; a rejected record parks the row uncertain — never a
   *    claimed published, never a re-send;
   *  - the usage binding lands AFTER the delivery proof: a failure parks
   *    uncertain and the NEXT scan's evidence check heals from the
   *    recorded messages — a binding failure can never orphan a proof;
   *  - transport failures classify through the SAME sop1 classifier as the
   *    text path (429 retryable with the 60s floor, 4xx hold, the rest
   *    uncertain and never auto-resent).
   */
  async function sendClaimedAlbum(
    row: PublicationRow,
    generation: number,
    draft: DraftRead,
    nowMs: number,
    plan: AlbumSendPlanV1,
  ): Promise<ScanDetail> {
    if (deps.mediaTransport === undefined || deps.mediaAssets === undefined) {
      // Unreachable: the gate-ON path validated the media seam before any
      // claim (and derived the plan), and the constructor pair rule keeps
      // the seam + ledger tied.
      throw new AppError('config_invalid');
    }
    // 2. The caption hash — the ordinal-0 delivery record's content anchor.
    let captionHash: string | null = null;
    if (plan.caption !== undefined) {
      const hash = await contentTextHash(plan.caption.text);
      if (!hash.ok) {
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'album_caption_hash_failed',
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'dead_lettered',
              code: 'album_caption_hash_failed',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      captionHash = hash.hash;
    }
    // 3. THE LEDGER BINDING + THE SEND-TIME RIGHTS GATE — before ANY
    // transport effect. The rights are re-read from the ledger HERE (the
    // d65d811 P1-3 fix): a blocked revocation or an unknown never-cleared
    // state dead-letters typed with ZERO transport calls.
    const binding = await resolveAlbumLedgerBindings(plan);
    if (!binding.ok) {
      return deadLetterAlbumBinding(row, generation, binding.reason, nowMs);
    }
    const bindings = binding.bindings;
    // 4. THE DURABLE SEND-STARTED MARKER (the d65d811 P1-1 fix) — the same
    // in-flight guard as the text path: claimed -> publishing, the lease
    // extended; a mid-flight lease expiry can never become a second send.
    const started = await markClaimedSendStarted(deps.executor, {
      publicationId: row.id,
      generation,
      nowMs,
      leaseMs: SEND_IN_FLIGHT_LEASE_MS,
    });
    if (started.kind !== 'marked') {
      return { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // 5. THE SEND — one media group, file_id-only, identity consumed.
    let sentMessages: readonly PublicationSentMediaGroupMessage[];
    try {
      sentMessages = await deps.mediaTransport.sendMediaGroup({
        chatId: destination,
        items: plan.items.map((item) => ({
          type: item.type,
          media: item.media,
          ...(item.ordinal === 0 && plan.caption !== undefined ? { caption: plan.caption } : {}),
        })),
        attachments: plan.attachments,
        sendIdentityKey: plan.sendIdentityKey,
      });
    } catch (error) {
      const outcome = classifySendOutcome(error);
      if (outcome.kind === 'uncertain') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: outcome.code,
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: outcome.code,
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      if (outcome.retryable) {
        const retryPlan = planRetryAfterProvedFailure({
          attempts: generation,
          maxAttempts: row.max_attempts,
          retryAfterMs: outcome.retryAfterMs,
          nowMs,
        });
        if (retryPlan.ok && retryPlan.action === 'retry_wait') {
          const marked = await markClaimedRetryWait(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: outcome.code,
            runAfterMs: retryPlan.runAfterMs,
            nowMs,
          });
          return marked.kind === 'written'
            ? {
                publicationId: row.id,
                draftId: row.draft_id,
                outcome: 'retry_scheduled',
                code: outcome.code,
              }
            : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
        }
        const deadLetter = await markClaimedDeadLetter(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'attempt_budget_spent',
          nowMs,
        });
        return deadLetter.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'dead_lettered',
              code: 'attempt_budget_spent',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
      const marked = await markClaimedFailed(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: outcome.code,
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_hold',
            code: outcome.code,
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // 6. THE RESPONSE SHAPE GATE — before ANY ledger write (the A2 lesson).
    const shapeValid =
      Array.isArray(sentMessages) &&
      sentMessages.length === plan.items.length &&
      sentMessages.every(
        (message) => Number.isInteger(message?.messageId) && message.messageId > 0,
      );
    if (!shapeValid) {
      // A reply without one usable id per ordinal proves nothing: uncertain,
      // and NOTHING is recorded (the ledger never records a guess).
      const marked = await markClaimedUncertain(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: 'response_media_group_shape_invalid',
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_unconfirmed',
            code: 'response_media_group_shape_invalid',
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // 7. THE PER-ORDINAL DELIVERY RECORDS — the at-most-once ledger.
    for (let ordinal = 0; ordinal < sentMessages.length; ordinal += 1) {
      const message = sentMessages[ordinal]!;
      const recorded = await recordPublicationMessage(deps.executor, {
        publicationId: row.id,
        chatId: destination,
        messageId: message.messageId,
        textHash: ordinal === 0 ? captionHash : null,
        nowMs,
        ordinal,
      });
      if (recorded.kind === 'duplicate_message') {
        // The ledger rejected the response's message id (reused/forged or a
        // racing generation): the honest outcome is uncertain — the records
        // already written stay (the evidence heal governs), never a re-send.
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'delivery_record_rejected',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'delivery_record_rejected',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
    }
    // 8. THE USAGE BINDING — after the delivery proof; a failure parks the
    // row uncertain and the NEXT scan's evidence check heals from the
    // recorded messages (the binding can never orphan a proof).
    try {
      const usages = await recordPublicationMediaUsages(deps.executor, {
        publicationId: row.id,
        usages: bindings,
        nowMs,
      });
      if (usages.kind === 'duplicate_usage') {
        const marked = await markClaimedUncertain(deps.executor, {
          publicationId: row.id,
          generation,
          errorCode: 'usage_record_rejected',
          nowMs,
        });
        return marked.kind === 'written'
          ? {
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'failed_unconfirmed',
              code: 'usage_record_rejected',
            }
          : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
      }
    } catch {
      const marked = await markClaimedUncertain(deps.executor, {
        publicationId: row.id,
        generation,
        errorCode: 'usage_record_failed',
        nowMs,
      });
      return marked.kind === 'written'
        ? {
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'failed_unconfirmed',
            code: 'usage_record_failed',
          }
        : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
    }
    // 9. THE TERMINAL — fenced by the claim's attempts generation.
    const terminal = await markClaimedPublished(deps.executor, {
      publicationId: row.id,
      generation,
      nowMs,
    });
    if (terminal.kind === 'written') {
      // Slice 6 — a terminally-sent P0 album pins its FIRST message
      // (toggle-gated, best-effort: never fails the publication).
      const firstMessage = sentMessages[0];
      if (firstMessage !== undefined) {
        await maybeAutoPinP0({
          publicationId: row.id,
          priority: row.priority,
          messageId: firstMessage.messageId,
          nowMs,
        });
      }
    }
    return terminal.kind === 'written'
      ? { publicationId: row.id, draftId: row.draft_id, outcome: 'sent' }
      : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' };
  }

  /** The claim plus the boundary budget dead-letter (the ADR-0037 lesson). */
  async function claimPublicationSafe(
    row: PublicationRow,
    nowMs: number,
  ): Promise<
    | { readonly kind: 'claimed'; readonly generation: number }
    | { readonly kind: 'not_claimable' }
    | { readonly kind: 'dead_lettered' }
  > {
    const claimed = await claimPublication(deps.executor, {
      publicationId: row.id,
      nowMs,
      leaseMs: PUBLISH_LEASE_MS,
    });
    if (claimed.kind === 'claimed') {
      return claimed;
    }
    // Not claimable: either a raced winner or the budget is spent. A
    // waiting row with a spent budget dead-letters AT the boundary —
    // without re-execution, without burning anything.
    const boundary = await markWaitingPublicationDeadLetter(deps.executor, {
      publicationId: row.id,
      nowMs,
    });
    return boundary.kind === 'dead_lettered'
      ? { kind: 'dead_lettered' }
      : { kind: 'not_claimable' };
  }

  return {
    /** One bounded scan round: reconcile, reclaim, decide, (maybe) send. */
    async scanDuePublications(): Promise<SchedulerScanReport> {
      const nowMs = deps.clock.now();
      const gateEnabled = deps.sendGate.enabled === true;

      // The misconfiguration is LOUD and writes NOTHING: an enablement
      // without a transport can never silently stand in for a real send.
      if (gateEnabled && deps.transport === undefined) {
        deps.logger.error('publication_scheduler.misconfigured', {
          reason: 'transport_absent',
        });
        return {
          scannedAtMs: nowMs,
          gateEnabled: true,
          decisionOnly: false,
          misconfigured: 'transport_absent',
          dueCount: 0,
          processed: 0,
          reclaimed: 0,
          uncertainParked: 0,
          uncertaintyHealed: 0,
          details: [],
        };
      }

      // THE MEDIA MISCONFIGURATION CHECK (ADR-0060, the same LOUD
      // zero-write class): a due ALBUM publication with no media-group seam
      // can never silently stand in for a real send. The probe is a bounded
      // read of the due drafts' documents; a text-only deployment (no album
      // due) is unaffected — the text path keeps working without the media
      // seam. Nothing has been written at this point: zero writes.
      if (gateEnabled && deps.mediaTransport === undefined) {
        const dueProbe = await listDuePublications(deps.executor, { nowMs, limit: scanLimit });
        let albumDue = false;
        for (const row of dueProbe) {
          const document = await deps.executor.first<{ readonly document_json: string }>({
            sql: `SELECT document_json FROM drafts WHERE id = ?`,
            params: [row.draft_id],
          });
          if (document && discriminateAlbumDocument(document.document_json) === 'album') {
            albumDue = true;
            break;
          }
        }
        if (albumDue) {
          deps.logger.error('publication_scheduler.misconfigured', {
            reason: 'media_transport_absent',
          });
          return {
            scannedAtMs: nowMs,
            gateEnabled: true,
            decisionOnly: false,
            misconfigured: 'media_transport_absent',
            dueCount: await countDuePublications(deps.executor, { nowMs }),
            processed: 0,
            reclaimed: 0,
            uncertainParked: 0,
            uncertaintyHealed: 0,
            details: [],
          };
        }
      }

      // Phase A (the d65d811 P1-1 fix, ORDER MATTERS): the ambiguous
      // in-flight windows park FIRST — the send-started generations whose
      // EXTENDED lease expired without a terminal become failed
      // (`send_may_have_started`) for the human dispositions. The same
      // reconciliation family as the heal below: it asserts the honest
      // UNKNOWN, never a send decision; the parked rows are NEVER
      // auto-resent (a parked 'failed' row is outside the claim WHERE
      // forever), and their recorded evidence heals in Phase A2 — the SAME
      // scan, the honest sequence.
      const uncertainParked = (await parkExpiredPublishingUncertain(deps.executor, { nowMs }))
        .parked;

      // Phase A2: the evidence reconciliation — runs in BOTH modes: the
      // heal asserts a recorded PROOF (the delivery happened), never a
      // send decision; an observe-only scan still reconciles the ledger's
      // facts.
      const uncertaintyHealed = await reconcileFailedWithEvidence(nowMs);

      if (!gateEnabled) {
        // DECISION-ONLY observation: zero SEND-path durable writes. The due
        // rows are read and the policy decisions computed and reported —
        // nothing is claimed, nothing is sent, no deferral is recorded.
        const due = await listDuePublications(deps.executor, { nowMs, limit: scanLimit });
        // ADR-0076 — the due scan's mix pool (one query for the loop).
        const poolCategories = await duePoolCategories(due);
        const dueCount = await countDuePublications(deps.executor, { nowMs });
        const details: ScanDetail[] = [];
        for (const row of due) {
          const draft = await deps.executor.first<DraftRead>({
            sql: `SELECT id, status, layout, document_json FROM drafts WHERE id = ?`,
            params: [row.draft_id],
          });
          if (!draft) {
            details.push({
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'decision_only',
              code: 'draft_not_found',
            });
            continue;
          }
          const decision = await buildPolicyDecision(row, draft, nowMs, poolCategories);
          if (!decision.ok) {
            details.push({
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'decision_only',
              code: decision.code,
            });
            continue;
          }
          if (!decision.decision.ok) {
            details.push({
              publicationId: row.id,
              draftId: row.draft_id,
              outcome: 'decision_only',
              code: decision.decision.reason,
              priorityClass: decision.priorityClass,
            });
            continue;
          }
          details.push({
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'decision_only',
            dueAtMs:
              decision.decision.outcome === 'schedule' ? decision.decision.dueAtMs : undefined,
            priorityClass: decision.priorityClass,
          });
        }
        return {
          scannedAtMs: nowMs,
          gateEnabled: false,
          decisionOnly: true,
          misconfigured: false,
          dueCount,
          processed: details.length,
          reclaimed: 0,
          uncertainParked,
          uncertaintyHealed,
          details,
        };
      }

      // Phase B: the stale-lease reclaim (attempts preserved; the next
      // generation's evidence check closes the recorded window).
      const reclaimed = (await reclaimExpiredClaims(deps.executor, { nowMs })).reclaimed;
      // Phase C: the due scan.
      const dueCount = await countDuePublications(deps.executor, { nowMs });
      const due = await listDuePublications(deps.executor, { nowMs, limit: scanLimit });
      // ADR-0076 — the due scan's mix pool (one query for the loop).
      const poolCategories = await duePoolCategories(due);
      const details: ScanDetail[] = [];
      for (const row of due) {
        const claim = await claimPublicationSafe(row, nowMs);
        if (claim.kind === 'dead_lettered') {
          details.push({
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'dead_lettered',
            code: 'attempt_budget_spent',
          });
          continue;
        }
        if (claim.kind === 'not_claimable') {
          details.push({
            publicationId: row.id,
            draftId: row.draft_id,
            outcome: 'not_claimable',
          });
          continue;
        }
        const generation = claim.generation;
        const draft = await deps.executor.first<DraftRead>({
          sql: `SELECT id, status, layout, document_json FROM drafts WHERE id = ?`,
          params: [row.draft_id],
        });
        if (!draft) {
          const written = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: 'eligibility_lost',
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'dead_lettered',
                  code: 'eligibility_lost',
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        if (draft.status !== 'approved' && draft.status !== 'auto_approved') {
          const written = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: 'eligibility_lost',
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'dead_lettered',
                  code: 'eligibility_lost',
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        const decision = await buildPolicyDecision(row, draft, nowMs, poolCategories);
        if (!decision.ok) {
          const written = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: decision.code,
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'dead_lettered',
                  code: decision.code,
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        if (!decision.decision.ok) {
          // A typed psp1 input failure on a validated score is a policy
          // data bug: loud, terminal, never a silent release loop.
          const written = await markClaimedDeadLetter(deps.executor, {
            publicationId: row.id,
            generation,
            errorCode: decision.decision.reason,
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'dead_lettered',
                  code: decision.decision.reason,
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        if (decision.decision.outcome === 'defer') {
          const release = planReleaseAfterScheduleDecision({ dueAtMs: null, nowMs });
          if (!release.ok) {
            throw new AppError('internal_error');
          }
          const written = await releaseClaimed(deps.executor, {
            publicationId: row.id,
            generation,
            runAfterMs: release.runAfterMs,
            scheduledAtMs: release.scheduledAtMs,
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? { publicationId: row.id, draftId: row.draft_id, outcome: 'deferred_policy' }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        if (decision.decision.dueAtMs > nowMs) {
          const release = planReleaseAfterScheduleDecision({
            dueAtMs: decision.decision.dueAtMs,
            nowMs,
          });
          if (!release.ok) {
            throw new AppError('internal_error');
          }
          const written = await releaseClaimed(deps.executor, {
            publicationId: row.id,
            generation,
            runAfterMs: release.runAfterMs,
            scheduledAtMs: release.scheduledAtMs,
            nowMs,
          });
          details.push(
            written.kind === 'written'
              ? {
                  publicationId: row.id,
                  draftId: row.draft_id,
                  outcome: 'deferred_time',
                  dueAtMs: decision.decision.dueAtMs,
                }
              : { publicationId: row.id, draftId: row.draft_id, outcome: 'fence_rejected' },
          );
          continue;
        }
        details.push(await sendClaimed(row, generation, draft, nowMs));
      }
      return {
        scannedAtMs: nowMs,
        gateEnabled: true,
        decisionOnly: false,
        misconfigured: false,
        dueCount,
        processed: details.length,
        reclaimed,
        uncertainParked,
        uncertaintyHealed,
        details,
      };
    },
  };
}
