/**
 * Combined admin panel (ADR-0075) — the Telegram admin panel service
 * (`/menu`): the composition the ingress executes for the `panel_main` /
 * `panel_screen` router actions and for the `panel.*` token callbacks
 * (the Phase 9C shape: the router NEVER queries D1; the injected service
 * does).
 *
 * SCREENS (design `pixel-panel-combined-design.md` — the AI-admin +
 * Fredy combination, owner order 2026-11-28):
 * - main: Fredy dashboard (mode, today X of Y, event, pin, Soul, AI,
 *   worker) + the AI-admin rows + Fredy nav grid + the Approval toggle
 *   (mode approval ↔ auto) + Admins (owner only).
 * - mode / cap / event: kept from the old panel, unchanged behavior.
 * - schedule: posting on/off (mode auto ↔ paused), cap picker, window,
 *   next bridge tick, Clear queue (confirm → fenced per-row cancel).
 * - drafts: counts + top 5 ready drafts; per draft Preview (the
 *   read-only review render) / Approve (human approve + outbox enqueue)
 *   / Reject (terminal, audited) / Re-evaluate (honestly unavailable —
 *   the bridge fix owns that path).
 * - posts: slice 6 housekeeping, kept + extended (pin/unpin/edit/
 *   delete/auto-pin/retention).
 * - manual: how to send a post + pending inbound approvals (the
 *   inbound service's own approve/reject tokens) + recent owner posts.
 * - ai: AI & Soul — Soul version/persona, providers, failover, Test AI
 *   (honestly unavailable — no engine probe exists).
 * - settings / stats / admins (read-only while ADMIN_MANAGE_ENABLED is
 *   off) / debug / help.
 *
 * VIEWING is open to every authorized admin (all roles hold
 * `dashboard.view`); CHANGING mode/cap/event/queue is owner +
 * chief_editor ONLY (enforced here at callback time, defense in depth
 * behind the router); draft approve/reject check their own permissions
 * (`draft.approve` / `draft.reject` — the reviewer holds them too).
 * Other roles get the clear denial toast and NOTHING is written.
 *
 * CALLBACKS: every button carries a single-use, user-bound, expiring
 * token (10 min) through the Phase 2A machinery; the intent lives in
 * the token's server-side payload (never trusted from the callback).
 * Show buttons answer with a FRESH screen message (new tokens); set
 * buttons apply immediately and answer with a toast — the same shape as
 * the admin-manage confirm flow, minus the confirm step (a mode/cap/
 * event change is a reversible setting, and every change is audited).
 *
 * CHANNEL EDIT: Pixel has NO channel-edit toggle (no such setting
 * exists — the edit path is always on). The main screen shows it as a
 * status line ("always on"), never as a toggle. The Source toggle is
 * deliberately absent (PR #26).
 *
 * EVENT LAZY EXPIRY: there is no cron that owns event auto-off. Every
 * panel read (and every callback) settles the event first: a stored-
 * active event past either deadline is persisted as off WITH its
 * `settings.event_auto_off` audit event, and renders as off.
 *
 * The service NEVER sends anything itself: it only returns typed
 * reply/answer results for the ingress to deliver. Draft Approve
 * enqueues an outbox row (the existing engine path); the worker's
 * sender publishes it. No posts are sent by this slice.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import type { Clock } from '../../shared/time/clock';
import {
  checkPublishGate,
  expireEventMode,
  readPublishingSettings,
  readTodayCounts,
  setDailyCap,
  setEventMode,
  setPublishMode,
  triggerEventOnP0,
  type PublishGateCheck,
  type TodayCounts,
} from '../../adapters/db/publishing-settings-store';
import { consumeActionToken, issueActionToken } from '../../adapters/telegram/action-tokens';
import { ensureOwnerRow } from '../../adapters/db/admin-manage-store';
import { listAdmins } from '../../adapters/db/admin-manage-store';
import { formatCallbackData } from '../../admin/callback-tokens';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import {
  ADMIN_PANEL_STRINGS,
  type DraftQueueCounts,
  type PanelScreen,
} from '../../admin/panel-strings';
import {
  DEFAULT_DAILY_CAP,
  PUBLISH_MODES,
  canChangePublishingSettings,
  effectiveDailyCap,
  isPublishMode,
  isValidDailyCap,
  nextTehranDate,
  resolveEventState,
  tehranDateOf,
  type PublishMode,
} from '../../domain/publishing/publishing-settings';
import { roleHasPermission, type AdminRole } from '../../admin/roles';
import type { AdminUiLanguage } from '../../admin/ui-language';
import { randomToken } from '../../domain/admin-post/fingerprint';
import type { ChannelPinRow, ChannelPostListRow } from '../../adapters/db/post-management-store';
import type { PostManagementService } from '../publishing/post-management-service';
import type { ChannelPostRefType } from '../../domain/publishing/post-management';
import {
  countDraftsByStatus,
  countEditorialTotals,
  findDraftById,
  listReadyDrafts,
} from '../../adapters/db/editorial-store';
import {
  approveDraftForHumanPublication,
  rejectDraftForHumanPublication,
} from '../../adapters/db/human-approval-store';
import {
  listPendingInboundApprovals,
  listRecentPublishedPosts,
} from '../../adapters/db/inbound-store';
import { getCurrentSoulVersion, getSoulText } from '../../adapters/db/soul-store';
import {
  cancelPublicationById,
  countDuePublications,
  enqueuePublication,
  listCancellablePublications,
} from '../../adapters/db/publication-outbox-store';
import { AI_IMAGE_BUDGET_KEY, readAiBudget } from '../../adapters/db/ai-budget-store';
import { readFactGuardReport } from '../../domain/editorial/fact-guard';
import { INBOUND_APPROVE_ACTION, INBOUND_REJECT_ACTION } from '../inbound/inbound-pipeline-service';
import type { EditorialReviewService } from '../editorial/draft-review-view';

/** The permission every panel token carries (held by every admin role). */
export const ADMIN_PANEL_TOKEN_PERMISSION = 'dashboard.view';

/** Stable action descriptors stored in admin_action_tokens rows. */
export const ADMIN_PANEL_TOKEN_ACTIONS = {
  showMain: 'panel.show_main',
  showMode: 'panel.show_mode',
  showCap: 'panel.show_cap',
  showEvent: 'panel.show_event',
  showSchedule: 'panel.show_schedule',
  showDrafts: 'panel.show_drafts',
  showPosts: 'panel.show_posts',
  showManual: 'panel.show_manual',
  showAi: 'panel.show_ai',
  showSettings: 'panel.show_settings',
  showStats: 'panel.show_stats',
  showAdmins: 'panel.show_admins',
  showDebug: 'panel.show_debug',
  showHelp: 'panel.show_help',
  showDraft: 'panel.show_draft',
  showPost: 'panel.show_post',
  setMode: 'panel.set_mode',
  setCap: 'panel.set_cap',
  setEvent: 'panel.set_event',
  toggleApproval: 'panel.toggle_approval',
  clearQueueRequest: 'panel.clear_queue_request',
  clearQueueConfirm: 'panel.clear_queue_confirm',
  draftApprove: 'panel.draft_approve',
  draftReject: 'panel.draft_reject',
  draftReevaluate: 'panel.draft_reevaluate',
  testAi: 'panel.test_ai',
  pinPost: 'panel.pin_post',
  unpinPost: 'panel.unpin_post',
  deleteRequest: 'panel.delete_request',
  deleteConfirm: 'panel.delete_confirm',
  setAutoPin: 'panel.set_auto_pin',
  setRetention: 'panel.set_retention',
  startEdit: 'panel.start_edit',
} as const;

/** The bounded token TTL of the panel buttons. */
export const ADMIN_PANEL_TOKEN_TTL_MS = 10 * 60 * 1000;

/** The three cap presets on the cap screen (12 / 15 / 18). */
export const ADMIN_PANEL_CAP_PRESETS: readonly number[] = [12, 15, 18];

/**
 * Human-approved drafts queue at the auto lane's priority — the same
 * constant the bridge passes for its auto lane (AUTO_PUBLISH_PRIORITY_
 * SCORE, 80). A local copy on purpose: the panel must not import the
 * bridge's job machinery for one number.
 */
export const HUMAN_PUBLISH_PRIORITY_SCORE = 80;

/** The most ready drafts the Drafts screen lists (oldest first). */
export const ADMIN_PANEL_DRAFTS_LIST_LIMIT = 5;

/** The most pending inbound approvals the Manual screen lists. */
export const ADMIN_PANEL_MANUAL_PENDING_LIMIT = 5;

/** The most recent owner posts the Manual screen lists. */
export const ADMIN_PANEL_MANUAL_RECENT_LIMIT = 3;

export type AdminPanelButtons = readonly (readonly {
  readonly text: string;
  readonly callbackData: string;
}[])[];

export interface AdminPanelReplyResult {
  readonly kind: 'reply';
  readonly text: TelegramSafeHtml;
  readonly buttons?: AdminPanelButtons;
}

export interface AdminPanelCallbackResult {
  readonly kind: 'answer';
  readonly callbackText: string;
}

export interface AdminPanelService {
  main(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
  }): Promise<AdminPanelReplyResult>;

  screen(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly screen: Exclude<PanelScreen, 'main'>;
  }): Promise<AdminPanelReplyResult>;

  handleCallback(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly token: string;
  }): Promise<AdminPanelCallbackResult | AdminPanelReplyResult>;

  /**
   * The auto-trigger seam for a REAL P0 (a game reveal, a surprise
   * release): the future P0 detector calls this, never the panel. It
   * activates an inactive event (trigger `auto`) or refreshes the idle
   * clock of an active one. No post is sent here.
   */
  noteP0(input: { readonly nowMs: number }): Promise<{ readonly kind: 'activated' | 'refreshed' }>;

  /**
   * The read-only gate check for a publish path (no write): settings +
   * today's counts + the RESOLVED event state. The future publish path
   * asks this before sending; the panel itself never publishes.
   */
  gate(input: {
    readonly priority: 'normal' | 'p1' | 'p0';
    readonly nowMs: number;
  }): Promise<PublishGateCheck>;
}

/** One post reference, as carried by the panel's post tokens. */
export interface PanelPostRef {
  readonly refType: ChannelPostRefType;
  readonly refId: string;
  readonly channelMessageId: number;
}

/** The posts-screen filter (all vs expired-only). */
export type PanelPostsFilter = 'all' | 'expired';

