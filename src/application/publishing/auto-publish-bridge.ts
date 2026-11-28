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
 *  - FRESHNESS (ADR-0079 §3.3): before the gate verdict, a draft whose
 *    primary source item is older than 48h — or whose claims carry a
 *    date already past — is RETIRED (a `quality_rejections` row + the
 *    draft leaves `ready` for `rejected`), never bridged, never
 *    deferred. A draft with no reference items skips the check.
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
 * claims), so it rides P1 — publish within 30–90 minutes (ADR-0079
 * §3.6), NOT quiet-gated (a P2/P3 draft would defer to the next
 * active Tehran window, stranding same-night breaking news until
 * morning). It is NEVER P0: no daily-cap bypass, no auto-pin — P0
 * stays reserved for human-flagged very-big news.
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
 *   ADR-0076 — SINGLE-CATEGORY POOL: the cap is a MIX-SHAPING rule,
 *   so it applies only when the ready pool holds another mix
 *   category. A pool of one category cannot be shaped — deferring
 *   its drafts would throttle the channel's only content and stall
 *   forever (the trail can never dilute without a publication).
 *   The pool is read once per pass (the whole ready set, not the
 *   scanned five); an unreadable pool fails the pass with zero
 *   writes, like an unreadable history.
 *
 * ADR-0070 — REWRITE SEAM: when the caller threads `rewriteRequired`
 * (the AI_GEMINI_REWRITE_ENABLED flag, resolved once per cron pass),
 * a ready draft bridges ONLY after its Soul rewrite landed
 * (`document.rewrite.status === 'rewritten'`). Anything else is
 * DEFERRED — an un-rewritten draft stays `ready` for a later pass
 * (`deferredRewrite`), and a `rewrite.status = 'failed'` draft is
 * NEVER bridged (`failedRewrite`) until a human reviews it. When the
 * flag is OFF the bridge behaves exactly as today (raw drafts
 * publish) — the flag is the kill-switch.
 *
 * ADR-0074 — RE-EVALUATION + PROGRESS: the gate reads STORED reports
 * only, and a stored pre-ADR-0066 report keeps its false numbers
 * findings forever. When the gate fails a draft on a numbers finding,
 * the bridge re-runs the fact-guard over the draft's own stored claims
 * + the stored source item (the CURRENT folded lens) and replaces the
 * stored report when the rebuild validates — then the gate decides on
 * the REBUILT bytes. A re-evaluation that cannot validate leaves the
 * stored report untouched. ADR-0082 — the same trigger fires when the
 * gate REFUSES a draft for a missing report (`report_absent`, the
 * flag-off shape): the service BUILDS the report from the stored bytes
 * and the gate re-decides on the rebuilt document. One attempt per
 * draft per pass: after a successful build the report exists, so later
 * passes never re-trigger. And the scan itself is progress-ordered
 * (migration 0013: `draft_gate_evaluations`): each pass records every
 * gate verdict and orders by consecutive failures, so
 * deterministically-failing drafts sink below unevaluated ones instead
 * of head-blocking the queue forever.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  findStoryContentType,
  findStoryReferenceItems,
  listReadyDraftContentTypes,
  listReadyDraftsForBridge,
  recordGateEvaluation,
  type EditorialSourceItemRow,
} from '../../adapters/db/editorial-store';
import { recordQualityRejection } from '../../adapters/db/near-dup-store';
import {
  FRESHNESS_MAX_AGE_MS,
  isDraftStale,
  readDraftClaimDatePhrases,
} from '../../domain/publishing/draft-freshness';
import { reevaluateDraftFactGuard } from '../editorial/fact-guard-reevaluation';
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
 * documented "publish within 30–90 minutes" class (ADR-0079 §3.6).
 * See the module header.
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
      /** ADR-0079 §3.3: stale drafts retired this pass (quality_rejections
       * row + draft left `ready` for `rejected`) — terminal, never a
       * deferral. */
      readonly retiredStale: number;
      /** ADR-0074: stored fact-guard reports rebuilt with the current
       * folded lens this pass (their stored findings cleared or moved). */
      readonly reevaluated: number;
      /** ADR-0074: re-evaluation attempts that could not validate and
       * left the stored report untouched (fail-closed skips, concurrent
       * changes, or evaluation-write failures). */
      readonly reevaluationSkipped: number;
      /** Drafts the guide lane deferred this pass (left `ready`). */
      readonly deferredGuideLane: number;
      /** Drafts the category cap deferred this pass (left `ready`). */
      readonly deferredCategoryCap: number;
      /** ADR-0070: drafts deferred because their Soul rewrite has not
       * landed yet (left `ready` for a later pass). */
      readonly deferredRewrite: number;
      /** ADR-0070: drafts NEVER bridged — their rewrite failed and a
       * human must review them first (left `ready`). */
      readonly failedRewrite: number;
      /** Drafts that failed the transition or the enqueue. */
      readonly rejected: number;
    };

