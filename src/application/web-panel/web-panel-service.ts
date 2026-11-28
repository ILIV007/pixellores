/**
 * Web admin panel service (ADR-0081) — the data layer behind /api/admin/*.
 *
 * One service, the same D1 stores as the bot panel v2, no second path:
 * - Reads go through the EXISTING store boundary (publishing settings,
 *   editorial, outbox, soul, post-management, admin-manage, sources,
 *   audit events). Nothing here runs SQL.
 * - Writes go through the EXISTING fenced store functions
 *   (setPublishMode / setDailyCap / setEventMode,
 *   approveDraftForHumanPublication + enqueuePublication,
 *   rejectDraftForHumanPublication, cancelPublicationById,
 *   setSourceEnabled, applyAdminAdd / applyAdminDeactivate, and the
 *   post-management service for pin/unpin/delete/edit/auto-pin/
 *   retention). Every mutation writes its audit row in the store's own
 *   atomic batch.
 * - Authorization is split: the HANDLER resolves the session to a role
 *   and requires `dashboard.view` for every call (a role without it
 *   never reaches this service). Each mutation checks its OWN permission
 *   here and returns `{kind:'denied'}` — the same permission the bot
 *   panel checks for the same action (`draft.approve`, `draft.reject`,
 *   `publication.cancel`, `settings.editorial`, `source.manage`,
 *   owner-only admin management).
 * - Draft documents parse DEFENSIVELY: a malformed `document_json`
 *   yields nulls, never an exception. Structured `figures` / `quote` /
 *   `verdict` / `gameName` are read when present (the PR-B renderer
 *   fields); on main today they are absent, and the preview says so
 *   honestly instead of deriving them.
 * - Honestly-disabled actions (Send Now, Manual trigger, Force tick,
 *   Test AI) are NOT methods here — there is no engine seam to call.
 *   The handler answers `{available:false}` for them directly.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import { roleHasPermission, type AdminRole } from '../../admin/roles';
import {
  countDraftsByStatus,
  countEditorialTotals,
  countAiRunsByProvider,
  countReadyDraftsByContentType,
  getDraftById,
  listReadyDrafts,
  type AiRunsByProviderRow,
  type DraftStatusCounts,
  type EditorialTotals,
} from '../../adapters/db/editorial-store';
import {
  approveDraftForHumanPublication,
  rejectDraftForHumanPublication,
} from '../../adapters/db/human-approval-store';
import {
  cancelPublicationById,
  countPublicationsByStatus,
  enqueuePublication,
  listCancellablePublications,
  type PublicationStatusCounts,
} from '../../adapters/db/publication-outbox-store';
import {
  readPublishingSettings,
  readTodayCounts,
  setDailyCap,
  setEventMode,
  setPublishMode,
  type TodayCounts,
} from '../../adapters/db/publishing-settings-store';
import { getCurrentSoulVersion, getSoulText } from '../../adapters/db/soul-store';
import {
  getActivePin,
  listChannelPosts,
  readPostManagementSettings,
  type ChannelPostListRow,
} from '../../adapters/db/post-management-store';
import {
  applyAdminAdd,
  applyAdminDeactivate,
  listAdmins,
  type AdminManageRow,
} from '../../adapters/db/admin-manage-store';
import {
  listProvidersWithHealth,
  setSourceEnabled,
  type ProviderHealthRow,
} from '../../adapters/db/source-registry-store';
import { listRecentAuditEvents, type AuditEventRow } from '../../adapters/db/audit-events-store';
import {
  createPostManagementService,
  type PostManagementTransport,
} from '../publishing/post-management-service';
import {
  effectiveDailyCap,
  isPublishMode,
  type PublishMode,
} from '../../domain/publishing/publishing-settings';
import type { ChannelPostRefType, RetentionRule } from '../../domain/publishing/post-management';
import { msUntilNextTehranMidnight } from '../../shared/time/tehran-day';
import { randomToken } from '../../domain/admin-post/fingerprint';

/** The bridge tick cadence (wrangler.jsonc triggers: every 5 minutes). */
export const WEB_PANEL_NEXT_TICK_MINUTES = 5;
/** The human-approve enqueue priority (the bot panel's constant). */
export const HUMAN_PUBLISH_PRIORITY_SCORE = 80;
/** Queue/draft list caps (the stores' own bounds). */
const QUEUE_LIMIT = 25;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface WebPanelAiFlags {
  readonly aiEnabled: boolean;
  readonly geminiEnabled: boolean;
  readonly imageEnabled: boolean;
  readonly failoverEnabled: boolean;
  readonly geminiRewriteEnabled: boolean;
  readonly eventRelationEnabled: boolean;
}