/**
 * The worker's own build metadata, computed at the wiring site from the
 * SAME config the /version handler reads (APP_VERSION / APP_COMMIT /
 * schemaVersion). OPTIONAL: absent = the Stats/Debug screens say the
 * worker metadata is unavailable instead of inventing it.
 */
export interface AdminPanelWorkerInfo {
  readonly applicationVersion: string;
  readonly commit: string;
  readonly schemaVersion: number;
}

/**
 * The feature flags the Debug/AI screens display, computed at the wiring
 * site from the SAME parsed configs the worker already uses — booleans
 * and presence only, never secret values. OPTIONAL: absent = the screens
 * say the flags are unavailable instead of inventing them.
 */
export interface AdminPanelFeatureFlags {
  readonly adminPanelEnabled: boolean;
  readonly aiFailoverEnabled: boolean;
  readonly aiImageEnabled: boolean;
  readonly aiGeminiRewriteEnabled: boolean;
  readonly eventRelationEnabled: boolean;
  readonly backupTokenConfigured: boolean;
  readonly adminManageEnabled: boolean;
  readonly inboundEnabled: boolean;
}

type AdminPanelPayload =
  | { readonly op: 'show'; readonly screen: PanelScreen; readonly filter?: PanelPostsFilter }
  | { readonly op: 'show_draft'; readonly draftId: string }
  | ({ readonly op: 'show_post' } & PanelPostRef)
  | ({ readonly op: 'pin_post' } & PanelPostRef)
  | { readonly op: 'unpin_post'; readonly channelMessageId: number }
  | ({ readonly op: 'delete_request' } & PanelPostRef)
  | ({ readonly op: 'delete_confirm' } & PanelPostRef)
  | { readonly op: 'set_auto_pin'; readonly enabled: boolean }
  | { readonly op: 'set_retention'; readonly enabled: boolean }
  | ({ readonly op: 'start_edit' } & PanelPostRef)
  | { readonly op: 'set_mode'; readonly mode: PublishMode }
  | { readonly op: 'set_cap'; readonly cap: number }
  | { readonly op: 'set_event'; readonly active: boolean }
  | { readonly op: 'toggle_approval' }
  | { readonly op: 'clear_queue_request' }
  | { readonly op: 'clear_queue_confirm' }
  | { readonly op: 'draft_approve'; readonly draftId: string }
  | { readonly op: 'draft_reject'; readonly draftId: string }
  | { readonly op: 'draft_reevaluate'; readonly draftId: string }
  | { readonly op: 'test_ai' };

interface PanelState {
  readonly mode: PublishMode;
  readonly capInForce: number;
  readonly pendingCap: number | null;
  readonly pendingEffectiveFrom: string | null;
  readonly eventActive: boolean;
  readonly counts: TodayCounts;
  readonly tehranDate: string;
  readonly activePin: ChannelPinRow | null;
  readonly soulVersion: number | null;
  readonly soulPersonaLine: string | null;
}

function parsePostRef(record: Record<string, unknown>): PanelPostRef | null {
  const refType = record['refType'];
  const refId = record['refId'];
  const channelMessageId = record['channelMessageId'];
  if (
    (refType !== 'publication' && refType !== 'inbound') ||
    typeof refId !== 'string' ||
    refId.length === 0 ||
    typeof channelMessageId !== 'number' ||
    !Number.isSafeInteger(channelMessageId) ||
    channelMessageId <= 0
  ) {
    return null;
  }
  return { refType, refId, channelMessageId };
}

function parseDraftId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return null;
  }
  return value;
}

const PANEL_SCREENS: readonly PanelScreen[] = [
  'main',
  'mode',
  'cap',
  'event',
  'schedule',
  'drafts',
  'posts',
  'manual',
  'ai',
  'settings',
  'stats',
  'admins',
  'debug',
  'help',
];

function parsePayload(payloadJson: string): AdminPanelPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.op === 'show' && typeof record.screen === 'string') {
    const screen = record.screen;
    if ((PANEL_SCREENS as readonly string[]).includes(screen)) {
      const filter = record['filter'];
      if (filter !== undefined && filter !== 'all' && filter !== 'expired') {
        return null;
      }
      return {
        op: 'show',
        screen: screen as PanelScreen,
        ...(filter !== undefined ? { filter: filter as PanelPostsFilter } : {}),
      };
    }
    return null;
  }
  if (
    record.op === 'show_draft' ||
    record.op === 'draft_approve' ||
    record.op === 'draft_reject' ||
    record.op === 'draft_reevaluate'
  ) {
    const draftId = parseDraftId(record['draftId']);
    return draftId === null ? null : { op: record.op, draftId };
  }
  if (
    record.op === 'show_post' ||
    record.op === 'pin_post' ||
    record.op === 'delete_request' ||
    record.op === 'delete_confirm' ||
    record.op === 'start_edit'
  ) {
    const ref = parsePostRef(record);
    return ref === null ? null : { op: record.op, ...ref };
  }
  if (record.op === 'unpin_post' && typeof record['channelMessageId'] === 'number') {
    const channelMessageId = record['channelMessageId'];
    if (!Number.isSafeInteger(channelMessageId) || channelMessageId <= 0) {
      return null;
    }
    return { op: 'unpin_post', channelMessageId };
  }
  if (record.op === 'set_auto_pin' && typeof record['enabled'] === 'boolean') {
    return { op: 'set_auto_pin', enabled: record['enabled'] };
  }
  if (record.op === 'set_retention' && typeof record['enabled'] === 'boolean') {
    return { op: 'set_retention', enabled: record['enabled'] };
  }
  if (record.op === 'set_mode' && typeof record.mode === 'string' && isPublishMode(record.mode)) {
    return { op: 'set_mode', mode: record.mode };
  }
  if (record.op === 'set_cap' && typeof record.cap === 'number' && isValidDailyCap(record.cap)) {
    return { op: 'set_cap', cap: record.cap };
  }
  if (record.op === 'set_event' && typeof record.active === 'boolean') {
    return { op: 'set_event', active: record.active };
  }
  if (
    record.op === 'toggle_approval' ||
    record.op === 'clear_queue_request' ||
    record.op === 'clear_queue_confirm' ||
    record.op === 'test_ai'
  ) {
    return { op: record.op };
  }
  return null;
}

/**
 * The presence slice (ai-policy-v2.3-era): per-provider AI presence
 * BOOLEANS surfaced in the admin panel ONLY. These are computed at the
 * wiring site with the SAME expressions the AI services already use
 * (`env.AI !== undefined`, `env.GEMINI_API_KEY !== undefined`, and the
 * validated `AI_GEMINI_ENABLED` flag) — NO new detection, NO secret
 * values, NO key material anywhere. Optional: without it the `ai` screen
 * answers honestly that presence is unavailable in this deployment.
 */
export interface AdminPanelAiPresence {
  /** The native Workers AI binding is present in the runtime. */
  readonly workersAiBindingPresent: boolean;
  /** A Gemini API key is configured (presence only — never the value). */
  readonly geminiApiKeyPresent: boolean;
  /** The validated AI_GEMINI_ENABLED operator flag. */
  readonly geminiEnabled: boolean;
}

/** Truncate by code points (never split a surrogate pair / emoji). */
function truncateText(text: string, maxChars: number): string {
  const points = [...text];
  return points.length <= maxChars ? text : `${points.slice(0, maxChars).join('')}…`;
}

/** The draft document's headline, or null when absent/malformed. */
function readDraftHeadline(documentJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const headline = (parsed as Record<string, unknown>)['headlineFa'];
  return typeof headline === 'string' && headline.length > 0 ? headline : null;
}

/** The stored fact-guard number-findings count, or null when absent. */
function readDraftFindings(documentJson: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson) as unknown;
  } catch {
    return null;
  }
  const read = readFactGuardReport(parsed);
  return read.kind === 'fact_guard_v1' ? read.report.counts.numberFindings : null;
}

/** The first text part of a stored inbound approval, or null. */
function readInboundPreviewText(contentJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const parts = (parsed as Record<string, unknown>)['parts'];
  if (!Array.isArray(parts) || parts.length === 0) {
    return null;
  }
  const first = parts[0];
  if (typeof first !== 'object' || first === null) {
    return null;
  }
  const text = (first as Record<string, unknown>)['text'];
  return typeof text === 'string' && text.length > 0 ? text : null;
}

/** The first non-empty line of the Soul text, truncated — the persona line. */
function readSoulPersonaLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return truncateText(trimmed, 100);
    }
  }
  return null;
}

