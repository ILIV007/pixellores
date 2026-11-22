/**
 * The draft→publication bridge (slice 9 — Link 4).
 *
 * Until this slice NOTHING converted a ready / `auto_approved` draft into
 * a `publications` outbox row: `enqueuePublication` was called in
 * production only by the album producer (which has zero production
 * callers), `evaluateAutoPublishGate` and the auto-approval transition
 * had zero callers at all. This bridge is the production route:
 *
 *   ready draft → ag1 AUTO GATE (stored bytes only) → fenced
 *   `auto_approved` transition → idempotent `enqueuePublication`
 *   (the pidek1 key over draft + destination).
 *
 * THE GATES (each independent, each fail-closed):
 *  - MODE: the bridge runs ONLY while the D1 publishing mode is `auto`
 *    or `safe-auto`. `paused` and `approval` skip with ZERO writes — a
 *    paused deployment can never publish through this bridge, and an
 *    approval-mode deployment never auto-approves a draft a human has
 *    not read. The mode is the caller-supplied (cron-read) D1 setting,
 *    never an env var.
 *  - THE GATE VERDICT: only an `eligible_auto` verdict reaches the
 *    transition. A `requires_review` verdict (a claim the fact-guard
 *    could not ground) or a `refused` verdict (no measurable basis)
 *    leaves the draft exactly `ready` — the human review path stays,
 *    and nothing is enqueued.
 *  - ELIGIBILITY IS NOT ACTIVATION: the fenced transition takes the
 *    bridge's own enablement (the mode check above) AND the eligible
 *    verdict — either one missing refuses with ZERO writes (the
 *    auto-approval store's own contract).
 *  - THE SOUL STAMP: the bridge reads the ACTIVE Soul version
 *    (`soul.current_version`, fail-soft) and stamps it on the
 *    publication row (migration 0011). When NO Soul version is
 *    resolvable the WHOLE pass skips with ZERO writes — a publication
 *    without a Soul stamp is never created quietly (the slice-8
 *    contract: every published post carries its `soul_version`).
 *
 * THE PRIORITY (P1, 80 — the documented breaking-news class): an
 * auto-approved draft is ag1-eligible (grounded, official/verified
 * claims), so it rides P1 — publish within 5–20 minutes, NOT
 * quiet-gated (a P2/P3 draft would defer to the next active Tehran
 * window, stranding same-night breaking news until morning). It is
 * NEVER P0: no daily-cap bypass, no auto-pin — P0 stays reserved for
 * human-flagged very-big news.
 *
 * BOUNDARIES: bounded work only (at most `limit` drafts per pass,
 * default 5); no transport, no send, no AI — the scheduler's scan is
 * the ONLY sender, in a later cron step. A `duplicate` enqueue (the
 * same draft bridged twice) is the honest absorption, never a second
 * row.
 *
 * ADR-0068 — LANE + CAP (the bridge also shapes WHAT reaches the
 * outbox, it never just forwards the gate):
 * - GUIDE LANE: a draft whose source URL carries `/guide/` rides
 *   the guide lane — at most ONE guide per pass, at P2 priority
 *   (60). Guides are never dropped; deferred guides stay `ready`.
 * - CATEGORY CAP: the arp1 40%-of-rolling-six cap runs HERE, over
 *   the published trail PLUS the categories approved in this pass
 *   (eventDriven false — the bridge has no story-layer provider).
 *   An over-cap draft stays `ready` (deferred, never rejected):
 *   the scheduler remains the enforcement backstop at send time,
 *   and an unclassifiable draft skips the cap check.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  findStoryContentType,
  findStoryReferenceItems,
  listReadyDrafts,
} from '../../adapters/db/editorial-store';
import { approveDraftForAutoPublication } from '../../adapters/db/auto-approval-store';
import {
  enqueuePublication,
  listRecentPublishedHistory,
  type EnqueueOutcome,
} from '../../adapters/db/publication-outbox-store';
import { getCurrentSoulVersion } from '../../adapters/db/soul-store';
import { evaluateAutoPublishGate } from '../../domain/publishing/auto-gate';
import {
  CATEGORY_ROLLING_WINDOW,
  enforceCategoryShare,
  WEEKLY_MIX_WINDOW_MS,
  type MixCategory,
} from '../../domain/publishing/anti-robot';
import { mapContentTypeToMixCategory } from './scheduler-policy';
import {
  classifyPostLane,
  GUIDE_PUBLISH_PRIORITY_SCORE,
  MAX_GUIDES_PER_BRIDGE_PASS,
} from '../../domain/publishing/guide-lane';
import type { PublishMode } from '../../domain/publishing/publishing-settings';
import type { Logger } from '../../observability/logger';

/**
 * The publication priority of an AUTO-approved draft — P1 (75–89), the
 * documented "publish within 5–20 minutes" class. See the module header.
 */