/** The rewrite status a stored draft document carries (ADR-0070). */
function readRewriteStatus(documentJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(documentJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    // Stored document_json is the BARE StoredDraftDocument (see
    // parseDraftDocumentForRewrite's shape note) — the rewrite block
    // rides at the top level, never under a `document` key.
    const rewrite = (parsed as Record<string, unknown>)['rewrite'];
    if (rewrite === null || typeof rewrite !== 'object' || Array.isArray(rewrite)) {
      return null;
    }
    const status = (rewrite as Record<string, unknown>)['status'];
    return typeof status === 'string' ? status : null;
  } catch {
    // An unparsable document can never prove a rewrite landed — defer
    // it (the gate below would refuse it anyway); never crash the pass.
    return null;
  }
}

/**
 * ADR-0074 — record one gate verdict in the progress table. The write
 * is best-effort progress, never a gate: a recording failure is logged
 * and the pass continues — the verdicts stand either way, and the next
 * pass simply re-orders from the last durable state.
 */
async function recordGateEvaluationQuietly(
  input: {
    readonly executor: DbExecutor;
    readonly nowMs: number;
    readonly logger?: Logger;
  },
  draftId: string,
  outcome: 'eligible_auto' | 'requires_review' | 'refused',
  failureReason: string | null,
): Promise<void> {
  try {
    await recordGateEvaluation(input.executor, {
      draftId,
      outcome,
      failureReason,
      nowMs: input.nowMs,
    });
  } catch {
    input.logger?.warn('publishing.bridge.gate_evaluation_unrecorded', {
      draftId,
    });
  }
}