export interface WebPanelBuildInfo {
  readonly version: string;
  readonly commit: string;
  readonly schema: number;
}

export interface WebPanelServiceDeps {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  /** The publish destination (phase-2 target channel). Absent = the
   *  approve path honestly reports `no_destination`, never enqueues. */
  readonly channelChatId?: number | string;
  /** The Bot API transport. Absent (no BOT_TOKEN) = pin/unpin/delete/
   *  edit honestly report `transport_unavailable`. */
  readonly transport?: PostManagementTransport;
  /** The bootstrap owner id (server config) — the owner-protection
   *  guard for admin deactivation lives here, not in the store. */
  readonly ownerTelegramId: number;
  readonly adminManageEnabled: boolean;
  readonly aiFlags: WebPanelAiFlags;
  readonly buildInfo: WebPanelBuildInfo;
  readonly logger?: Logger;
}

export interface DashboardData {
  readonly mode: PublishMode;
  readonly cap: number;
  readonly effectiveCap: number;
  readonly eventActive: boolean;
  readonly eventStartedAtMs: number | null;
  readonly today: TodayCounts;
  readonly queue: { readonly readyDrafts: number; readonly pendingPublications: number };
  readonly totals: EditorialTotals;
  readonly soulVersion: number | null;
  readonly providers: { readonly enabled: number; readonly total: number };
  readonly lastChange: AuditEventRow | null;
  readonly nextTickInMinutes: number;
}

export interface DraftSummary {
  readonly id: string;
  readonly storyId: string;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly createdAt: number;
}

export interface PublicationSummary {
  readonly id: string;
  readonly draftId: string;
  readonly status: string;
  readonly priority: number;
  readonly runAfter: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly updatedAt: number;
}

export interface QueueData {
  readonly drafts: readonly DraftSummary[];
  readonly publications: readonly PublicationSummary[];
  readonly counts: { readonly ready: number; readonly pending: number };
}

export interface DraftPreview {
  readonly id: string;
  readonly storyId: string;
  readonly status: string;
  readonly createdAt: number;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly sourceName: string | null;
  readonly excerpt: string | null;
  readonly claims: readonly { readonly text: string; readonly status: string }[];
  readonly figures: readonly unknown[] | null;
  readonly quote: { readonly text: string; readonly attribution: string | null } | null;
  readonly verdict: string | null;
  readonly gameName: string | null;
  readonly soulForm: { readonly categoryEmoji: string; readonly trustLabel: string } | null;
  readonly rewriteStatus: string | null;
}

export interface PostsData {
  readonly posts: readonly ChannelPostListRow[];
  readonly activePin: { readonly channelMessageId: number } | null;
  readonly autoPinEnabled: boolean;
  readonly retention: RetentionRule;
}

export interface ScheduleData {
  readonly mode: PublishMode;
  readonly cap: number;
  readonly effectiveCap: number;
  readonly eventActive: boolean;
  readonly eventStartedAtMs: number | null;
  readonly today: TodayCounts;
  readonly cancellable: number;
  readonly nextTickInMinutes: number;
}

export interface SoulData {
  readonly soulVersion: number | null;
  readonly soulText: string | null;
  readonly aiToday: readonly AiRunsByProviderRow[];
  readonly aiAllTime: readonly AiRunsByProviderRow[];
  readonly flags: WebPanelAiFlags;
}

export interface SettingsData {
  readonly mode: PublishMode;
  readonly cap: number;
  readonly effectiveCap: number;
  readonly eventActive: boolean;
  readonly today: TodayCounts;
  readonly flags: WebPanelAiFlags;
  readonly adminManageEnabled: boolean;
  readonly totals: EditorialTotals;
}

export interface StatsData {
  readonly totals: EditorialTotals;
  readonly draftsByStatus: DraftStatusCounts;
  readonly publicationsByStatus: PublicationStatusCounts;
  readonly aiAllTime: readonly AiRunsByProviderRow[];
  readonly providers: { readonly enabled: number; readonly total: number };
}

export interface AdminsData {
  readonly admins: readonly AdminManageRow[];
  readonly manageEnabled: boolean;
}