export const AUTO_PUBLISH_PRIORITY_SCORE = 80;

/** The recent published history the cap reads (bounded, newest-first). */
export const AUTO_PUBLISH_HISTORY_LIMIT = 512;

/** One pass bridges at most this many ready drafts. */
export const AUTO_PUBLISH_BRIDGE_LIMIT = 5;

export type AutoPublishBridgeReport =
  | {
      readonly kind: 'skipped';
      readonly reason: 'mode_blocks_auto' | 'soul_version_unknown';
    }
  | {
      readonly kind: 'bridged';
      /** Ready drafts observed this pass (≤ limit). */
      readonly scanned: number;
      /** Drafts that became `auto_approved` (incl. already-approved). */
      readonly approved: number;
      /** Publication rows newly created. */
      readonly enqueued: number;
      /** Drafts whose publication row already existed. */
      readonly duplicates: number;
      /** Drafts the gate sent to human review (left `ready`). */
      readonly requiresReview: number;
      /** Drafts the gate refused for lack of a measurable basis. */
      readonly refused: number;
      /** Drafts the guide lane deferred this pass (left `ready`). */
      readonly deferredGuideLane: number;
      /** Drafts the category cap deferred this pass (left `ready`). */
      readonly deferredCategoryCap: number;
      /** Drafts that failed the transition or the enqueue. */
      readonly rejected: number;
    };