export async function bridgeReadyDrafts(input: {
  readonly executor: DbExecutor;
  readonly destination: string;
  readonly mode: PublishMode;
  readonly nowMs: number;
  readonly limit?: number;
  /**
   * ADR-0070: true while AI_GEMINI_REWRITE_ENABLED is on — a draft
   * bridges only after its Soul rewrite landed. False/absent ⇒ the
   * bridge behaves exactly as today (raw drafts publish).
   */
  readonly rewriteRequired?: boolean;
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
  // ADR-0074 — the progress-ordered scan (migration 0013): each pass
  // reaches unevaluated drafts first; deterministically-failing drafts
  // sink below fresh ones instead of head-blocking the queue.
  const drafts = await listReadyDraftsForBridge(input.executor, {
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
  // ADR-0076 — the ready pool's mix categories (ONE read per pass):
  // the category cap can only shape a mix when the pool holds another
  // category. An unreadable pool fails the WHOLE pass with zero writes
  // — a cap that cannot be evaluated never silently passes.
  const poolContentTypes = await listReadyDraftContentTypes(input.executor);
  const poolCategories = new Set<MixCategory>();
  for (const contentType of poolContentTypes) {
    const mapped = mapContentTypeToMixCategory(contentType);
    if (mapped.ok) poolCategories.add(mapped.category);
  }
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
  let retiredStale = 0;
  let reevaluated = 0;
  let reevaluationSkipped = 0;
  let deferredGuideLane = 0;
  let deferredCategoryCap = 0;
  let deferredRewrite = 0;
  let failedRewrite = 0;
  let rejected = 0;
  let guidesApproved = 0;
  // The categories approved in THIS pass ride the rolling window with
  // the pass instant — the cap sees the pass as it grows.
  const approvedCategories: MixCategory[] = [];
  const approvalMode = input.mode === 'safe-auto' ? 'safe_auto' : 'auto';
  for (const draft of drafts) {
    // ADR-0070 — the rewrite seam runs FIRST: a draft whose Soul
    // rewrite has not landed cannot bridge this pass, whatever the
    // gate would say. Failed rewrites are never bridged; anything else
    // un-rewritten is deferred (left `ready`) for a later pass.
    if (input.rewriteRequired === true) {
      const rewriteStatus = readRewriteStatus(draft.document_json);
      if (rewriteStatus === 'failed') {
        failedRewrite += 1;
        input.logger?.warn('publishing.bridge.rewrite_failed_skipped', {
          draftId: draft.id,
        });
        continue;
      }
      if (rewriteStatus !== 'rewritten') {
        deferredRewrite += 1;
        continue;
      }
    }
    // ADR-0079 §3.3 — the freshness gate runs BEFORE the auto gate: a
    // stale draft is RETIRED, never bridged, never deferred (a deferral
    // would re-evaluate forever — the livelock family). The primary
    // reference item (first by id — the story's anchor source, the same
    // item the lane rule reads below) supplies the source age; the
    // claim date phrases supply the past-date rule. A draft with NO
    // reference items skips the check (no evidence to judge — the gate
    // decides on it instead). A lookup failure skips the draft this
    // pass (rejected): a read failure must never retire news.
    let references: readonly EditorialSourceItemRow[];
    try {
      references = await findStoryReferenceItems(input.executor, draft.story_id, 1);
    } catch {
      rejected += 1;
      input.logger?.warn('publishing.bridge.reference_lookup_failed', {
        draftId: draft.id,
      });
      continue;
    }
    const primaryReference = references[0];
    if (primaryReference !== undefined) {
      const freshness = isDraftStale({
        sourcePublishedAtMs: primaryReference.published_at_ms,
        claimDatePhrases: readDraftClaimDatePhrases(draft.document_json),
        nowMs: input.nowMs,
        maxAgeMs: FRESHNESS_MAX_AGE_MS,
      });
      if (freshness.stale) {
        // Terminal retirement: a quality_rejections row (the fingerprint
        // is namespaced `stale:<content_hash>` so it never collides with
        // the near-dup namespace) + the draft leaves `ready` for
        // `rejected` — migration 0001 CHECK-constrains drafts.status and
        // `rejected` is the fitting terminal value (the bridge only scans
        // `ready`, so it never re-enqueues). The rejection write runs
        // first; the fenced status update follows — a failure between
        // them leaves the draft `ready` and the next pass refreshes the
        // rejection row and retries the update (convergent, never lost).
        try {
          await recordQualityRejection(input.executor, {
            id: `qr:stale:${draft.id}`,
            fingerprint: `stale:${primaryReference.content_hash}`,
            reason: freshness.reason,
            sourceItemId: primaryReference.id,
            nowMs: input.nowMs,
          });
          const fence = await input.executor.run({
            sql: `UPDATE drafts SET status = 'rejected' WHERE id = ? AND status = 'ready'`,
            params: [draft.id],
          });
          if (fence.changes !== 1) {
            rejected += 1;
            input.logger?.warn('publishing.bridge.stale_retirement_fence_rejected', {
              draftId: draft.id,
            });
            continue;
          }
        } catch {
          rejected += 1;
          input.logger?.warn('publishing.bridge.stale_retirement_failed', {
            draftId: draft.id,
          });
          continue;
        }
        retiredStale += 1;
        continue;
      }
    }
    // ADR-0074 — the gate verdict, on the CURRENT bytes. A
    // requires_review verdict on a numbers finding is the stale-report
    // family: re-run the fact-guard with the current folded lens and
    // decide on the REBUILT bytes when the rebuild validates. ADR-0082
    // — a refused verdict on a MISSING report is the flag-off family:
    // build the report from the stored bytes and decide on the rebuilt
    // document the same way. Every other verdict stands as evaluated.
    let documentJson = draft.document_json;
    let verdict = evaluateAutoPublishGate(documentJson);
    const needsReevaluation =
      (verdict.kind === 'requires_review' &&
        verdict.reason === 'fact_guard_findings' &&
        verdict.claims.some((claim) =>
          claim.findings.includes('number_not_observed_in_evidence'),
        )) ||
      (verdict.kind === 'refused' && verdict.reason === 'report_absent');
    if (needsReevaluation) {
      try {
        const rebuilt = await reevaluateDraftFactGuard({
          executor: input.executor,
          draftId: draft.id,
          documentJson,
          nowMs: input.nowMs,
          logger: input.logger,
        });
        if (rebuilt.kind === 'updated') {
          reevaluated += 1;
          documentJson = rebuilt.documentJson;
          verdict = evaluateAutoPublishGate(documentJson);
        } else if (rebuilt.kind === 'skipped') {
          reevaluationSkipped += 1;
          input.logger?.warn('publishing.bridge.fact_guard_reevaluation_skipped', {
            draftId: draft.id,
            reason: rebuilt.reason,
          });
        } else if (rebuilt.kind === 'concurrent_change') {
          // The document moved underneath us — the verdict we hold is
          // for stale bytes. Skip this draft this pass; the next pass
          // re-reads the new bytes. The recorded verdict is the ORIGINAL
          // one (requires_review for the numbers family, refused for a
          // report built from absent — ADR-0082).
          reevaluationSkipped += 1;
          input.logger?.warn('publishing.bridge.fact_guard_reevaluation_concurrent_change', {
            draftId: draft.id,
          });
          if (verdict.kind === 'requires_review') {
            await recordGateEvaluationQuietly(input, draft.id, 'requires_review', verdict.reason);
            requiresReview += 1;
          } else if (verdict.kind === 'refused') {
            await recordGateEvaluationQuietly(input, draft.id, 'refused', verdict.reason);
            refused += 1;
          }
          continue;
        }
        // 'unchanged' / 'not_applicable': the stored report is current
        // (or has no numbers findings) — the verdict stands.
      } catch {
        // A re-evaluation failure never kills the pass: the draft stays
        // `ready` for human review and the next draft is still scanned.
        reevaluationSkipped += 1;
        input.logger?.warn('publishing.bridge.fact_guard_reevaluation_failed', {
          draftId: draft.id,
        });
      }
    }
    if (verdict.kind === 'requires_review') {
      requiresReview += 1;
      await recordGateEvaluationQuietly(input, draft.id, 'requires_review', verdict.reason);
      continue;
    }
    if (verdict.kind === 'refused') {
      refused += 1;
      await recordGateEvaluationQuietly(input, draft.id, 'refused', verdict.reason);
      continue;
    }
    // The gate passed — record the eligible verdict (resetting the
    // consecutive-failure count) BEFORE the lane/cap deferrals: the
    // verdict is final whatever the lane and cap decide.
    await recordGateEvaluationQuietly(input, draft.id, 'eligible_auto', null);
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
      // The references were already resolved for the freshness gate above
      // (one read per draft, not two) — the lane reads the same row.
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
      // ADR-0076 — the pool holds an alternative for this draft iff
      // it contains a mix category OTHER than the draft's own.
      const alternativeCategoryAvailable = [...poolCategories].some(
        (poolCategory) => poolCategory !== category,
      );
      const cap = enforceCategoryShare({
        nowMs: input.nowMs,
        category,
        recent,
        eventDriven: false,
        alternativeCategoryAvailable,
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
    retiredStale,
    reevaluated,
    reevaluationSkipped,
    deferredGuideLane,
    deferredCategoryCap,
    deferredRewrite,
    failedRewrite,
    rejected,
  };
}