export interface ProvidersData {
  readonly providers: readonly ProviderHealthRow[];
  /** Healthy = enabled, has a recorded success, zero consecutive
   *  failures. Counted over the ENABLED set (a disabled source is not
   *  "unhealthy", it is off). */
  readonly healthy: number;
  readonly enabled: number;
  readonly total: number;
}

export interface ManualData {
  readonly providers: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly readyCount: number;
  }[];
  readonly categories: readonly { readonly contentType: string; readonly count: number }[];
}

export interface DebugData {
  readonly build: WebPanelBuildInfo;
  readonly flags: WebPanelAiFlags;
  readonly adminManageEnabled: boolean;
  readonly mode: PublishMode;
  readonly totals: EditorialTotals;
  readonly lastChange: AuditEventRow | null;
}

export type ApproveDraftOutcome =
  | { readonly kind: 'approved'; readonly publicationId: string; readonly alreadyApproved: boolean }
  | { readonly kind: 'denied' }
  | { readonly kind: 'no_destination' }
  | { readonly kind: 'draft_not_found' }
  | { readonly kind: 'not_ready' }
  | { readonly kind: 'enqueue_failed' };

export type RejectDraftOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'already_rejected' }
  | { readonly kind: 'draft_not_found' }
  | { readonly kind: 'not_ready' };

export type CancelPublicationOutcome =
  | { readonly kind: 'applied'; readonly priorStatus: string }
  | { readonly kind: 'denied' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_cancellable'; readonly status: string };

export type SetModeOutcome =
  | { readonly kind: 'applied'; readonly priorMode: PublishMode }
  | { readonly kind: 'denied' }
  | { readonly kind: 'no_change'; readonly mode: PublishMode }
  | { readonly kind: 'invalid' };

export type SetCapOutcome =
  | { readonly kind: 'applied'; readonly effectiveFrom: string }
  | { readonly kind: 'denied' }
  | { readonly kind: 'no_change'; readonly cap: number }
  | { readonly kind: 'invalid' };

export type SetEventOutcome =
  | { readonly kind: 'applied'; readonly active: boolean }
  | { readonly kind: 'denied' }
  | { readonly kind: 'no_change'; readonly active: boolean };

export type SetProviderEnabledOutcome =
  | { readonly kind: 'applied'; readonly enabled: boolean }
  | { readonly kind: 'denied' }
  | { readonly kind: 'no_change'; readonly enabled: boolean }
  | { readonly kind: 'not_found' };

export type AddAdminOutcome =
  | { readonly kind: 'applied'; readonly reactivated: boolean }
  | { readonly kind: 'denied' }
  | { readonly kind: 'manage_disabled' }
  | { readonly kind: 'already_active' }
  | { readonly kind: 'invalid_role' };

export type RemoveAdminOutcome =
  | { readonly kind: 'applied'; readonly priorRole: AdminRole }
  | { readonly kind: 'denied' }
  | { readonly kind: 'manage_disabled' }
  | { readonly kind: 'owner_protected' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_disabled' };

export interface WebPanelService {
  getDashboard(): Promise<DashboardData>;
  getQueue(): Promise<QueueData>;
  getDraftPreview(draftId: string): Promise<DraftPreview | null>;
  approveDraft(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly draftId: string;
  }): Promise<ApproveDraftOutcome>;
  rejectDraft(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly draftId: string;
  }): Promise<RejectDraftOutcome>;
  cancelPublication(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly publicationId: string;
  }): Promise<CancelPublicationOutcome>;
  clearQueue(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
  }): Promise<
    { readonly kind: 'applied'; readonly cancelled: number } | { readonly kind: 'denied' }
  >;
  getPosts(input: {
    readonly status?: 'all' | 'published' | 'expired';
    readonly category?: string;
  }): Promise<PostsData>;
  pinPost(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly refType: ChannelPostRefType;
    readonly refId: string;
    readonly channelMessageId: number;
  }): Promise<
    | { readonly kind: 'pinned'; readonly releasedPrevious: boolean }
    | { readonly kind: 'already_pinned' }
    | { readonly kind: 'pin_failed' }
    | { readonly kind: 'transport_unavailable' }
    | { readonly kind: 'no_destination' }
    | { readonly kind: 'denied' }
  >;
  unpinPost(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly channelMessageId: number;
  }): Promise<
    | { readonly kind: 'unpinned' }
    | { readonly kind: 'not_pinned' }
    | { readonly kind: 'unpin_failed' }
    | { readonly kind: 'transport_unavailable' }
    | { readonly kind: 'no_destination' }
    | { readonly kind: 'denied' }
  >;
  deletePost(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly refType: ChannelPostRefType;
    readonly refId: string;
    readonly channelMessageId: number;
  }): Promise<
    | { readonly kind: 'deleted' }
    | { readonly kind: 'delete_failed' }
    | { readonly kind: 'transport_unavailable' }
    | { readonly kind: 'no_destination' }
    | { readonly kind: 'denied' }
  >;
  editPost(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly refType: ChannelPostRefType;
    readonly refId: string;
    readonly channelMessageId: number;
    readonly text: string;
  }): Promise<
    | { readonly kind: 'edited' }
    | { readonly kind: 'no_capture' }
    | { readonly kind: 'invalid_text' }
    | { readonly kind: 'edit_failed' }
    | { readonly kind: 'edit_failed_retryable' }
    | { readonly kind: 'transport_unavailable' }
    | { readonly kind: 'no_destination' }
    | { readonly kind: 'denied' }
  >;
  setAutoPin(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly enabled: boolean;
  }): Promise<
    | { readonly kind: 'applied'; readonly enabled: boolean }
    | { readonly kind: 'no_change'; readonly enabled: boolean }
    | { readonly kind: 'no_destination' }
    | { readonly kind: 'denied' }
  >;
  setRetention(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly rule: RetentionRule;
  }): Promise<
    | { readonly kind: 'applied'; readonly rule: RetentionRule }
    | { readonly kind: 'no_change'; readonly rule: RetentionRule }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'no_destination' }
    | { readonly kind: 'denied' }
  >;
  getSchedule(): Promise<ScheduleData>;
  setMode(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly mode: unknown;
  }): Promise<SetModeOutcome>;
  setCap(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly cap: unknown;
  }): Promise<SetCapOutcome>;
  setEvent(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly active: boolean;
  }): Promise<SetEventOutcome>;
  getSoul(): Promise<SoulData>;
  getSettings(): Promise<SettingsData>;
  getStats(): Promise<StatsData>;
  getAdmins(): Promise<AdminsData>;
  addAdmin(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly targetUserId: number;
    readonly targetRole: unknown;
  }): Promise<AddAdminOutcome>;
  removeAdmin(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly targetUserId: number;
  }): Promise<RemoveAdminOutcome>;
  getProviders(): Promise<ProvidersData>;
  setProviderEnabled(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly sourceId: string;
    readonly enabled: boolean;
  }): Promise<SetProviderEnabledOutcome>;
  getManual(): Promise<ManualData>;
  getDebug(): Promise<DebugData>;
}