export async function bridgeReadyDrafts(input: {
  readonly executor: DbExecutor;
  readonly destination: string;
  readonly mode: PublishMode;
  readonly nowMs: number;
  readonly limit?: number;
  readonly logger?: Logger;
}): Promise<AutoPublishBridgeReport> {
  if (input.mode !== 'auto' && input.mode !== 'safe-auto') {
    return { kind: 'skipped', reason: 'mode_blocks_auto' };
  }
  const soulVersion = await getCurrentSoulVersion(input.executor);
  if (soulVersion === null) {
    input.logger?.warn('publishing.bridge.soul_version_unknown');
    return { kind: 'skipped', reason: 'soul_version_unknown' };
  }
  const drafts = await listReadyDrafts(input.executor, {
    limit: input.limit ?? AUTO_PUBLISH_BRIDGE_LIMIT,
  });
  // ADR-0068 — the category cap's history: the published trail mapped
  // to mix categories (the scheduler's own derivation, reused here so
  // the bridge and the send gate read the same world). An unreadable
  // history fails the WHOLE pass with zero writes — a cap that cannot
  // be evaluated never silently passes.
  const history = await listRecentPublishedHistory(input.executor, {
    nowMs: input.nowMs,
    limit: AUTO_PUBLISH_HISTORY_LIMIT,
  });
  const publishedCategories: { readonly category: MixCategory; readonly atMs: number }[] = [];
  for (const entry of history) {
    if (entry.publishedAtMs < input.nowMs - WEEKLY_MIX_WINDOW_MS) continue;
    const mapped = mapContentTypeToMixCategory(entry.contentType);
    if (mapped.ok) {
      publishedCategories.push({ category: mapped.category, atMs: entry.publishedAtMs });
    }
  }
  let approved = 0;
  let enqueued = 0;
  let duplicates = 0;
  let requiresReview = 0;
  let refused = 0;
  let deferredGuideLane = 0;
  let deferredCategoryCap = 0;
  let rejected = 0;
  let guidesApproved = 0;
  // The categories approved in THIS pass ride the rolling window with
  // the pass instant — the cap sees the pass as it grows.
  const approvedCategories: MixCategory[] = [];
  const approvalMode = input.mode === 'safe-auto' ? 'safe_auto' : 'auto';
  for (const draft of drafts) {
    const verdict = evaluateAutoPublishGate(draft.document_json);
    if (verdict.kind === 'requires_review') {
      requiresReview += 1;
      continue;
    }
    if (verdict.kind === 'refused') {
      refused += 1;
      continue;
    }
    // ADR-0068 — lane + cap (both leave the draft `ready` on defer).
    // A lane/cap read failure rejects the draft for this pass —
    // never an approval on an unevaluated cap.
    let lane: 'news' | 'guide' = 'news';
    let category: MixCategory | null = null;
    try {
      const contentType = await findStoryContentType(input.executor, draft.story_id);
      if (contentType !== null) {
        const mapped = mapContentTypeToMixCategory(contentType);
        if (mapped.ok) category = mapped.category;
      }
      const references = await findStoryReferenceItems(input.executor, draft.story_id, 1);
      lane = classifyPostLane(references[0]?.canonical_url ?? null);
    } catch {
      rejected += 1;
      input.logger?.warn('publishing.bridge.lane_cap_lookup_failed');
      continue;
    }
    if (lane === 'guide' && guidesApproved >= MAX_GUIDES_PER_BRIDGE_PASS) {
      deferredGuideLane += 1;
      continue;
    }
    if (category !== null) {
      // The cap evaluates the six most recent: this pass's
      // approvals (newest, at the pass instant) plus the newest
      // published entries — the 512 bound is never approached.
      const recent = [
        ...approvedCategories.map((approvedCategory) => ({
          category: approvedCategory,
          atMs: input.nowMs,
        })),
        ...publishedCategories.slice(-CATEGORY_ROLLING_WINDOW),
      ];
      const cap = enforceCategoryShare({
        nowMs: input.nowMs,
        category,
        recent,
        eventDriven: false,
      });
      if (!cap.ok || !cap.value.allowed) {
        deferredCategoryCap += 1;
        continue;
      }
    }
    const priorityScore =
      lane === 'guide' ? GUIDE_PUBLISH_PRIORITY_SCORE : AUTO_PUBLISH_PRIORITY_SCORE;
    const approval = await approveDraftForAutoPublication(input.executor, {
      draftId: draft.id,
      gateVerdict: verdict,
      // The bridge's own enablement IS the mode check above (auto /
      // safe-auto): the store's independent flag and the eligible
      // verdict are both present here, never one without the other.
      gateEnabled: true,
      nowMs: input.nowMs,
    });
    if (approval.kind !== 'applied' && approval.kind !== 'already_auto_approved') {
      rejected += 1;
      input.logger?.warn('publishing.bridge.approval_refused', {
        reason: approval.kind,
      });
      continue;
    }
    approved += 1;
    if (lane === 'guide') guidesApproved += 1;
    if (category !== null) approvedCategories.push(category);
    const outcome: EnqueueOutcome = await enqueuePublication(input.executor, {
      publicationId: `pub:auto:${draft.id}`,
      draftId: draft.id,
      destination: input.destination,
      priorityScore,
      approvalMode,
      nowMs: input.nowMs,
      soulVersion,
    });
    if (outcome.kind === 'created') {
      enqueued += 1;
    } else if (outcome.kind === 'duplicate') {
      duplicates += 1;
    } else {
      rejected += 1;
      input.logger?.warn('publishing.bridge.enqueue_rejected', {
        reason: outcome.reason,
      });
    }
  }
  return {
    kind: 'bridged',
    scanned: drafts.length,
    approved,
    enqueued,
    duplicates,
    requiresReview,
    refused,
    deferredGuideLane,
    deferredCategoryCap,
    rejected,
  };
}