export function createAdminPanelService(deps: {
  readonly executor: DbExecutor;
  readonly clock: Clock;
  /** The bootstrap owner id (server config) — the protected identity. */
  readonly ownerTelegramId?: number;
  /**
   * Slice 6 — the post-management service behind the posts screens.
   * OPTIONAL: without it the posts screens answer "unavailable"
   * honestly and the mode/cap/event screens keep working untouched.
   */
  readonly postManagement?: PostManagementService;
  /**
   * The presence slice — the per-provider AI presence booleans, computed
   * at the wiring site. OPTIONAL: absent = the `ai` screen says so.
   */
  readonly aiPresence?: AdminPanelAiPresence;
  /**
   * Combined panel — the read-only editorial review service behind the
   * draft Preview. OPTIONAL: without it the draft detail shows its
   * compact line and says the preview is unavailable; Approve/Reject
   * keep working (they never needed the review service).
   */
  readonly editorialReview?: EditorialReviewService;
  /**
   * Combined panel — the worker's build metadata for Stats/Debug.
   * OPTIONAL: absent = the screens say it is unavailable.
   */
  readonly workerInfo?: AdminPanelWorkerInfo;
  /**
   * Combined panel — the feature flags for the AI/Debug screens.
   * OPTIONAL: absent = the screens say the flags are unavailable.
   */
  readonly featureFlags?: AdminPanelFeatureFlags;
  /**
   * Combined panel — the publish destination (TARGET_CHANNEL) for the
   * draft Approve enqueue. OPTIONAL: absent = Approve answers honestly
   * that no destination is configured and writes nothing.
   */
  readonly publishDestination?: string;
}): AdminPanelService {
  const {
    executor,
    clock,
    ownerTelegramId,
    postManagement,
    aiPresence,
    editorialReview,
    workerInfo,
    featureFlags,
    publishDestination,
  } = deps;

  /**
   * Settle the event's lazy expiry BEFORE any read or callback: a
   * stored-active event past either deadline is persisted as off (with
   * its audit event) so the stored record, the render, and the gate all
   * agree the event ended.
   */
  async function settleEvent(nowMs: number): Promise<void> {
    const settings = await readPublishingSettings(executor);
    const resolved = resolveEventState(settings.event, nowMs);
    if (!resolved.active && resolved.ended !== 'off') {
      await expireEventMode(executor, { reason: resolved.ended, nowMs });
    }
  }

  async function loadState(nowMs: number): Promise<PanelState> {
    await settleEvent(nowMs);
    const settings = await readPublishingSettings(executor);
    const counts = await readTodayCounts(executor, { nowMs });
    const tehranDate = tehranDateOf(nowMs);
    const eventActive = resolveEventState(settings.event, nowMs).active;
    const capInForce = effectiveDailyCap(settings.cap, tehranDate);
    const pending =
      settings.cap.changedTehranDate === tehranDate && settings.cap.cap !== capInForce;
    const activePin = postManagement === undefined ? null : await postManagement.activePin();
    const soulVersion = await getCurrentSoulVersion(executor);
    const soulText = soulVersion === null ? null : await getSoulText(executor, soulVersion);
    return {
      mode: settings.mode,
      capInForce,
      pendingCap: pending ? settings.cap.cap : null,
      pendingEffectiveFrom: pending ? nextTehranDate(tehranDate) : null,
      eventActive,
      counts,
      tehranDate,
      activePin,
      soulVersion,
      soulPersonaLine: soulText === null ? null : readSoulPersonaLine(soulText),
    };
  }

  async function mintToken(input: {
    readonly telegramUserId: number;
    readonly action: string;
    readonly payload: AdminPanelPayload;
    readonly nowMs: number;
  }): Promise<string> {
    // The owner row must exist BEFORE any token bound to the owner is
    // issued (the admin_action_tokens foreign key). Idempotent — the
    // admin-manage-service discipline.
    if (ownerTelegramId !== undefined) {
      await ensureOwnerRow(executor, { ownerTelegramId, nowMs: input.nowMs });
    }
    const token = randomToken();
    await issueActionToken(executor, {
      token,
      telegramUserId: input.telegramUserId,
      permission: ADMIN_PANEL_TOKEN_PERMISSION,
      action: input.action,
      targetType: 'panel',
      targetId: input.payload.op === 'show' ? input.payload.screen : input.payload.op,
      payloadJson: JSON.stringify(input.payload),
      expiresAtMs: input.nowMs + ADMIN_PANEL_TOKEN_TTL_MS,
      nowMs: input.nowMs,
    });
    return token;
  }

  /**
   * Mint an INBOUND approve/reject token for a pending approval (the
   * Manual screen's buttons). The token carries the inbound service's
   * OWN action/permission/target — the ingress's action-aware dispatcher
   * hands it to the inbound service, never to this panel. The expiry is
   * the approval's own expiry (never longer than the 24h TTL the
   * inbound service minted at creation).
   */
  async function mintInboundToken(input: {
    readonly telegramUserId: number;
    readonly approvalId: string;
    readonly action: string;
    readonly permission: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): Promise<string> {
    if (ownerTelegramId !== undefined) {
      await ensureOwnerRow(executor, { ownerTelegramId, nowMs: input.nowMs });
    }
    const token = randomToken();
    await issueActionToken(executor, {
      token,
      telegramUserId: input.telegramUserId,
      permission: input.permission,
      action: input.action,
      targetType: 'inbound_approval',
      targetId: input.approvalId,
      payloadJson: JSON.stringify({ approvalId: input.approvalId }),
      expiresAtMs: input.expiresAtMs,
      nowMs: input.nowMs,
    });
    return token;
  }

  const SHOW_ACTIONS: Readonly<Record<PanelScreen, string>> = {
    main: ADMIN_PANEL_TOKEN_ACTIONS.showMain,
    mode: ADMIN_PANEL_TOKEN_ACTIONS.showMode,
    cap: ADMIN_PANEL_TOKEN_ACTIONS.showCap,
    event: ADMIN_PANEL_TOKEN_ACTIONS.showEvent,
    schedule: ADMIN_PANEL_TOKEN_ACTIONS.showSchedule,
    drafts: ADMIN_PANEL_TOKEN_ACTIONS.showDrafts,
    posts: ADMIN_PANEL_TOKEN_ACTIONS.showPosts,
    manual: ADMIN_PANEL_TOKEN_ACTIONS.showManual,
    ai: ADMIN_PANEL_TOKEN_ACTIONS.showAi,
    settings: ADMIN_PANEL_TOKEN_ACTIONS.showSettings,
    stats: ADMIN_PANEL_TOKEN_ACTIONS.showStats,
    admins: ADMIN_PANEL_TOKEN_ACTIONS.showAdmins,
    debug: ADMIN_PANEL_TOKEN_ACTIONS.showDebug,
    help: ADMIN_PANEL_TOKEN_ACTIONS.showHelp,
  };

  async function showButtons(input: {
    readonly telegramUserId: number;
    readonly screen: PanelScreen;
    readonly nowMs: number;
  }): Promise<string> {
    return mintToken({
      telegramUserId: input.telegramUserId,
      action: SHOW_ACTIONS[input.screen],
      payload: { op: 'show', screen: input.screen },
      nowMs: input.nowMs,
    });
  }

  function button(
    token: string,
    text: string,
  ): { readonly text: string; readonly callbackData: string } {
    return { text, callbackData: formatCallbackData(token) };
  }

  function modeEmoji(mode: PublishMode): string {
    if (mode === 'paused') {
      return '🔴';
    }
    if (mode === 'approval') {
      return '🟡';
    }
    return '🟢';
  }

  async function renderMain(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    // The "of cap" line counts CAP-CONSUMING publications only: owner-sent
    // inbound posts are visible in `published` but exempt from the cap
    // (slice 4), so they must never inflate the cap-usage display.
    const todayLine = state.eventActive
      ? `${s.mainTodayLabel} ${state.counts.published} published (cap lifted)`
      : `${s.mainTodayLabel} ${state.counts.counted} of ${state.capInForce} published`;
    const soulLine =
      state.soulVersion === null
        ? `${s.mainSoulLabel} ${s.soulUnavailable}`
        : `${s.mainSoulLabel} v${state.soulVersion} (${s.soulCurrent})`;
    const rewritePart =
      featureFlags === undefined
        ? null
        : featureFlags.aiGeminiRewriteEnabled
          ? 'Gemini rewrite ON'
          : 'Gemini rewrite OFF';
    const workersPart =
      aiPresence === undefined
        ? null
        : aiPresence.workersAiBindingPresent
          ? 'Workers AI ON'
          : 'Workers AI OFF';
    const aiValue =
      [rewritePart, workersPart].filter((part): part is string => part !== null).join(' · ') ||
      s.debugUnavailable;
    const workerLine =
      workerInfo === undefined
        ? `${s.mainWorkerLabel} ${s.debugUnavailable}`
        : `${s.mainWorkerLabel} ${workerInfo.applicationVersion} · schema ${workerInfo.schemaVersion}`;
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.mainTitle),
      escapeTelegramHtml(`${s.mainModeLabel} ${state.mode}`),
      escapeTelegramHtml(`${s.mainCapLabel} ${state.capInForce}`),
      escapeTelegramHtml(todayLine),
      escapeTelegramHtml(
        `${s.mainEventLabel} ${state.eventActive ? s.mainEventOn : s.mainEventOff}`,
      ),
      escapeTelegramHtml(
        `${s.mainPinLabel} ${state.activePin === null ? s.mainPinNone : `#${state.activePin.channelMessageId}`}`,
      ),
      escapeTelegramHtml(soulLine),
      escapeTelegramHtml(`${s.mainAiLabel} ${aiValue}`),
      escapeTelegramHtml(workerLine),
      escapeTelegramHtml(`${s.mainChannelEditLabel} ${s.mainChannelEditAlwaysOn}`),
    ];
    if (state.eventActive) {
      parts.push(escapeTelegramHtml(s.eventActiveLine));
    }
    if (state.pendingCap !== null && state.pendingEffectiveFrom !== null) {
      parts.push(
        escapeTelegramHtml(
          `${s.capPendingLabel} ${state.pendingCap} (${state.pendingEffectiveFrom})`,
        ),
      );
    }
    const [
      modeToken,
      scheduleToken,
      draftsToken,
      postsToken,
      aiToken,
      settingsToken,
      statsToken,
      manualToken,
      refreshToken,
      helpToken,
      approvalToken,
    ] = await Promise.all([
      showButtons({ telegramUserId: input.telegramUserId, screen: 'mode', nowMs: input.nowMs }),
      showButtons({
        telegramUserId: input.telegramUserId,
        screen: 'schedule',
        nowMs: input.nowMs,
      }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'drafts', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'posts', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'ai', nowMs: input.nowMs }),
      showButtons({
        telegramUserId: input.telegramUserId,
        screen: 'settings',
        nowMs: input.nowMs,
      }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'stats', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'manual', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'main', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'help', nowMs: input.nowMs }),
      mintToken({
        telegramUserId: input.telegramUserId,
        action: ADMIN_PANEL_TOKEN_ACTIONS.toggleApproval,
        payload: { op: 'toggle_approval' },
        nowMs: input.nowMs,
      }),
    ]);
    const adminsToken =
      input.role === 'owner'
        ? await showButtons({
            telegramUserId: input.telegramUserId,
            screen: 'admins',
            nowMs: input.nowMs,
          })
        : null;
    const buttons: AdminPanelButtons = [
      [button(modeToken, `${modeEmoji(state.mode)} ${s.modeButton}: ${state.mode}`)],
      [
        button(scheduleToken, s.scheduleButton),
        button(draftsToken, s.draftsButton),
        button(postsToken, s.postsButton),
      ],
      [
        button(aiToken, `🤖 ${s.aiSoulTitle}`),
        button(settingsToken, s.settingsButton),
        button(statsToken, s.statsButton),
      ],
      [
        button(manualToken, s.manualButton),
        button(refreshToken, s.refreshButton),
        button(helpToken, s.helpButton),
      ],
      [button(approvalToken, state.mode === 'approval' ? s.approvalOnButton : s.approvalOffButton)],
      ...(adminsToken !== null ? [[button(adminsToken, s.adminsButton)]] : []),
    ];
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons,
    };
  }

  async function renderMode(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const descriptions: Readonly<Record<PublishMode, string>> = {
      auto: s.modeAutoDesc,
      'safe-auto': s.modeSafeAutoDesc,
      approval: s.modeApprovalDesc,
      paused: s.modePausedDesc,
    };
    const parts: TelegramSafeHtml[] = [telegramBold(s.modeTitle)];
    for (const mode of PUBLISH_MODES) {
      const marker = mode === state.mode ? ` ${s.modeCurrentMarker}` : '';
      parts.push(escapeTelegramHtml(`${descriptions[mode]}${marker}`));
    }
    parts.push(escapeTelegramHtml(s.modeHint));
    const tokens = await Promise.all(
      PUBLISH_MODES.map((mode) =>
        mintToken({
          telegramUserId: input.telegramUserId,
          action: ADMIN_PANEL_TOKEN_ACTIONS.setMode,
          payload: { op: 'set_mode', mode },
          nowMs: input.nowMs,
        }),
      ),
    );
    const labels: Readonly<Record<PublishMode, string>> = {
      auto: 'auto',
      'safe-auto': 'safe-auto',
      approval: 'approval',
      paused: 'paused',
    };
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [button(tokens[0]!, labels.auto), button(tokens[1]!, labels['safe-auto'])],
        [button(tokens[2]!, labels.approval), button(tokens[3]!, labels.paused)],
      ],
    };
  }

  async function renderCap(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.capTitle),
      escapeTelegramHtml(`${s.capCurrentLabel} ${state.capInForce}`),
      escapeTelegramHtml(`${s.capTodayLabel} ${state.counts.counted} of ${state.capInForce}`),
    ];
    if (state.pendingCap !== null && state.pendingEffectiveFrom !== null) {
      parts.push(
        escapeTelegramHtml(
          `${s.capPendingLabel} ${state.pendingCap} (${state.pendingEffectiveFrom})`,
        ),
      );
    }
    parts.push(escapeTelegramHtml(s.capHint));
    const presetTokens = await Promise.all(
      ADMIN_PANEL_CAP_PRESETS.map((cap) =>
        mintToken({
          telegramUserId: input.telegramUserId,
          action: ADMIN_PANEL_TOKEN_ACTIONS.setCap,
          payload: { op: 'set_cap', cap },
          nowMs: input.nowMs,
        }),
      ),
    );
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        presetTokens.map((token, index) =>
          button(token, String(ADMIN_PANEL_CAP_PRESETS[index] ?? DEFAULT_DAILY_CAP)),
        ),
        [button(backToken, s.backButton)],
      ],
    };
  }

  async function renderEvent(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.eventTitle),
      escapeTelegramHtml(state.eventActive ? s.eventActiveLine : s.eventInactiveLine),
      escapeTelegramHtml(s.eventEndsLine),
      escapeTelegramHtml(s.eventHint),
    ];
    const toggleToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.setEvent,
      payload: { op: 'set_event', active: !state.eventActive },
      nowMs: input.nowMs,
    });
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [button(toggleToken, state.eventActive ? s.eventOffButton : s.eventOnButton)],
        [button(backToken, s.backButton)],
      ],
    };
  }

  /**
   * Schedule screen (design §4): the posting toggle (mode auto ↔
   * paused, the same store path as the Mode screen), the cap picker
   * link, the read-only window + next-tick lines, and Clear queue.
   * "Resume" always targets `auto` — the previous mode is not stored
   * anywhere, and auto is the documented default.
   */
  async function renderSchedule(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const postingOn = state.mode !== 'paused';
    const postingValue =
      state.mode === 'paused'
        ? s.schedulePostingOff
        : state.mode === 'auto'
          ? s.schedulePostingOn
          : `on (${state.mode})`;
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.scheduleTitle),
      escapeTelegramHtml(`${s.schedulePostingLabel} ${postingValue}`),
      escapeTelegramHtml(`${s.scheduleCapLabel} ${state.capInForce}`),
      escapeTelegramHtml(`${s.scheduleWindowLabel} ${s.scheduleWindowValue}`),
      escapeTelegramHtml(`${s.scheduleNextTickLabel} ${s.scheduleNextTickValue}`),
      escapeTelegramHtml(s.scheduleHint),
    ];
    const postingToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.setMode,
      payload: { op: 'set_mode', mode: postingOn ? 'paused' : 'auto' },
      nowMs: input.nowMs,
    });
    const capToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'cap',
      nowMs: input.nowMs,
    });
    const clearToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.clearQueueRequest,
      payload: { op: 'clear_queue_request' },
      nowMs: input.nowMs,
    });
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [button(postingToken, postingOn ? s.schedulePauseButton : s.scheduleResumeButton)],
        [button(capToken, `${s.capButton}: ${state.capInForce}`)],
        [button(clearToken, s.scheduleClearQueueButton)],
        [button(backToken, s.backButton)],
      ],
    };
  }

  /** Clear-queue confirm (design §4): the count is read live. */
  async function renderClearQueueConfirm(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const rows = await listCancellablePublications(executor, { limit: 64 });
    if (rows.length === 0) {
      return {
        kind: 'reply',
        text: composeTelegramHtml([
          telegramBold(s.clearQueueConfirmTitle),
          escapeTelegramHtml(s.callbackClearQueueEmpty),
        ]),
      };
    }
    const confirmToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.clearQueueConfirm,
      payload: { op: 'clear_queue_confirm' },
      nowMs: input.nowMs,
    });
    const cancelToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'schedule',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml([
        telegramBold(s.clearQueueConfirmTitle),
        escapeTelegramHtml(s.clearQueueCountLine(rows.length)),
      ]),
      buttons: [
        [button(confirmToken, s.clearQueueConfirmButton)],
        [button(cancelToken, s.clearQueueCancelButton)],
      ],
    };
  }

  /**
   * Drafts & Queue screen (design §5): the counts line + the top 5
   * ready drafts, oldest first. One open-button per draft (the headline,
   * truncated to 24 chars for Telegram's 64-byte button-text limit).
   */
  async function renderDrafts(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const [counts, due] = await Promise.all([
      countDraftsByStatus(executor),
      countDuePublications(executor, { nowMs: input.nowMs }),
    ]);
    const queueCounts: DraftQueueCounts = {
      ready: counts.ready,
      approved: counts.approved,
      approvalRequired: counts.approvalRequired,
      rejected: counts.rejected,
      queued: due,
    };
    const drafts = await listReadyDrafts(executor, { limit: ADMIN_PANEL_DRAFTS_LIST_LIMIT });
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.draftsTitle),
      escapeTelegramHtml(s.draftsCountsLine(queueCounts)),
    ];
    if (drafts.length === 0) {
      parts.push(escapeTelegramHtml(s.draftsEmpty));
    }
    for (const draft of drafts) {
      const headline = readDraftHeadline(draft.document_json);
      const findings = readDraftFindings(draft.document_json);
      const date = new Date(draft.created_at).toISOString().slice(0, 10);
      const gate =
        findings === null
          ? `${s.draftDetailGateLabel} —`
          : `${s.draftDetailGateLabel} ${findings} ${s.draftDetailFindingsLabel}`;
      parts.push(
        escapeTelegramHtml(
          `${headline === null ? draft.id : truncateText(headline, 40)} · ${date} · ${gate}`,
        ),
      );
    }
    parts.push(escapeTelegramHtml(s.draftsHint));
    const draftTokens = await Promise.all(
      drafts.map((draft) =>
        mintToken({
          telegramUserId: input.telegramUserId,
          action: ADMIN_PANEL_TOKEN_ACTIONS.showDraft,
          payload: { op: 'show_draft', draftId: draft.id },
          nowMs: input.nowMs,
        }),
      ),
    );
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    const buttons: AdminPanelButtons = [
      ...draftTokens.map((token, index) => {
        const draft = drafts[index]!;
        const headline = readDraftHeadline(draft.document_json);
        return [button(token, headline === null ? draft.id.slice(-8) : truncateText(headline, 24))];
      }),
      [button(backToken, s.backButton)],
    ];
    return { kind: 'reply', text: composeTelegramHtml(parts), buttons };
  }

  /**
   * Draft detail (design §5): the read-only review render IS the
   * preview (when the review service is wired); otherwise the compact
   * line + the honest note. Approve/Reject/Re-evaluate are offered
   * only while the draft is `ready` — any other state gets Back only
   * (the toast would say not_ready anyway; hiding the buttons is
   * cleaner than a dead tap).
   */
  async function renderDraftDetail(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly draftId: string;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const draft = await findDraftById(executor, input.draftId);
    if (draft === null) {
      return {
        kind: 'reply',
        text: escapeTelegramHtml(s.callbackDraftNotFound),
      };
    }
    const previewText =
      editorialReview === undefined
        ? null
        : await editorialReview.draftsDetail(input.draftId, input.uiLanguage);
    let text: TelegramSafeHtml;
    if (previewText !== null) {
      text = previewText;
    } else {
      const headline = readDraftHeadline(draft.document_json);
      const findings = readDraftFindings(draft.document_json);
      const parts: TelegramSafeHtml[] = [telegramBold(`${s.draftDetailTitle} · ${draft.status}`)];
      if (headline !== null) {
        parts.push(escapeTelegramHtml(headline));
      }
      parts.push(
        escapeTelegramHtml(
          `${s.draftDetailGateLabel} ${
            findings === null ? '—' : `${findings} ${s.draftDetailFindingsLabel}`
          }`,
        ),
      );
      parts.push(escapeTelegramHtml(s.callbackReviewUnavailable));
      text = composeTelegramHtml(parts);
    }
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'drafts',
      nowMs: input.nowMs,
    });
    if (draft.status !== 'ready') {
      return { kind: 'reply', text, buttons: [[button(backToken, s.backButton)]] };
    }
    const [approveToken, rejectToken, reevaluateToken] = await Promise.all([
      mintToken({
        telegramUserId: input.telegramUserId,
        action: ADMIN_PANEL_TOKEN_ACTIONS.draftApprove,
        payload: { op: 'draft_approve', draftId: input.draftId },
        nowMs: input.nowMs,
      }),
      mintToken({
        telegramUserId: input.telegramUserId,
        action: ADMIN_PANEL_TOKEN_ACTIONS.draftReject,
        payload: { op: 'draft_reject', draftId: input.draftId },
        nowMs: input.nowMs,
      }),
      mintToken({
        telegramUserId: input.telegramUserId,
        action: ADMIN_PANEL_TOKEN_ACTIONS.draftReevaluate,
        payload: { op: 'draft_reevaluate', draftId: input.draftId },
        nowMs: input.nowMs,
      }),
    ]);
    return {
      kind: 'reply',
      text,
      buttons: [
        [
          button(approveToken, s.draftDetailApproveButton),
          button(rejectToken, s.draftDetailRejectButton),
        ],
        [button(reevaluateToken, s.draftDetailReevaluateButton)],
        [button(backToken, s.backButton)],
      ],
    };
  }

  /**
   * Slice 6 — the housekeeping list screen. A LIST screen by nature: one
   * open-button per listed post (capped at 5), one filter toggle, the
   * auto-pin toggle, the retention toggle, and Back. The toggles live
   * here because they ARE the housekeeping screen's job — the mode/cap/
   * event screens keep their own 3–4-button shape untouched.
   */
  async function renderPosts(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly filter: PanelPostsFilter;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    if (postManagement === undefined) {
      return {
        kind: 'reply',
        text: escapeTelegramHtml(s.callbackPostMgmtUnavailable),
      };
    }
    const [posts, autoPinEnabled, retention] = await Promise.all([
      postManagement.listPosts({
        telegramUserId: input.telegramUserId,
        role: input.role,
        filters: { status: input.filter, limit: 5 },
      }),
      postManagement.autoPinEnabled(),
      postManagement.retentionRule(),
    ]);
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.postsTitle),
      escapeTelegramHtml(s.postsRetentionLine(retention)),
    ];
    if (posts.length === 0) {
      parts.push(escapeTelegramHtml(s.postsEmpty));
    }
    for (const post of posts) {
      parts.push(escapeTelegramHtml(formatPostLine(post)));
    }
    parts.push(escapeTelegramHtml(s.postsHint));
    const postTokens = await Promise.all(
      posts.map((post) =>
        mintToken({
          telegramUserId: input.telegramUserId,
          action: ADMIN_PANEL_TOKEN_ACTIONS.showPost,
          payload: {
            op: 'show_post',
            refType: post.refType,
            refId: post.refId,
            channelMessageId: post.channelMessageId,
          },
          nowMs: input.nowMs,
        }),
      ),
    );
    const filterToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.showPosts,
      payload: {
        op: 'show',
        screen: 'posts',
        filter: input.filter === 'all' ? 'expired' : 'all',
      },
      nowMs: input.nowMs,
    });
    const autoPinToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.setAutoPin,
      payload: { op: 'set_auto_pin', enabled: !autoPinEnabled },
      nowMs: input.nowMs,
    });
    const retentionToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.setRetention,
      payload: { op: 'set_retention', enabled: !retention.enabled },
      nowMs: input.nowMs,
    });
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    const buttons: AdminPanelButtons = [
      ...postTokens.map((token, index) => [button(token, `#${posts[index]!.channelMessageId}`)]),
      [
        button(filterToken, input.filter === 'all' ? s.postsFilterExpired : s.postsFilterAll),
        button(autoPinToken, autoPinEnabled ? s.postsAutoPinOnButton : s.postsAutoPinOffButton),
      ],
      [
        button(
          retentionToken,
          retention.enabled ? s.postsRetentionOnButton : s.postsRetentionOffButton,
        ),
        button(backToken, s.backButton),
      ],
    ];
    return { kind: 'reply', text: composeTelegramHtml(parts), buttons };
  }

  /** One housekeeping list line: pin mark, message id, category, date, expiry. */
  function formatPostLine(post: ChannelPostListRow): string {
    const date = new Date(post.publishedAtMs).toISOString().slice(0, 10);
    const pin = post.pinned ? '📌 ' : '';
    const expired = post.expired ? ' · expired' : '';
    const title =
      post.title === null
        ? ''
        : ` · ${post.title.length > 40 ? `${post.title.slice(0, 40)}…` : post.title}`;
    return `${pin}#${post.channelMessageId} · ${post.category} · ${date}${expired}${title}`;
  }

  async function renderPostDetail(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly ref: PanelPostRef;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    if (postManagement === undefined) {
      return {
        kind: 'reply',
        text: escapeTelegramHtml(s.callbackPostMgmtUnavailable),
      };
    }
    const posts = await postManagement.listPosts({
      telegramUserId: input.telegramUserId,
      role: input.role,
      filters: { status: 'all', limit: 50 },
    });
    const post = posts.find((row) => row.channelMessageId === input.ref.channelMessageId);
    if (post === undefined) {
      return {
        kind: 'reply',
        text: escapeTelegramHtml(s.postsEmpty),
      };
    }
    const parts: TelegramSafeHtml[] = [
      telegramBold(`${s.postDetailTitle} #${post.channelMessageId}`),
      escapeTelegramHtml(`${s.postDetailCategoryLabel} ${post.category}`),
      escapeTelegramHtml(
        `${s.postDetailPublishedLabel} ${new Date(post.publishedAtMs).toISOString()}`,
      ),
      escapeTelegramHtml(`${s.postDetailPinnedLabel} ${post.pinned ? '📌' : '—'}`),
      escapeTelegramHtml(`${s.postDetailExpiredLabel} ${post.expired ? 'yes' : 'no'}`),
    ];
    if (post.title !== null) {
      parts.push(escapeTelegramHtml(post.title));
    }
    const pinToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: post.pinned ? ADMIN_PANEL_TOKEN_ACTIONS.unpinPost : ADMIN_PANEL_TOKEN_ACTIONS.pinPost,
      payload: post.pinned
        ? { op: 'unpin_post', channelMessageId: post.channelMessageId }
        : {
            op: 'pin_post',
            refType: post.refType,
            refId: post.refId,
            channelMessageId: post.channelMessageId,
          },
      nowMs: input.nowMs,
    });
    const editToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.startEdit,
      payload: {
        op: 'start_edit',
        refType: post.refType,
        refId: post.refId,
        channelMessageId: post.channelMessageId,
      },
      nowMs: input.nowMs,
    });
    const deleteToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.deleteRequest,
      payload: {
        op: 'delete_request',
        refType: post.refType,
        refId: post.refId,
        channelMessageId: post.channelMessageId,
      },
      nowMs: input.nowMs,
    });
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'posts',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [
          button(pinToken, post.pinned ? s.postDetailUnpinButton : s.postDetailPinButton),
          button(editToken, s.postDetailEditButton),
          button(deleteToken, s.postDetailDeleteButton),
        ],
        [button(backToken, s.backButton)],
      ],
    };
  }

  async function renderDeleteConfirm(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly ref: PanelPostRef;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const confirmToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.deleteConfirm,
      payload: {
        op: 'delete_confirm',
        refType: input.ref.refType,
        refId: input.ref.refId,
        channelMessageId: input.ref.channelMessageId,
      },
      nowMs: input.nowMs,
    });
    const cancelToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.showPost,
      payload: {
        op: 'show_post',
        refType: input.ref.refType,
        refId: input.ref.refId,
        channelMessageId: input.ref.channelMessageId,
      },
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml([
        telegramBold(s.deleteConfirmTitle),
        escapeTelegramHtml(`#${input.ref.channelMessageId}`),
      ]),
      buttons: [
        [button(confirmToken, s.deleteConfirmButton)],
        [button(cancelToken, s.deleteCancelButton)],
      ],
    };
  }

  /**
   * Manual Post screen (design §7): the how-to + the pending inbound
   * approvals with the inbound service's OWN approve/reject buttons +
   * the recent owner posts (each opens the post detail). The Approve /
   * Reject buttons mint INBOUND tokens — the ingress's action-aware
   * dispatcher hands them to the inbound service, never to this panel.
   */
  async function renderManual(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.manualTitle),
      escapeTelegramHtml(s.manualInstructions),
    ];
    // Mutable while building (AdminPanelButtons is readonly — the rows
    // are assembled here, then returned as the readonly type).
    const buttons: Array<Array<{ readonly text: string; readonly callbackData: string }>> = [];
    if (featureFlags === undefined || !featureFlags.inboundEnabled) {
      parts.push(escapeTelegramHtml(s.callbackInboundUnavailable));
    } else {
      const pending = await listPendingInboundApprovals(executor, {
        nowMs: input.nowMs,
        limit: ADMIN_PANEL_MANUAL_PENDING_LIMIT,
      });
      parts.push(escapeTelegramHtml(s.manualPendingLabel));
      if (pending.length === 0) {
        parts.push(escapeTelegramHtml(s.manualPendingEmpty));
      }
      for (const approval of pending) {
        const preview = readInboundPreviewText(approval.contentJson);
        const hoursLeft = Math.max(0, Math.ceil((approval.expiresAtMs - input.nowMs) / 3_600_000));
        parts.push(
          escapeTelegramHtml(
            `#${approval.id.slice(-6)} · ${approval.category} · ${approval.presentation} · ${s.manualExpiresLine(hoursLeft)}` +
              (preview === null ? '' : ` — ${truncateText(preview, 60)}`),
          ),
        );
      }
      for (const approval of pending) {
        const [approveToken, rejectToken] = await Promise.all([
          mintInboundToken({
            telegramUserId: input.telegramUserId,
            approvalId: approval.id,
            action: INBOUND_APPROVE_ACTION,
            permission: 'publication.publish',
            expiresAtMs: approval.expiresAtMs,
            nowMs: input.nowMs,
          }),
          mintInboundToken({
            telegramUserId: input.telegramUserId,
            approvalId: approval.id,
            action: INBOUND_REJECT_ACTION,
            permission: 'draft.approve',
            expiresAtMs: approval.expiresAtMs,
            nowMs: input.nowMs,
          }),
        ]);
        buttons.push([
          button(approveToken, `✅ #${approval.id.slice(-6)}`),
          button(rejectToken, `❌ #${approval.id.slice(-6)}`),
        ]);
      }
    }
    const recent = await listRecentPublishedPosts(executor, {
      limit: ADMIN_PANEL_MANUAL_RECENT_LIMIT,
    });
    parts.push(escapeTelegramHtml(s.manualRecentLabel));
    if (recent.length === 0) {
      parts.push(escapeTelegramHtml(s.manualRecentEmpty));
    }
    for (const post of recent) {
      const date = new Date(post.createdAtMs).toISOString().slice(0, 10);
      parts.push(escapeTelegramHtml(`#${post.channelMessageIds[0]} · ${post.category} · ${date}`));
    }
    for (const post of recent) {
      const openToken = await mintToken({
        telegramUserId: input.telegramUserId,
        action: ADMIN_PANEL_TOKEN_ACTIONS.showPost,
        payload: {
          op: 'show_post',
          refType: 'inbound',
          refId: post.id,
          channelMessageId: post.channelMessageIds[0]!,
        },
        nowMs: input.nowMs,
      });
      buttons.push([button(openToken, `#${post.channelMessageIds[0]}`)]);
    }
    parts.push(escapeTelegramHtml(s.manualHint));
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    buttons.push([button(backToken, s.backButton)]);
    return { kind: 'reply', text: composeTelegramHtml(parts), buttons };
  }

  /**
   * AI & Soul screen (design §8): the Soul version + persona line
   * (read-only), the providers (flags + presence, never values), the
   * failover display, and Test AI — honestly unavailable while no
   * engine probe exists (design §15 decision 1).
   */
  async function renderAi(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const parts: TelegramSafeHtml[] = [telegramBold(s.aiSoulTitle)];
    if (state.soulVersion === null) {
      parts.push(escapeTelegramHtml(`${s.soulVersionLabel} ${s.soulUnavailable}`));
    } else {
      parts.push(
        escapeTelegramHtml(`${s.soulVersionLabel} v${state.soulVersion} · ${s.soulCurrent}`),
      );
      if (state.soulPersonaLine !== null) {
        parts.push(escapeTelegramHtml(`${s.soulPersonaLabel} ${state.soulPersonaLine}`));
      }
    }
    parts.push(escapeTelegramHtml(s.aiProvidersLabel));
    parts.push(
      escapeTelegramHtml(
        `${s.aiGeminiRewriteLabel} ${
          featureFlags === undefined
            ? s.debugUnavailable
            : featureFlags.aiGeminiRewriteEnabled
              ? s.aiFlagOn
              : s.aiFlagOff
        }`,
      ),
    );
    parts.push(
      escapeTelegramHtml(
        `${s.aiWorkersAiLabel} ${
          aiPresence === undefined
            ? s.debugUnavailable
            : aiPresence.workersAiBindingPresent
              ? s.aiPresent
              : s.aiAbsent
        }`,
      ),
    );
    parts.push(
      escapeTelegramHtml(
        `${s.aiImageLabel} ${
          featureFlags === undefined
            ? s.debugUnavailable
            : featureFlags.aiImageEnabled
              ? s.aiFlagOn
              : s.aiFlagOff
        }`,
      ),
    );
    parts.push(
      escapeTelegramHtml(
        `${s.aiFailoverLabel} ${
          featureFlags === undefined
            ? s.debugUnavailable
            : featureFlags.aiFailoverEnabled
              ? s.aiFlagOn
              : s.aiFlagOff
        }`,
      ),
    );
    parts.push(
      escapeTelegramHtml(
        `${s.aiBackupTokenLabel} ${
          featureFlags === undefined
            ? s.debugUnavailable
            : featureFlags.backupTokenConfigured
              ? s.aiBackupConfigured
              : s.aiBackupNotConfigured
        }`,
      ),
    );
    parts.push(escapeTelegramHtml(s.aiHint));
    const testToken = await mintToken({
      telegramUserId: input.telegramUserId,
      action: ADMIN_PANEL_TOKEN_ACTIONS.testAi,
      payload: { op: 'test_ai' },
      nowMs: input.nowMs,
    });
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [[button(testToken, s.testAiButton)], [button(backToken, s.backButton)]],
    };
  }

  /** Settings screen (design §9): grouped, every line backed by a store. */
  async function renderSettings(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.settingsTitle),
      escapeTelegramHtml(s.settingsGeneralHeader),
      escapeTelegramHtml(`${s.mainModeLabel} ${state.mode}`),
      escapeTelegramHtml(`${s.mainCapLabel} ${state.capInForce}`),
      escapeTelegramHtml(
        `${s.mainEventLabel} ${state.eventActive ? s.mainEventOn : s.mainEventOff}`,
      ),
      escapeTelegramHtml(`${s.settingsLanguageLabel} ${input.uiLanguage}`),
      escapeTelegramHtml(s.settingsLanguageHint),
      escapeTelegramHtml(s.settingsContentHeader),
      escapeTelegramHtml(`${s.settingsFormLabel} ${s.settingsFormValue}`),
      escapeTelegramHtml(s.settingsAiHeader),
      escapeTelegramHtml(
        `${s.settingsRewriteLabel} ${
          featureFlags === undefined
            ? s.debugUnavailable
            : featureFlags.aiGeminiRewriteEnabled
              ? s.aiFlagOn
              : s.aiFlagOff
        }`,
      ),
      escapeTelegramHtml(
        `${s.settingsImageLabel} ${
          featureFlags === undefined
            ? s.debugUnavailable
            : featureFlags.aiImageEnabled
              ? s.aiFlagOn
              : s.aiFlagOff
        }`,
      ),
      escapeTelegramHtml(s.settingsQualityHeader),
      escapeTelegramHtml(`${s.settingsFactGuardLabel} ${s.settingsFactGuardValue}`),
    ];
    const [modeToken, capToken, eventToken, backToken] = await Promise.all([
      showButtons({ telegramUserId: input.telegramUserId, screen: 'mode', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'cap', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'event', nowMs: input.nowMs }),
      showButtons({ telegramUserId: input.telegramUserId, screen: 'main', nowMs: input.nowMs }),
    ]);
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [
        [
          button(modeToken, s.modeButton),
          button(capToken, s.capButton),
          button(eventToken, s.eventButton),
        ],
        [button(backToken, s.backButton)],
      ],
    };
  }

  /** Stats screen (design §10): today, totals, AI calls, worker. */
  async function renderStats(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly state: PanelState;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const state = input.state;
    const [counts, due, totals, geminiCalls, workersCalls, backupCalls, imageCalls] =
      await Promise.all([
        countDraftsByStatus(executor),
        countDuePublications(executor, { nowMs: input.nowMs }),
        countEditorialTotals(executor),
        readAiBudget(executor, { provider: 'gemini', nowMs: input.nowMs }),
        readAiBudget(executor, { provider: 'workers-ai', nowMs: input.nowMs }),
        readAiBudget(executor, { provider: 'workers-ai-backup', nowMs: input.nowMs }),
        readAiBudget(executor, {
          provider: 'workers-ai',
          nowMs: input.nowMs,
          budgetKey: AI_IMAGE_BUDGET_KEY,
        }),
      ]);
    let lastPublished = s.statsLastPublishedNone;
    if (postManagement !== undefined) {
      const latest = await postManagement.listPosts({
        telegramUserId: input.telegramUserId,
        role: input.role,
        filters: { status: 'all', limit: 1 },
      });
      if (latest.length > 0) {
        const post = latest[0]!;
        lastPublished = `#${post.channelMessageId} · ${new Date(post.publishedAtMs).toISOString().slice(0, 16).replace('T', ' ')}`;
      }
    }
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.statsTitle),
      escapeTelegramHtml(s.statsTodayHeader),
      escapeTelegramHtml(`${s.statsPublishedLabel} ${state.counts.counted} of ${state.capInForce}`),
      escapeTelegramHtml(`${s.statsOwnerLabel} ${state.counts.owner}`),
      escapeTelegramHtml(`${s.statsQueuedLabel} ${due}`),
      escapeTelegramHtml(`${s.statsRejectedLabel} ${counts.rejected}`),
      escapeTelegramHtml(`${s.statsLastPublishedLabel} ${lastPublished}`),
      escapeTelegramHtml(s.statsTotalsHeader),
      escapeTelegramHtml(`${s.statsStoriesLabel} ${totals.stories}`),
      escapeTelegramHtml(`${s.statsDraftsLabel} ${totals.drafts}`),
      escapeTelegramHtml(`${s.statsClaimsLabel} ${totals.claims}`),
      escapeTelegramHtml(`${s.statsSourceItemsLabel} ${totals.sourceItems}`),
      escapeTelegramHtml(s.statsAiHeader),
      escapeTelegramHtml(`${s.statsGeminiCallsLabel} ${geminiCalls}`),
      escapeTelegramHtml(`${s.statsWorkersAiCallsLabel} ${workersCalls + backupCalls}`),
      escapeTelegramHtml(`${s.statsImageCallsLabel} ${imageCalls}`),
      escapeTelegramHtml(s.statsWorkerHeader),
      escapeTelegramHtml(
        `${s.statsVersionLabel} ${workerInfo === undefined ? s.debugUnavailable : workerInfo.applicationVersion}`,
      ),
      escapeTelegramHtml(
        `${s.statsCommitLabel} ${workerInfo === undefined ? s.debugUnavailable : workerInfo.commit}`,
      ),
      escapeTelegramHtml(
        `${s.statsSchemaLabel} ${workerInfo === undefined ? s.debugUnavailable : String(workerInfo.schemaVersion)}`,
      ),
      escapeTelegramHtml(`${s.statsHealthLabel} ${s.statsHealthOk}`),
    ];
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [[button(backToken, s.backButton)]],
    };
  }

  /**
   * Admins screen (design §11): the owner-only list. While
   * ADMIN_MANAGE_ENABLED is off the screen is READ-ONLY (list + the
   * note); mutating buttons appear only when the slice-2 flag is
   * enabled by the owner.
   */
  async function renderAdmins(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const admins = await listAdmins(executor);
    const roleIcon: Readonly<Record<string, string>> = {
      owner: '👑',
      chief_editor: '✏️',
      editor: '📝',
      reviewer: '👀',
      source_manager: '📡',
      viewer: '👁️',
    };
    const parts: TelegramSafeHtml[] = [telegramBold(s.adminsTitle)];
    if (admins.length === 0) {
      parts.push(escapeTelegramHtml(s.adminsEmpty));
    }
    for (const admin of admins) {
      parts.push(
        escapeTelegramHtml(
          `${roleIcon[admin.role] ?? '👤'} ${admin.telegramUserId} · ${admin.role} · ${admin.status}`,
        ),
      );
    }
    if (featureFlags === undefined || !featureFlags.adminManageEnabled) {
      parts.push(escapeTelegramHtml(s.adminsManageOffNote));
    }
    parts.push(escapeTelegramHtml(s.adminsHint));
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [[button(backToken, s.backButton)]],
    };
  }

  /** Debug / Status screen (design §12): read-only, everything it knows. */
  async function renderDebug(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const totals = await countEditorialTotals(executor);
    const parts: TelegramSafeHtml[] = [telegramBold(s.debugTitle)];
    parts.push(escapeTelegramHtml(s.debugWorkerHeader));
    parts.push(
      escapeTelegramHtml(
        `${s.statsVersionLabel} ${workerInfo === undefined ? s.debugUnavailable : workerInfo.applicationVersion}`,
      ),
    );
    parts.push(
      escapeTelegramHtml(
        `${s.statsCommitLabel} ${workerInfo === undefined ? s.debugUnavailable : workerInfo.commit}`,
      ),
    );
    parts.push(
      escapeTelegramHtml(
        `${s.statsSchemaLabel} ${workerInfo === undefined ? s.debugUnavailable : String(workerInfo.schemaVersion)}`,
      ),
    );
    parts.push(escapeTelegramHtml(`${s.debugWebhookLabel} ${s.debugWebhookActive}`));
    parts.push(escapeTelegramHtml(s.debugFlagsHeader));
    if (featureFlags === undefined) {
      parts.push(escapeTelegramHtml(s.debugUnavailable));
    } else {
      const flagLine = (label: string, on: boolean): string =>
        `${label} ${on ? s.aiFlagOn : s.aiFlagOff}`;
      parts.push(
        escapeTelegramHtml(flagLine('ADMIN_PANEL_ENABLED', featureFlags.adminPanelEnabled)),
      );
      parts.push(
        escapeTelegramHtml(flagLine('AI_FAILOVER_ENABLED', featureFlags.aiFailoverEnabled)),
      );
      parts.push(escapeTelegramHtml(flagLine('AI_IMAGE_ENABLED', featureFlags.aiImageEnabled)));
      parts.push(
        escapeTelegramHtml(
          flagLine('AI_GEMINI_REWRITE_ENABLED', featureFlags.aiGeminiRewriteEnabled),
        ),
      );
      parts.push(
        escapeTelegramHtml(flagLine('EVENT_RELATION_ENABLED', featureFlags.eventRelationEnabled)),
      );
      parts.push(
        escapeTelegramHtml(
          `${s.aiBackupTokenLabel} ${featureFlags.backupTokenConfigured ? s.aiBackupConfigured : s.aiBackupNotConfigured}`,
        ),
      );
      parts.push(
        escapeTelegramHtml(flagLine('ADMIN_MANAGE_ENABLED', featureFlags.adminManageEnabled)),
      );
      parts.push(escapeTelegramHtml(flagLine('ADMIN_POST_ENABLED', featureFlags.inboundEnabled)));
    }
    parts.push(escapeTelegramHtml(s.debugD1Header));
    parts.push(escapeTelegramHtml(`${s.statsStoriesLabel} ${totals.stories}`));
    parts.push(escapeTelegramHtml(`${s.statsDraftsLabel} ${totals.drafts}`));
    parts.push(escapeTelegramHtml(`${s.statsClaimsLabel} ${totals.claims}`));
    parts.push(escapeTelegramHtml(`${s.statsSourceItemsLabel} ${totals.sourceItems}`));
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [[button(backToken, s.backButton)]],
    };
  }

  /** Help screen (design §13): the short how-to. */
  async function renderHelp(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly nowMs: number;
  }): Promise<AdminPanelReplyResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const parts: TelegramSafeHtml[] = [
      telegramBold(s.helpTitle),
      escapeTelegramHtml(s.helpSendPost),
      escapeTelegramHtml(s.helpApproveDrafts),
      escapeTelegramHtml(s.helpChangeMode),
      escapeTelegramHtml(s.helpWindow),
      escapeTelegramHtml(s.helpWebPanel),
    ];
    const backToken = await showButtons({
      telegramUserId: input.telegramUserId,
      screen: 'main',
      nowMs: input.nowMs,
    });
    return {
      kind: 'reply',
      text: composeTelegramHtml(parts),
      buttons: [[button(backToken, s.backButton)]],
    };
  }

  async function renderScreen(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly screen: PanelScreen;
    readonly nowMs: number;
    readonly postsFilter?: PanelPostsFilter;
  }): Promise<AdminPanelReplyResult> {
    // The Admins screen is owner-only: anyone else gets the denial text,
    // never the list (defense in depth — the button only renders for the
    // owner, but a forged token must never leak the list either).
    if (input.screen === 'admins' && input.role !== 'owner') {
      return {
        kind: 'reply',
        text: escapeTelegramHtml(ADMIN_PANEL_STRINGS[input.uiLanguage].permissionDenied),
      };
    }
    const state = await loadState(input.nowMs);
    switch (input.screen) {
      case 'main':
        return renderMain({ ...input, state });
      case 'mode':
        return renderMode({ ...input, state });
      case 'cap':
        return renderCap({ ...input, state });
      case 'event':
        return renderEvent({ ...input, state });
      case 'schedule':
        return renderSchedule({ ...input, state });
      case 'drafts':
        return renderDrafts({
          telegramUserId: input.telegramUserId,
          uiLanguage: input.uiLanguage,
          nowMs: input.nowMs,
        });
      case 'posts':
        return renderPosts({
          telegramUserId: input.telegramUserId,
          role: input.role,
          uiLanguage: input.uiLanguage,
          filter: input.postsFilter ?? 'all',
          nowMs: input.nowMs,
        });
      case 'manual':
        return renderManual({
          telegramUserId: input.telegramUserId,
          role: input.role,
          uiLanguage: input.uiLanguage,
          nowMs: input.nowMs,
        });
      case 'ai':
        // The presence screen needs NO publishing state beyond the Soul
        // version — it renders the injected booleans/flags only (no D1
        // reads of its own beyond the Soul pointer in loadState).
        return renderAi({
          telegramUserId: input.telegramUserId,
          uiLanguage: input.uiLanguage,
          state,
          nowMs: input.nowMs,
        });
      case 'settings':
        return renderSettings({
          telegramUserId: input.telegramUserId,
          uiLanguage: input.uiLanguage,
          state,
          nowMs: input.nowMs,
        });
      case 'stats':
        return renderStats({
          telegramUserId: input.telegramUserId,
          role: input.role,
          uiLanguage: input.uiLanguage,
          state,
          nowMs: input.nowMs,
        });
      case 'admins':
        return renderAdmins({
          telegramUserId: input.telegramUserId,
          uiLanguage: input.uiLanguage,
          nowMs: input.nowMs,
        });
      case 'debug':
        return renderDebug({
          telegramUserId: input.telegramUserId,
          uiLanguage: input.uiLanguage,
          nowMs: input.nowMs,
        });
      case 'help':
        return renderHelp({
          telegramUserId: input.telegramUserId,
          uiLanguage: input.uiLanguage,
          nowMs: input.nowMs,
        });
    }
  }

  function answer(callbackText: string): AdminPanelCallbackResult {
    return { kind: 'answer', callbackText };
  }

  /**
   * Draft Approve (design §5): the fenced human transition, then the
   * outbox enqueue through the existing engine path. Idempotent: a
   * draft that is already `approved` retries the enqueue alone, so a
   * refused enqueue never strands a draft.
   */
  async function approveDraft(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly draftId: string;
    readonly nowMs: number;
  }): Promise<AdminPanelCallbackResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    if (!roleHasPermission(input.role, 'draft.approve')) {
      return answer(s.callbackPermissionDenied);
    }
    const settings = await readPublishingSettings(executor);
    if (settings.mode === 'paused') {
      return answer(s.callbackPausedCannotApprove);
    }
    if (publishDestination === undefined) {
      return answer(s.callbackNoDestination);
    }
    const approval = await approveDraftForHumanPublication(executor, {
      draftId: input.draftId,
      actorId: input.telegramUserId,
      nowMs: input.nowMs,
    });
    if (approval.kind === 'draft_not_found') {
      return answer(s.callbackDraftNotFound);
    }
    if (approval.kind === 'not_ready') {
      return answer(s.callbackDraftNotReady);
    }
    // applied or already_approved: enqueue. The draft is `approved` now,
    // which every non-paused mode's outbox matrix accepts.
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
      destination: publishDestination,
      priorityScore: HUMAN_PUBLISH_PRIORITY_SCORE,
      approvalMode,
      nowMs: input.nowMs,
      soulVersion,
    });
    if (outcome.kind === 'created' || outcome.kind === 'duplicate') {
      return answer(
        approval.kind === 'already_approved'
          ? s.callbackDraftAlreadyApproved
          : s.callbackDraftApproved,
      );
    }
    // The draft stays `approved` — the next Approve tap retries the
    // enqueue alone (the transition absorbs as already_approved).
    return answer(s.callbackEnqueueFailed);
  }

  /** Draft Reject (design §5): the fenced terminal transition, audited. */
  async function rejectDraft(input: {
    readonly telegramUserId: number;
    readonly role: AdminRole;
    readonly uiLanguage: AdminUiLanguage;
    readonly draftId: string;
    readonly nowMs: number;
  }): Promise<AdminPanelCallbackResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    if (!roleHasPermission(input.role, 'draft.reject')) {
      return answer(s.callbackPermissionDenied);
    }
    const outcome = await rejectDraftForHumanPublication(executor, {
      draftId: input.draftId,
      actorId: input.telegramUserId,
      nowMs: input.nowMs,
    });
    switch (outcome.kind) {
      case 'applied':
        return answer(s.callbackDraftRejected);
      case 'already_rejected':
        return answer(s.callbackDraftAlreadyRejected);
      case 'draft_not_found':
        return answer(s.callbackDraftNotFound);
      case 'not_ready':
        return answer(s.callbackDraftNotReady);
    }
  }

  /**
   * The Approval toggle (design §2 row 5): approval mode is the
   * `approval` publish mode — the toggle flips mode approval ↔ auto
   * through the same audited store path as the Mode screen.
   */
  async function toggleApproval(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly nowMs: number;
  }): Promise<AdminPanelCallbackResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const settings = await readPublishingSettings(executor);
    const target: PublishMode = settings.mode === 'approval' ? 'auto' : 'approval';
    const outcome = await setPublishMode(executor, {
      mode: target,
      actorId: input.telegramUserId,
      nowMs: input.nowMs,
    });
    if (outcome.kind === 'no_change') {
      return answer(s.callbackNoChange);
    }
    return answer(target === 'approval' ? s.callbackApprovalOn : s.callbackApprovalOff);
  }

  /**
   * Clear queue (design §4): cancel every cancellable outbox row
   * through the fenced Phase 9C disposition (one audit event per row).
   * A row claimed by a worker between view and click answers
   * not_cancellable and is counted as skipped, never forced.
   */
  async function clearQueue(input: {
    readonly telegramUserId: number;
    readonly uiLanguage: AdminUiLanguage;
    readonly nowMs: number;
  }): Promise<AdminPanelCallbackResult> {
    const s = ADMIN_PANEL_STRINGS[input.uiLanguage];
    const rows = await listCancellablePublications(executor, { limit: 64 });
    if (rows.length === 0) {
      return answer(s.callbackClearQueueEmpty);
    }
    let applied = 0;
    let skipped = 0;
    for (const row of rows) {
      const outcome = await cancelPublicationById(executor, {
        publicationId: row.id,
        actorId: String(input.telegramUserId),
        nowMs: input.nowMs,
      });
      if (outcome.kind === 'applied') {
        applied += 1;
      } else {
        skipped += 1;
      }
    }
    return answer(s.callbackClearQueueDone(applied, skipped));
  }

  return {
    async main({ telegramUserId, role, uiLanguage }) {
      // Viewing is open to every authorized admin (dashboard.view is held
      // by all six roles); the role is re-checked only for mutations.
      if (!roleHasPermission(role, 'dashboard.view')) {
        return {
          kind: 'reply',
          text: escapeTelegramHtml(ADMIN_PANEL_STRINGS[uiLanguage].permissionDenied),
        };
      }
      return renderScreen({
        telegramUserId,
        role,
        uiLanguage,
        screen: 'main',
        nowMs: clock.now(),
      });
    },

    async screen({ telegramUserId, role, uiLanguage, screen }) {
      if (!roleHasPermission(role, 'dashboard.view')) {
        return {
          kind: 'reply',
          text: escapeTelegramHtml(ADMIN_PANEL_STRINGS[uiLanguage].permissionDenied),
        };
      }
      return renderScreen({ telegramUserId, role, uiLanguage, screen, nowMs: clock.now() });
    },

    async handleCallback({ telegramUserId, role, uiLanguage, token }) {
      const s = ADMIN_PANEL_STRINGS[uiLanguage];
      const nowMs = clock.now();
      const consumed = await consumeActionToken(executor, { token, telegramUserId, nowMs });
      if (consumed.kind === 'invalid') {
        return answer(s.callbackInvalidToken);
      }
      const record = consumed.record;
      // Defense in depth: the dispatcher routed by this exact action
      // family; a foreign record can never ride the panel.
      if (!record.action.startsWith('panel.')) {
        return answer(s.callbackInvalidToken);
      }
      const payload = parsePayload(record.payloadJson);
      if (payload === null) {
        return answer(s.callbackInvalidToken);
      }
      // A panel read settles the lazy event expiry first, so a stale
      // stored-active event can never be toggled or rendered as active.
      await settleEvent(nowMs);
      if (payload.op === 'show') {
        return renderScreen({
          telegramUserId,
          role,
          uiLanguage,
          screen: payload.screen,
          nowMs,
          postsFilter: payload.filter,
        });
      }
      if (payload.op === 'show_draft') {
        return renderDraftDetail({
          telegramUserId,
          role,
          uiLanguage,
          draftId: payload.draftId,
          nowMs,
        });
      }
      if (payload.op === 'show_post') {
        return renderPostDetail({
          telegramUserId,
          role,
          uiLanguage,
          ref: payload,
          nowMs,
        });
      }
      if (payload.op === 'delete_request') {
        return renderDeleteConfirm({
          telegramUserId,
          uiLanguage,
          ref: payload,
          nowMs,
        });
      }
      if (payload.op === 'test_ai') {
        // No engine probe exists (design §15 decision 1): the honest
        // toast, never a pretend test.
        return answer(s.callbackTestAiUnavailable);
      }
      if (payload.op === 'draft_approve') {
        return approveDraft({
          telegramUserId,
          role,
          uiLanguage,
          draftId: payload.draftId,
          nowMs,
        });
      }
      if (payload.op === 'draft_reject') {
        return rejectDraft({
          telegramUserId,
          role,
          uiLanguage,
          draftId: payload.draftId,
          nowMs,
        });
      }
      if (payload.op === 'draft_reevaluate') {
        // The re-evaluation path belongs to the bridge fix (design §5):
        // the honest toast, never a rebuild of the engine here.
        return answer(s.callbackDraftReevaluateUnavailable);
      }
      if (payload.op === 'clear_queue_request') {
        return renderClearQueueConfirm({
          telegramUserId,
          uiLanguage,
          nowMs,
        });
      }
      // Mutations: owner + chief_editor ONLY. The token burns and nothing
      // moves for any other role — the denial is the toast, never a write.
      if (!canChangePublishingSettings(role)) {
        return answer(s.callbackPermissionDenied);
      }
      // Slice 6 — post-management mutations delegate to the injected
      // service (which re-checks the role — defense in depth). Without
      // the service the toast is honest, never a pretend success.
      if (payload.op === 'pin_post' || payload.op === 'unpin_post') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        if (payload.op === 'pin_post') {
          const outcome = await postManagement.pinPost({
            telegramUserId,
            role,
            refType: payload.refType,
            refId: payload.refId,
            channelMessageId: payload.channelMessageId,
          });
          switch (outcome.kind) {
            case 'pinned':
              return answer(s.callbackPinned);
            case 'already_pinned':
              return answer(s.callbackAlreadyPinned);
            case 'denied':
              return answer(s.callbackPermissionDenied);
            case 'transport_unavailable':
              return answer(s.callbackPostMgmtUnavailable);
            case 'pin_failed':
              return answer(s.callbackPinFailed);
          }
        } else {
          const outcome = await postManagement.unpinPost({
            telegramUserId,
            role,
            channelMessageId: payload.channelMessageId,
          });
          switch (outcome.kind) {
            case 'unpinned':
              return answer(s.callbackUnpinned);
            case 'not_pinned':
              return answer(s.callbackNotPinned);
            case 'denied':
              return answer(s.callbackPermissionDenied);
            case 'transport_unavailable':
              return answer(s.callbackPostMgmtUnavailable);
            case 'unpin_failed':
              return answer(s.callbackPinFailed);
          }
        }
      }
      if (payload.op === 'delete_confirm') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        const outcome = await postManagement.deletePost({
          telegramUserId,
          role,
          refType: payload.refType,
          refId: payload.refId,
          channelMessageId: payload.channelMessageId,
        });
        if (outcome.kind === 'denied') {
          return answer(s.callbackPermissionDenied);
        }
        if (outcome.kind === 'transport_unavailable') {
          return answer(s.callbackPostMgmtUnavailable);
        }
        if (outcome.kind === 'delete_failed') {
          return answer(s.callbackDeleteFailed);
        }
        // Deleted: the fresh posts list IS the confirmation (the post
        // is gone from it). The toast text is lost on the reply path —
        // the list carries the proof instead.
        return renderPosts({
          telegramUserId,
          role,
          uiLanguage,
          filter: 'all',
          nowMs,
        });
      }
      if (payload.op === 'set_auto_pin') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        const outcome = await postManagement.setAutoPin({
          telegramUserId,
          role,
          enabled: payload.enabled,
        });
        if (outcome.kind === 'denied') {
          return answer(s.callbackPermissionDenied);
        }
        if (outcome.kind === 'no_change') {
          return answer(s.callbackNoChange);
        }
        return answer(payload.enabled ? s.callbackAutoPinOn : s.callbackAutoPinOff);
      }
      if (payload.op === 'set_retention') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        const current = await postManagement.retentionRule();
        const outcome = await postManagement.setRetention({
          telegramUserId,
          role,
          rule: { ...current, enabled: payload.enabled },
        });
        if (outcome.kind === 'denied') {
          return answer(s.callbackPermissionDenied);
        }
        if (outcome.kind === 'invalid') {
          return answer(s.callbackInvalidToken);
        }
        if (outcome.kind === 'no_change') {
          return answer(s.callbackNoChange);
        }
        return answer(payload.enabled ? s.callbackRetentionOn : s.callbackRetentionOff);
      }
      if (payload.op === 'start_edit') {
        if (postManagement === undefined) {
          return answer(s.callbackPostMgmtUnavailable);
        }
        const outcome = await postManagement.startEdit({
          telegramUserId,
          role,
          refType: payload.refType,
          refId: payload.refId,
          channelMessageId: payload.channelMessageId,
        });
        if (outcome.kind === 'denied') {
          return answer(s.callbackPermissionDenied);
        }
        return {
          kind: 'reply',
          text: escapeTelegramHtml(s.editPrompt),
        };
      }
      if (payload.op === 'toggle_approval') {
        return toggleApproval({
          telegramUserId,
          uiLanguage,
          nowMs,
        });
      }
      if (payload.op === 'clear_queue_confirm') {
        return clearQueue({
          telegramUserId,
          uiLanguage,
          nowMs,
        });
      }
      if (payload.op === 'set_mode') {
        const outcome = await setPublishMode(executor, {
          mode: payload.mode,
          actorId: telegramUserId,
          nowMs,
        });
        return answer(
          outcome.kind === 'applied' ? s.callbackModeSet[payload.mode] : s.callbackNoChange,
        );
      }
      if (payload.op === 'set_cap') {
        const outcome = await setDailyCap(executor, {
          cap: payload.cap,
          actorId: telegramUserId,
          nowMs,
        });
        if (outcome.kind === 'invalid') {
          return answer(s.callbackInvalidToken);
        }
        return answer(
          outcome.kind === 'applied'
            ? s.callbackCapSet(payload.cap, outcome.effectiveFrom)
            : s.callbackCapNoChange(payload.cap),
        );
      }
      if (payload.op !== 'set_event') {
        return answer(s.callbackInvalidToken);
      }
      const outcome = await setEventMode(executor, {
        active: payload.active,
        trigger: 'manual',
        actorId: telegramUserId,
        nowMs,
      });
      if (outcome.kind === 'no_change') {
        return answer(s.callbackNoChange);
      }
      return answer(payload.active ? s.callbackEventOn : s.callbackEventOff);
    },

    async noteP0({ nowMs }) {
      return triggerEventOnP0(executor, { nowMs });
    },

    async gate(input) {
      return checkPublishGate(executor, input);
    },
  };
}