const ADMIN_ROLES: readonly AdminRole[] = ['owner', 'chief_editor', 'source_manager', 'reviewer'];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

function tehranDayStartMs(nowMs: number): number {
  return nowMs - (MS_PER_DAY - msUntilNextTehranMidnight(nowMs));
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a stored draft document defensively. Every field is validated
 * for type; anything malformed reads as null. The structured
 * `figures` / `quote` / `verdict` / `gameName` fields are the PR-B
 * renderer fields — absent on today's drafts, and the preview says so
 * instead of deriving them (the derivation that produced "برای PS: 5"
 * is deleted by the content track, never re-implemented here).
 */
export function parseDraftDocument(
  documentJson: string,
): Omit<DraftPreview, 'id' | 'storyId' | 'status' | 'createdAt'> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(documentJson);
  } catch {
    parsed = null;
  }
  const doc = asObject(parsed) ?? {};
  const headline = asNonEmptyString(doc.headlineFa);
  const summary = asNonEmptyString(doc.summaryFa);
  const sourceReport = asObject(doc.sourceReport);
  const sourceName = sourceReport === null ? null : asNonEmptyString(sourceReport.sourceName);
  const excerpt = sourceReport === null ? null : asNonEmptyString(sourceReport.excerptText);
  const claims: { readonly text: string; readonly status: string }[] = [];
  if (Array.isArray(doc.modelClaims)) {
    for (const claim of doc.modelClaims.slice(0, 32)) {
      const claimObject = asObject(claim);
      if (claimObject === null) {
        continue;
      }
      const text = asNonEmptyString(claimObject.text);
      if (text === null) {
        continue;
      }
      claims.push({
        text,
        status: asNonEmptyString(claimObject.status) ?? 'unverified',
      });
    }
  }
  const figures =
    Array.isArray(doc.figures) && doc.figures.length > 0 ? doc.figures.slice(0, 8) : null;
  const quoteObject = asObject(doc.quote);
  const quoteText =
    quoteObject === null ? asNonEmptyString(doc.quote) : asNonEmptyString(quoteObject.text);
  const quote =
    quoteText === null
      ? null
      : {
          text: quoteText,
          attribution: quoteObject === null ? null : asNonEmptyString(quoteObject.attribution),
        };
  const soulFormObject = asObject(doc.soulForm);
  const soulForm =
    soulFormObject === null
      ? null
      : asNonEmptyString(soulFormObject.categoryEmoji) !== null &&
          asNonEmptyString(soulFormObject.trustLabel) !== null
        ? {
            categoryEmoji: asNonEmptyString(soulFormObject.categoryEmoji) as string,
            trustLabel: asNonEmptyString(soulFormObject.trustLabel) as string,
          }
        : null;
  const rewriteObject = asObject(doc.rewrite);
  return {
    headline,
    summary,
    sourceName,
    excerpt,
    claims,
    figures,
    quote,
    verdict: asNonEmptyString(doc.verdict),
    gameName: asNonEmptyString(doc.gameName),
    soulForm,
    rewriteStatus: rewriteObject === null ? null : asNonEmptyString(rewriteObject.status),
  };
}

export function createWebPanelService(deps: WebPanelServiceDeps): WebPanelService {
  const {
    executor,
    clock,
    channelChatId,
    transport,
    ownerTelegramId,
    adminManageEnabled,
    aiFlags,
    buildInfo,
  } = deps;

  // The post-management service is built exactly as the webhook builds
  // it (same transport, same channel) — pin/unpin/delete/edit/auto-pin/
  // retention are the SAME operations, not web-only copies. Without a
  // channel there is no destination to act on; without a transport the
  // service reports honestly unavailable.
  const postManagement =
    channelChatId === undefined
      ? undefined
      : createPostManagementService({
          executor,
          clock,
          channelChatId,
          transport,
          logger: deps.logger,
        });

  async function lastChange(): Promise<AuditEventRow | null> {
    const events = await listRecentAuditEvents(executor, { limit: 1 });
    return events[0] ?? null;
  }

  async function providerSummary(): Promise<{ readonly enabled: number; readonly total: number }> {
    const providers = await listProvidersWithHealth(executor);
    return {
      enabled: providers.filter((provider) => provider.enabled).length,
      total: providers.length,
    };
  }

  return {
    async getDashboard(): Promise<DashboardData> {
      const nowMs = clock.now();
      const [
        settings,
        today,
        draftCounts,
        publicationCounts,
        totals,
        soulVersion,
        providers,
        change,
      ] = await Promise.all([
        readPublishingSettings(executor),
        readTodayCounts(executor, { nowMs }),
        countDraftsByStatus(executor),
        countPublicationsByStatus(executor),
        countEditorialTotals(executor),
        getCurrentSoulVersion(executor),
        providerSummary(),
        lastChange(),
      ]);
      return {
        mode: settings.mode,
        cap: settings.cap.cap,
        effectiveCap: effectiveDailyCap(settings.cap, today.tehranDate),
        eventActive: settings.event?.active ?? false,
        eventStartedAtMs: settings.event?.active === true ? settings.event.startedAtMs : null,
        today,
        queue: { readyDrafts: draftCounts.ready, pendingPublications: publicationCounts.pending },
        totals,
        soulVersion,
        providers,
        lastChange: change,
        nextTickInMinutes: WEB_PANEL_NEXT_TICK_MINUTES,
      };
    },

    async getQueue(): Promise<QueueData> {
      const [drafts, publications, draftCounts, publicationCounts] = await Promise.all([
        listReadyDrafts(executor, { limit: QUEUE_LIMIT }),
        listCancellablePublications(executor, { limit: QUEUE_LIMIT }),
        countDraftsByStatus(executor),
        countPublicationsByStatus(executor),
      ]);
      return {
        drafts: drafts.map((draft) => {
          const parsed = parseDraftDocument(draft.document_json);
          return {
            id: draft.id,
            storyId: draft.story_id,
            headline: parsed.headline,
            summary: parsed.summary,
            createdAt: draft.created_at,
          };
        }),
        publications: publications.map((publication) => ({
          id: publication.id,
          draftId: publication.draft_id,
          status: publication.status,
          priority: publication.priority,
          runAfter: publication.run_after,
          attempts: publication.attempts,
          maxAttempts: publication.max_attempts,
          updatedAt: publication.updated_at,
        })),
        counts: { ready: draftCounts.ready, pending: publicationCounts.pending },
      };
    },

    async getDraftPreview(draftId: string): Promise<DraftPreview | null> {
      const draft = await getDraftById(executor, draftId);
      if (draft === null) {
        return null;
      }
      return {
        id: draft.id,
        storyId: draft.story_id,
        status: draft.status,
        createdAt: draft.created_at,
        ...parseDraftDocument(draft.document_json),
      };
    },

    async approveDraft(input): Promise<ApproveDraftOutcome> {
      if (!roleHasPermission(input.role, 'draft.approve')) {
        return { kind: 'denied' };
      }
      if (channelChatId === undefined) {
        return { kind: 'no_destination' };
      }
      const nowMs = clock.now();
      // The bot panel's approve path, step for step (admin-panel-service):
      // fenced transition first, then the enqueue — applied OR
      // already_approved both enqueue (a retry after a failed enqueue
      // must not re-decide the draft).
      const approval = await approveDraftForHumanPublication(executor, {
        draftId: input.draftId,
        actorId: input.telegramUserId,
        nowMs,
      });
      if (approval.kind === 'draft_not_found') {
        return { kind: 'draft_not_found' };
      }
      if (approval.kind === 'not_ready') {
        return { kind: 'not_ready' };
      }
      const settings = await readPublishingSettings(executor);
      const soulVersion = await getCurrentSoulVersion(executor);
      const approvalMode =
        settings.mode === 'approval'
          ? 'approval'
          : settings.mode === 'safe-auto'
            ? 'safe_auto'
            : 'auto';
      const outcome = await enqueuePublication(executor, {
        publicationId: `pub:human:${input.draftId}`,
        draftId: input.draftId,
        destination: String(channelChatId),
        priorityScore: HUMAN_PUBLISH_PRIORITY_SCORE,
        approvalMode,
        nowMs,
        soulVersion,
      });
      if (outcome.kind === 'created' || outcome.kind === 'duplicate') {
        return {
          kind: 'approved',
          publicationId: outcome.publicationId,
          alreadyApproved: approval.kind === 'already_approved',
        };
      }
      // The draft stays `approved` — the next Approve tap retries the
      // enqueue alone (the transition absorbs as already_approved).
      return { kind: 'enqueue_failed' };
    },

    async rejectDraft(input): Promise<RejectDraftOutcome> {
      if (!roleHasPermission(input.role, 'draft.reject')) {
        return { kind: 'denied' };
      }
      const outcome = await rejectDraftForHumanPublication(executor, {
        draftId: input.draftId,
        actorId: input.telegramUserId,
        nowMs: clock.now(),
      });
      return outcome;
    },

    async cancelPublication(input): Promise<CancelPublicationOutcome> {
      if (!roleHasPermission(input.role, 'publication.cancel')) {
        return { kind: 'denied' };
      }
      return await cancelPublicationById(executor, {
        publicationId: input.publicationId,
        actorId: String(input.telegramUserId),
        nowMs: clock.now(),
      });
    },

    async clearQueue(
      input,
    ): Promise<
      { readonly kind: 'applied'; readonly cancelled: number } | { readonly kind: 'denied' }
    > {
      if (!roleHasPermission(input.role, 'publication.cancel')) {
        return { kind: 'denied' };
      }
      const nowMs = clock.now();
      const cancellable = await listCancellablePublications(executor, { limit: QUEUE_LIMIT });
      let cancelled = 0;
      for (const publication of cancellable) {
        const outcome = await cancelPublicationById(executor, {
          publicationId: publication.id,
          actorId: String(input.telegramUserId),
          nowMs,
        });
        if (outcome.kind === 'applied') {
          cancelled += 1;
        }
      }
      return { kind: 'applied', cancelled };
    },

    async getPosts(input): Promise<PostsData> {
      const nowMs = clock.now();
      const [posts, activePin, settings] = await Promise.all([
        listChannelPosts(executor, {
          limit: QUEUE_LIMIT,
          nowMs,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
        }),
        getActivePin(executor),
        readPostManagementSettings(executor),
      ]);
      return {
        posts,
        activePin: activePin === null ? null : { channelMessageId: activePin.channelMessageId },
        autoPinEnabled: settings.autoPinP0Enabled,
        retention: settings.retention,
      };
    },

    async pinPost(input) {
      if (postManagement === undefined) {
        return { kind: 'no_destination' as const };
      }
      return await postManagement.pinPost({
        telegramUserId: input.telegramUserId,
        role: input.role,
        refType: input.refType,
        refId: input.refId,
        channelMessageId: input.channelMessageId,
      });
    },

    async unpinPost(input) {
      if (postManagement === undefined) {
        return { kind: 'no_destination' as const };
      }
      return await postManagement.unpinPost({
        telegramUserId: input.telegramUserId,
        role: input.role,
        channelMessageId: input.channelMessageId,
      });
    },

    async deletePost(input) {
      if (postManagement === undefined) {
        return { kind: 'no_destination' as const };
      }
      return await postManagement.deletePost({
        telegramUserId: input.telegramUserId,
        role: input.role,
        refType: input.refType,
        refId: input.refId,
        channelMessageId: input.channelMessageId,
      });
    },

    async editPost(input) {
      if (postManagement === undefined) {
        return { kind: 'no_destination' as const };
      }
      // The bot's edit is a two-step conversation (startEdit opens a
      // capture, the admin sends the new text, completeEdit applies it).
      // The web collects the text up front, so both steps run in one
      // call — same engine, same fence, no second path.
      const started = await postManagement.startEdit({
        telegramUserId: input.telegramUserId,
        role: input.role,
        refType: input.refType,
        refId: input.refId,
        channelMessageId: input.channelMessageId,
      });
      if (started.kind === 'denied') {
        return { kind: 'denied' as const };
      }
      return await postManagement.completeEdit({
        telegramUserId: input.telegramUserId,
        role: input.role,
        text: input.text,
      });
    },

    async setAutoPin(input) {
      if (postManagement === undefined) {
        return { kind: 'no_destination' as const };
      }
      return await postManagement.setAutoPin({
        telegramUserId: input.telegramUserId,
        role: input.role,
        enabled: input.enabled,
      });
    },

    async setRetention(input) {
      if (postManagement === undefined) {
        return { kind: 'no_destination' as const };
      }
      return await postManagement.setRetention({
        telegramUserId: input.telegramUserId,
        role: input.role,
        rule: input.rule,
      });
    },

    async getSchedule(): Promise<ScheduleData> {
      const nowMs = clock.now();
      const [settings, today, cancellable] = await Promise.all([
        readPublishingSettings(executor),
        readTodayCounts(executor, { nowMs }),
        listCancellablePublications(executor, { limit: 1 }),
      ]);
      return {
        mode: settings.mode,
        cap: settings.cap.cap,
        effectiveCap: effectiveDailyCap(settings.cap, today.tehranDate),
        eventActive: settings.event?.active ?? false,
        eventStartedAtMs: settings.event?.active === true ? settings.event.startedAtMs : null,
        today,
        cancellable: cancellable.length,
        nextTickInMinutes: WEB_PANEL_NEXT_TICK_MINUTES,
      };
    },

    async setMode(input): Promise<SetModeOutcome> {
      if (!roleHasPermission(input.role, 'settings.editorial')) {
        return { kind: 'denied' };
      }
      if (typeof input.mode !== 'string' || !isPublishMode(input.mode)) {
        return { kind: 'invalid' };
      }
      return await setPublishMode(executor, {
        mode: input.mode,
        actorId: input.telegramUserId,
        nowMs: clock.now(),
      });
    },

    async setCap(input): Promise<SetCapOutcome> {
      if (!roleHasPermission(input.role, 'settings.editorial')) {
        return { kind: 'denied' };
      }
      if (typeof input.cap !== 'number' || !Number.isInteger(input.cap)) {
        return { kind: 'invalid' };
      }
      const outcome = await setDailyCap(executor, {
        cap: input.cap,
        actorId: input.telegramUserId,
        nowMs: clock.now(),
      });
      if (outcome.kind === 'applied') {
        return { kind: 'applied', effectiveFrom: outcome.effectiveFrom };
      }
      return outcome;
    },

    async setEvent(input): Promise<SetEventOutcome> {
      if (!roleHasPermission(input.role, 'settings.editorial')) {
        return { kind: 'denied' };
      }
      return await setEventMode(executor, {
        active: input.active,
        trigger: 'manual',
        actorId: input.telegramUserId,
        nowMs: clock.now(),
      });
    },

    async getSoul(): Promise<SoulData> {
      const nowMs = clock.now();
      const [soulVersion, aiToday, aiAllTime] = await Promise.all([
        getCurrentSoulVersion(executor),
        countAiRunsByProvider(executor, { sinceMs: tehranDayStartMs(nowMs) }),
        countAiRunsByProvider(executor, {}),
      ]);
      const soulText = soulVersion === null ? null : await getSoulText(executor, soulVersion);
      return { soulVersion, soulText, aiToday, aiAllTime, flags: aiFlags };
    },

    async getSettings(): Promise<SettingsData> {
      const nowMs = clock.now();
      const [settings, today, totals] = await Promise.all([
        readPublishingSettings(executor),
        readTodayCounts(executor, { nowMs }),
        countEditorialTotals(executor),
      ]);
      return {
        mode: settings.mode,
        cap: settings.cap.cap,
        effectiveCap: effectiveDailyCap(settings.cap, today.tehranDate),
        eventActive: settings.event?.active ?? false,
        today,
        flags: aiFlags,
        adminManageEnabled,
        totals,
      };
    },

    async getStats(): Promise<StatsData> {
      const [totals, draftsByStatus, publicationsByStatus, aiAllTime, providers] =
        await Promise.all([
          countEditorialTotals(executor),
          countDraftsByStatus(executor),
          countPublicationsByStatus(executor),
          countAiRunsByProvider(executor, {}),
          providerSummary(),
        ]);
      return { totals, draftsByStatus, publicationsByStatus, aiAllTime, providers };
    },

    async getAdmins(): Promise<AdminsData> {
      const admins = await listAdmins(executor);
      return { admins, manageEnabled: adminManageEnabled };
    },

    async addAdmin(input): Promise<AddAdminOutcome> {
      if (input.role !== 'owner') {
        return { kind: 'denied' };
      }
      if (!adminManageEnabled) {
        return { kind: 'manage_disabled' };
      }
      if (!isAdminRole(input.targetRole)) {
        return { kind: 'invalid_role' };
      }
      // The store's audit id is `admin-manage:<token>` — one
      // confirmation audits at most once. The web mints a fresh token
      // per confirmed action (the bot flow mints one per confirm
      // screen); the token is a nonce, never a secret.
      const outcome = await applyAdminAdd(executor, {
        targetUserId: input.targetUserId,
        role: input.targetRole,
        actorId: String(input.telegramUserId),
        token: randomToken(),
        nowMs: clock.now(),
      });
      return outcome;
    },

    async removeAdmin(input): Promise<RemoveAdminOutcome> {
      if (input.role !== 'owner') {
        return { kind: 'denied' };
      }
      if (!adminManageEnabled) {
        return { kind: 'manage_disabled' };
      }
      // Owner protection is enforced by the SERVICE (the store's
      // contract): the bootstrap owner can never deactivate themselves.
      if (input.targetUserId === ownerTelegramId) {
        return { kind: 'owner_protected' };
      }
      return await applyAdminDeactivate(executor, {
        targetUserId: input.targetUserId,
        actorId: String(input.telegramUserId),
        token: randomToken(),
        nowMs: clock.now(),
      });
    },

    async getProviders(): Promise<ProvidersData> {
      const providers = await listProvidersWithHealth(executor);
      const enabled = providers.filter((provider) => provider.enabled);
      return {
        providers,
        healthy: enabled.filter(
          (provider) => provider.lastSuccessAt !== null && provider.consecutiveFailures === 0,
        ).length,
        enabled: enabled.length,
        total: providers.length,
      };
    },

    async setProviderEnabled(input): Promise<SetProviderEnabledOutcome> {
      if (!roleHasPermission(input.role, 'source.manage')) {
        return { kind: 'denied' };
      }
      return await setSourceEnabled(executor, {
        sourceId: input.sourceId,
        enabled: input.enabled,
        actorId: input.telegramUserId,
        nowMs: clock.now(),
      });
    },

    async getManual(): Promise<ManualData> {
      const [providers, categories] = await Promise.all([
        listProvidersWithHealth(executor),
        countReadyDraftsByContentType(executor),
      ]);
      return {
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          readyCount: provider.readyCount,
        })),
        categories: categories.map((category) => ({
          contentType: category.contentType,
          count: category.count,
        })),
      };
    },

    async getDebug(): Promise<DebugData> {
      const [settings, totals, change] = await Promise.all([
        readPublishingSettings(executor),
        countEditorialTotals(executor),
        lastChange(),
      ]);
      return {
        build: buildInfo,
        flags: aiFlags,
        adminManageEnabled,
        mode: settings.mode,
        totals,
        lastChange: change,
      };
    },
  };
}
