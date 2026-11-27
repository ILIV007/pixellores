/**
 * Admin PANEL UI strings (slice 3 — the `/menu` settings surface: mode
 * toggle + adjustable daily cap + event mode) — presentation strings for
 * the admin panel, one table per AdminUiLanguage. The SAME strict
 * separation as `admin-manage-strings.ts`: the labels localize; the
 * managed DATA (mode names, cap numbers, Tehran dates, stable error
 * codes) is never translated or re-cased.
 */
import type { AdminUiLanguage } from './ui-language';
import type { PublishMode } from '../domain/publishing/publishing-settings';
import type { RetentionRule } from '../domain/publishing/post-management';

/** The allowlisted admin-panel command word (the slice-3 screen). */
export const MENU_COMMAND = 'menu' as const;

/** Panel screens: one job per screen, max 3–4 buttons per screen. */
export type PanelScreen =
  | 'main'
  | 'mode'
  | 'cap'
  | 'event'
  | 'schedule'
  | 'drafts'
  | 'posts'
  | 'manual'
  | 'ai'
  | 'settings'
  | 'stats'
  | 'admins'
  | 'debug'
  | 'help';

/** The Drafts & Queue counts line (design §5) — every count is a D1 read. */
export interface DraftQueueCounts {
  readonly ready: number;
  readonly approved: number;
  readonly approvalRequired: number;
  readonly rejected: number;
  readonly queued: number;
}

export interface AdminPanelUiStrings {
  /** /help line advertising the admin panel (gated). */
  readonly helpMenuLine: string;
  /** Denial text for an AUTHORIZED actor whose role may not change settings. */
  readonly permissionDenied: string;
  /** Usage/honest-invalid-argument text. */
  readonly invalidUsage: string;
  /** AI presence screen (the presence slice — booleans ONLY, never values). */
  readonly aiTitle: string;
  readonly aiWorkersAiBindingLabel: string;
  readonly aiGeminiKeyLabel: string;
  readonly aiGeminiEnabledLabel: string;
  readonly aiPresent: string;
  readonly aiAbsent: string;
  readonly aiFlagOn: string;
  readonly aiFlagOff: string;
  readonly aiHint: string;
  readonly aiPresenceUnavailable: string;
  /** Main panel. */
  readonly mainTitle: string;
  readonly mainModeLabel: string;
  readonly mainCapLabel: string;
  readonly mainTodayLabel: string;
  readonly mainEventLabel: string;
  readonly mainEventOn: string;
  readonly mainEventOff: string;
  readonly modeButton: string;
  readonly capButton: string;
  readonly eventButton: string;
  /** Mode screen: one line per mode. */
  readonly modeTitle: string;
  readonly modeAutoDesc: string;
  readonly modeSafeAutoDesc: string;
  readonly modeApprovalDesc: string;
  readonly modePausedDesc: string;
  readonly modeCurrentMarker: string;
  readonly modeHint: string;
  /** Cap screen. */
  readonly capTitle: string;
  readonly capCurrentLabel: string;
  readonly capTodayLabel: string;
  readonly capPendingLabel: string;
  readonly capHint: string;
  /** Event screen. */
  readonly eventTitle: string;
  readonly eventActiveLine: string;
  readonly eventInactiveLine: string;
  readonly eventEndsLine: string;
  readonly eventOnButton: string;
  readonly eventOffButton: string;
  readonly eventHint: string;
  /** Main panel: the active pin line. */
  readonly mainPinLabel: string;
  readonly mainPinNone: string;
  readonly postsButton: string;
  /** Posts screen (slice 6 — housekeeping). */
  readonly postsTitle: string;
  readonly postsEmpty: string;
  readonly postsFilterAll: string;
  readonly postsFilterExpired: string;
  readonly postsAutoPinLabel: string;
  readonly postsAutoPinOnButton: string;
  readonly postsAutoPinOffButton: string;
  readonly postsRetentionLine: (rule: RetentionRule) => string;
  readonly postsRetentionOnButton: string;
  readonly postsRetentionOffButton: string;
  readonly postsHint: string;
  /** Post detail screen (slice 6). */
  readonly postDetailTitle: string;
  readonly postDetailCategoryLabel: string;
  readonly postDetailPublishedLabel: string;
  readonly postDetailPinnedLabel: string;
  readonly postDetailExpiredLabel: string;
  readonly postDetailPinButton: string;
  readonly postDetailUnpinButton: string;
  readonly postDetailEditButton: string;
  readonly postDetailDeleteButton: string;
  /** Delete confirmation (slice 6). */
  readonly deleteConfirmTitle: string;
  readonly deleteConfirmButton: string;
  readonly deleteCancelButton: string;
  /** Edit capture prompt (slice 6). */
  readonly editPrompt: string;
  /** Main dashboard — combined (design §2). */
  readonly mainSoulLabel: string;
  readonly mainAiLabel: string;
  readonly mainWorkerLabel: string;
  readonly mainChannelEditLabel: string;
  readonly mainChannelEditAlwaysOn: string;
  readonly scheduleButton: string;
  readonly draftsButton: string;
  readonly manualButton: string;
  readonly settingsButton: string;
  readonly statsButton: string;
  readonly helpButton: string;
  readonly refreshButton: string;
  readonly adminsButton: string;
  readonly approvalOnButton: string;
  readonly approvalOffButton: string;
  /** Schedule screen (design §4). */
  readonly scheduleTitle: string;
  readonly schedulePostingLabel: string;
  readonly schedulePostingOn: string;
  readonly schedulePostingOff: string;
  readonly scheduleCapLabel: string;
  readonly scheduleWindowLabel: string;
  readonly scheduleWindowValue: string;
  readonly scheduleNextTickLabel: string;
  readonly scheduleNextTickValue: string;
  readonly schedulePauseButton: string;
  readonly scheduleResumeButton: string;
  readonly scheduleClearQueueButton: string;
  readonly scheduleHint: string;
  /** Clear-queue confirm (design §4). */
  readonly clearQueueConfirmTitle: string;
  readonly clearQueueCountLine: (count: number) => string;
  readonly clearQueueConfirmButton: string;
  readonly clearQueueCancelButton: string;
  /** Drafts & Queue screen (design §5). */
  readonly draftsTitle: string;
  readonly draftsEmpty: string;
  readonly draftsCountsLine: (counts: DraftQueueCounts) => string;
  readonly draftsHint: string;
  /** Draft detail (design §5). */
  readonly draftDetailTitle: string;
  readonly draftDetailGateLabel: string;
  readonly draftDetailFindingsLabel: string;
  readonly draftDetailPreviewButton: string;
  readonly draftDetailApproveButton: string;
  readonly draftDetailRejectButton: string;
  readonly draftDetailReevaluateButton: string;
  /** Manual Post screen (design §7). */
  readonly manualTitle: string;
  readonly manualInstructions: string;
  readonly manualPendingLabel: string;
  readonly manualPendingEmpty: string;
  readonly manualExpiresLine: (hours: number) => string;
  readonly manualRecentLabel: string;
  readonly manualRecentEmpty: string;
  readonly manualHint: string;
  /** AI & Soul screen (design §8). */
  readonly aiSoulTitle: string;
  readonly soulVersionLabel: string;
  readonly soulStatusLabel: string;
  readonly soulCurrent: string;
  readonly soulPersonaLabel: string;
  readonly soulUnavailable: string;
  readonly aiProvidersLabel: string;
  readonly aiGeminiRewriteLabel: string;
  readonly aiWorkersAiLabel: string;
  readonly aiImageLabel: string;
  readonly aiFailoverLabel: string;
  readonly aiBackupTokenLabel: string;
  readonly aiBackupConfigured: string;
  readonly aiBackupNotConfigured: string;
  readonly testAiButton: string;
  /** Settings screen (design §9). */
  readonly settingsTitle: string;
  readonly settingsGeneralHeader: string;
  readonly settingsContentHeader: string;
  readonly settingsAiHeader: string;
  readonly settingsQualityHeader: string;
  readonly settingsLanguageLabel: string;
  readonly settingsLanguageHint: string;
  readonly settingsFormLabel: string;
  readonly settingsFormValue: string;
  readonly settingsRewriteLabel: string;
  readonly settingsImageLabel: string;
  readonly settingsFactGuardLabel: string;
  readonly settingsFactGuardValue: string;
  /** Stats screen (design §10). */
  readonly statsTitle: string;
  readonly statsTodayHeader: string;
  readonly statsTotalsHeader: string;
  readonly statsAiHeader: string;
  readonly statsWorkerHeader: string;
  readonly statsPublishedLabel: string;
  readonly statsOwnerLabel: string;
  readonly statsQueuedLabel: string;
  readonly statsRejectedLabel: string;
  readonly statsLastPublishedLabel: string;
  readonly statsLastPublishedNone: string;
  readonly statsStoriesLabel: string;
  readonly statsDraftsLabel: string;
  readonly statsClaimsLabel: string;
  readonly statsSourceItemsLabel: string;
  readonly statsGeminiCallsLabel: string;
  readonly statsWorkersAiCallsLabel: string;
  readonly statsImageCallsLabel: string;
  readonly statsVersionLabel: string;
  readonly statsCommitLabel: string;
  readonly statsSchemaLabel: string;
  readonly statsHealthLabel: string;
  readonly statsHealthOk: string;
  /** Admins screen (design §11). */
  readonly adminsTitle: string;
  readonly adminsEmpty: string;
  readonly adminsManageOffNote: string;
  readonly adminsHint: string;
  /** Debug screen (design §12). */
  readonly debugTitle: string;
  readonly debugWorkerHeader: string;
  readonly debugFlagsHeader: string;
  readonly debugD1Header: string;
  readonly debugWebhookLabel: string;
  readonly debugWebhookActive: string;
  readonly debugUnavailable: string;
  /** Help screen (design §13). */
  readonly helpTitle: string;
  readonly helpSendPost: string;
  readonly helpApproveDrafts: string;
  readonly helpChangeMode: string;
  readonly helpWindow: string;
  readonly helpWebPanel: string;
  /** Callback answers (toasts) — combined panel. */
  readonly callbackApprovalOn: string;
  readonly callbackApprovalOff: string;
  readonly callbackDraftApproved: string;
  readonly callbackDraftAlreadyApproved: string;
  readonly callbackDraftRejected: string;
  readonly callbackDraftAlreadyRejected: string;
  readonly callbackDraftNotReady: string;
  readonly callbackDraftNotFound: string;
  readonly callbackDraftReevaluateUnavailable: string;
  readonly callbackTestAiUnavailable: string;
  readonly callbackClearQueueDone: (applied: number, skipped: number) => string;
  readonly callbackClearQueueEmpty: string;
  readonly callbackPausedCannotApprove: string;
  readonly callbackNoDestination: string;
  readonly callbackEnqueueFailed: string;
  readonly callbackInboundUnavailable: string;
  readonly callbackReviewUnavailable: string;
  /** Shared navigation. */
  readonly backButton: string;
  /** Callback answers (toasts). */
  readonly callbackInvalidToken: string;
  readonly callbackPermissionDenied: string;
  readonly callbackNoChange: string;
  readonly callbackModeSet: Readonly<Record<PublishMode, string>>;
  readonly callbackCapSet: (cap: number, effectiveFrom: string) => string;
  readonly callbackCapNoChange: (cap: number) => string;
  readonly callbackEventOn: string;
  readonly callbackEventOff: string;
  readonly callbackPostMgmtUnavailable: string;
  readonly callbackPinned: string;
  readonly callbackAlreadyPinned: string;
  readonly callbackPinFailed: string;
  readonly callbackUnpinned: string;
  readonly callbackNotPinned: string;
  readonly callbackDeleted: string;
  readonly callbackDeleteFailed: string;
  readonly callbackEditStarted: string;
  /** Slice 6 — the edit-capture completion replies (ingress, not panel). */
  readonly callbackEditDone: string;
  readonly callbackEditFailed: string;
  readonly callbackEditFailedRetryable: string;
  readonly callbackEditInvalidText: string;
  readonly callbackAutoPinOn: string;
  readonly callbackAutoPinOff: string;
  readonly callbackRetentionOn: string;
  readonly callbackRetentionOff: string;
}

export const ADMIN_PANEL_STRINGS: Readonly<Record<AdminUiLanguage, AdminPanelUiStrings>> = {
  en: {
    helpMenuLine: '/menu — Admin panel (mode, cap, schedule, drafts, posts, stats, AI & Soul)',
    permissionDenied:
      'Access denied: only the owner and chief editor can change publishing settings.',
    invalidUsage:
      'Invalid argument. Usage: /menu — /menu mode — /menu cap — /menu event — /menu schedule — /menu drafts — /menu posts — /menu manual — /menu ai — /menu settings — /menu stats — /menu admins — /menu debug — /menu help.',
    aiTitle: 'AI provider presence',
    aiWorkersAiBindingLabel: 'Workers AI binding:',
    aiGeminiKeyLabel: 'GEMINI_API_KEY:',
    aiGeminiEnabledLabel: 'AI_GEMINI_ENABLED:',
    aiPresent: 'present',
    aiAbsent: 'absent',
    aiFlagOn: 'ON',
    aiFlagOff: 'off',
    aiHint: 'Presence only — never secret values. Send /menu for the main panel.',
    aiPresenceUnavailable: 'AI presence is not available in this deployment.',
    mainTitle: '👾 Pixel — Dashboard',
    mainModeLabel: 'Mode:',
    mainCapLabel: 'Daily cap:',
    mainTodayLabel: 'Today:',
    mainEventLabel: 'Event mode:',
    mainEventOn: 'ON',
    mainEventOff: 'off',
    modeButton: 'Mode',
    capButton: 'Daily cap',
    eventButton: 'Event mode',
    modeTitle: 'Publishing mode',
    modeAutoDesc: 'auto — scheduled + direct, no preview',
    modeSafeAutoDesc: 'safe-auto — auto, but rumor/leak and low-score items go to approval',
    modeApprovalDesc: 'approval — every post needs a preview first',
    modePausedDesc: 'paused — nothing publishes; inbound posts are rejected',
    modeCurrentMarker: '● current',
    modeHint: 'Tap a mode to switch. Send /menu for the main panel.',
    capTitle: 'Daily cap',
    capCurrentLabel: 'Cap in force today:',
    capTodayLabel: 'Published today:',
    capPendingLabel: 'New cap from tomorrow:',
    capHint: 'A cap change takes effect from the next Tehran day, never mid-day.',
    eventTitle: 'Event mode',
    eventActiveLine: 'Event mode is ON — the daily cap is lifted.',
    eventInactiveLine: 'Event mode is off.',
    eventEndsLine:
      'It ends when you turn it off, after 6 hours, or after 2 hours with no fresh P0.',
    eventOnButton: 'Turn event ON',
    eventOffButton: 'Turn event OFF',
    eventHint: 'While active, the minimum gap is 8–15 minutes.',
    mainPinLabel: 'Pinned:',
    mainPinNone: 'none',
    postsButton: 'Posts',
    postsTitle: 'Channel posts',
    postsEmpty: 'No published posts yet.',
    postsFilterAll: 'All',
    postsFilterExpired: 'Expired',
    postsAutoPinLabel: 'Auto-pin P0:',
    postsAutoPinOnButton: 'Auto-pin P0: ON',
    postsAutoPinOffButton: 'Auto-pin P0: OFF',
    postsRetentionLine: (rule) =>
      `Retention: ${rule.enabled ? 'on' : 'off'} — expired after ${rule.defaultDays}d (${rule.freeGameDays}d for free games).`,
    postsRetentionOnButton: 'Retention: ON',
    postsRetentionOffButton: 'Retention: OFF',
    postsHint: 'Tap a post to open it. Send /menu for the main panel.',
    postDetailTitle: 'Post',
    postDetailCategoryLabel: 'Category:',
    postDetailPublishedLabel: 'Published:',
    postDetailPinnedLabel: 'Pinned:',
    postDetailExpiredLabel: 'Expired:',
    postDetailPinButton: 'Pin',
    postDetailUnpinButton: 'Unpin',
    postDetailEditButton: 'Edit',
    postDetailDeleteButton: 'Delete',
    deleteConfirmTitle: 'Delete this post?',
    deleteConfirmButton: 'Yes, delete',
    deleteCancelButton: 'Cancel',
    editPrompt: 'Send the new text for this post now (30 minutes).',
    mainSoulLabel: 'Soul:',
    mainAiLabel: 'AI:',
    mainWorkerLabel: 'Worker:',
    mainChannelEditLabel: 'Channel Edit:',
    mainChannelEditAlwaysOn: 'always on (edits update the channel within 48h)',
    scheduleButton: '📅 Schedule',
    draftsButton: '📚 Drafts & Queue',
    manualButton: '✍️ Manual Post',
    settingsButton: '⚙️ Settings',
    statsButton: '📊 Stats',
    helpButton: '❓ Help',
    refreshButton: '🔄 Refresh',
    adminsButton: '👥 Admins',
    approvalOnButton: '🟢 Approval: ON',
    approvalOffButton: '⚪ Approval: OFF',
    scheduleTitle: 'Schedule',
    schedulePostingLabel: 'Posting:',
    schedulePostingOn: 'on (auto)',
    schedulePostingOff: 'off (paused)',
    scheduleCapLabel: 'Daily cap:',
    scheduleWindowLabel: 'Window:',
    scheduleWindowValue: '07:00–02:00 Tehran',
    scheduleNextTickLabel: 'Next bridge tick:',
    scheduleNextTickValue: '~5 min',
    schedulePauseButton: '⏸️ Pause posting',
    scheduleResumeButton: '▶️ Resume posting',
    scheduleClearQueueButton: '🗑️ Clear queue',
    scheduleHint: 'Posting follows the 5-minute bridge tick. Send /menu for the main panel.',
    clearQueueConfirmTitle: 'Clear the publication queue?',
    clearQueueCountLine: (count) => `${count} waiting publications will be cancelled.`,
    clearQueueConfirmButton: 'Yes, clear queue',
    clearQueueCancelButton: 'Cancel',
    draftsTitle: 'Drafts & Queue',
    draftsEmpty: 'No ready drafts.',
    draftsCountsLine: (c) =>
      `Ready ${c.ready} · Approved ${c.approved} · Needs approval ${c.approvalRequired} · Rejected ${c.rejected} · Queued ${c.queued}`,
    draftsHint: 'Tap a draft to preview it. Send /menu for the main panel.',
    draftDetailTitle: 'Draft',
    draftDetailGateLabel: 'Fact-guard:',
    draftDetailFindingsLabel: 'findings',
    draftDetailPreviewButton: '👁️ Preview',
    draftDetailApproveButton: '✅ Approve',
    draftDetailRejectButton: '❌ Reject',
    draftDetailReevaluateButton: '🔄 Re-evaluate',
    manualTitle: 'Manual Post',
    manualInstructions:
      'Send a post in this chat — it goes through clean → classify → Soul rewrite → preview, then publishes (or waits for your approval in approval mode).',
    manualPendingLabel: 'Waiting for approval:',
    manualPendingEmpty: 'No posts waiting for approval.',
    manualExpiresLine: (hours) => `expires in ${hours}h`,
    manualRecentLabel: 'Your recent posts:',
    manualRecentEmpty: 'No owner posts yet.',
    manualHint: 'Send /menu for the main panel.',
    aiSoulTitle: 'AI & Soul',
    soulVersionLabel: 'Soul:',
    soulStatusLabel: 'Status:',
    soulCurrent: 'current',
    soulPersonaLabel: 'Persona:',
    soulUnavailable: 'Soul is not available in this deployment.',
    aiProvidersLabel: 'Providers:',
    aiGeminiRewriteLabel: 'Gemini (rewrite):',
    aiWorkersAiLabel: 'Workers AI (extraction):',
    aiImageLabel: 'Image generation:',
    aiFailoverLabel: 'Failover:',
    aiBackupTokenLabel: 'Backup token:',
    aiBackupConfigured: 'configured',
    aiBackupNotConfigured: 'not configured',
    testAiButton: '🧪 Test AI',
    settingsTitle: 'Settings',
    settingsGeneralHeader: 'General',
    settingsContentHeader: 'Content',
    settingsAiHeader: 'AI',
    settingsQualityHeader: 'Quality',
    settingsLanguageLabel: 'UI language:',
    settingsLanguageHint: 'Change it with /language (fa / en).',
    settingsFormLabel: 'Render form:',
    settingsFormValue:
      'Form #4 (approved 2026-11-22): Latin digits, main figure bold, no repetition, footer > 👾 @pixellores',
    settingsRewriteLabel: 'Rewrite (Gemini Soul rewrite):',
    settingsImageLabel: 'Image generation:',
    settingsFactGuardLabel: 'Fact-guard:',
    settingsFactGuardValue: 'strict (v1, digit folding)',
    statsTitle: 'Stats',
    statsTodayHeader: 'Today',
    statsTotalsHeader: 'Totals',
    statsAiHeader: 'AI today',
    statsWorkerHeader: 'Worker',
    statsPublishedLabel: 'Published:',
    statsOwnerLabel: 'Owner posts:',
    statsQueuedLabel: 'Queued:',
    statsRejectedLabel: 'Rejected drafts:',
    statsLastPublishedLabel: 'Last published:',
    statsLastPublishedNone: 'none yet',
    statsStoriesLabel: 'Stories:',
    statsDraftsLabel: 'Drafts:',
    statsClaimsLabel: 'Claims:',
    statsSourceItemsLabel: 'Source items:',
    statsGeminiCallsLabel: 'Gemini calls:',
    statsWorkersAiCallsLabel: 'Workers AI calls:',
    statsImageCallsLabel: 'Image calls:',
    statsVersionLabel: 'Version:',
    statsCommitLabel: 'Commit:',
    statsSchemaLabel: 'Schema:',
    statsHealthLabel: 'Health:',
    statsHealthOk: 'live',
    adminsTitle: 'Admins',
    adminsEmpty: 'No admins yet.',
    adminsManageOffNote: 'Admin management is off — this list is read-only.',
    adminsHint: 'Send /menu for the main panel.',
    debugTitle: 'Debug / Status',
    debugWorkerHeader: 'Worker',
    debugFlagsHeader: 'Feature flags',
    debugD1Header: 'D1',
    debugWebhookLabel: 'Webhook:',
    debugWebhookActive: 'active (this panel is served through it)',
    debugUnavailable: 'unavailable',
    helpTitle: 'Help',
    helpSendPost:
      'Send a post: write it in this chat — it is rewritten in the Soul voice, previewed, then published.',
    helpApproveDrafts: 'Approve drafts: /menu drafts — Preview, Approve, Reject.',
    helpChangeMode: 'Change mode/cap: /menu schedule — auto, safe-auto, approval, paused.',
    helpWindow: 'Posting window: 07:00–02:00 Tehran. Daily cap default: 15.',
    helpWebPanel: 'Web panel: coming in Phase 3 (same screens as this bot panel).',
    callbackApprovalOn: 'Approval ON — every post needs a preview first.',
    callbackApprovalOff: 'Approval OFF — drafts publish automatically.',
    callbackDraftApproved: 'Draft approved — queued for publishing.',
    callbackDraftAlreadyApproved: 'Draft is already approved — queued again.',
    callbackDraftRejected: 'Draft rejected.',
    callbackDraftAlreadyRejected: 'Draft is already rejected.',
    callbackDraftNotReady: 'This draft is no longer waiting — nothing changed.',
    callbackDraftNotFound: 'Draft not found.',
    callbackDraftReevaluateUnavailable:
      'Re-evaluation is not available yet — the bridge fix owns this path.',
    callbackTestAiUnavailable: 'Test AI is not available yet — no engine probe exists.',
    callbackClearQueueDone: (applied, skipped) =>
      `Queue cleared: ${applied} cancelled${skipped > 0 ? `, ${skipped} skipped` : ''}.`,
    callbackClearQueueEmpty: 'The queue is already empty.',
    callbackPausedCannotApprove: 'Mode is paused — switch mode first.',
    callbackNoDestination: 'No publish destination is configured.',
    callbackEnqueueFailed: 'Approved, but the queue refused it — tap Approve again to retry.',
    callbackInboundUnavailable: 'Inbound approvals are not available right now.',
    callbackReviewUnavailable: 'Draft preview is not available right now.',
    backButton: '‹ Back',
    callbackInvalidToken: 'This button is no longer valid.',
    callbackPermissionDenied:
      'Access denied: only the owner and chief editor can change publishing settings.',
    callbackNoChange: 'Nothing changed — the setting already has that value.',
    callbackModeSet: {
      auto: 'Mode set to auto.',
      'safe-auto': 'Mode set to safe-auto.',
      approval: 'Mode set to approval.',
      paused: 'Mode set to paused. Nothing will publish.',
    },
    callbackCapSet: (cap, effectiveFrom) => `Daily cap set to ${cap} from ${effectiveFrom}.`,
    callbackCapNoChange: (cap) => `Daily cap is already ${cap}.`,
    callbackEventOn: 'Event mode ON — the daily cap is lifted.',
    callbackEventOff: 'Event mode OFF.',
    callbackPostMgmtUnavailable: 'Post management is not available right now.',
    callbackPinned: 'Post pinned.',
    callbackAlreadyPinned: 'This post is already pinned.',
    callbackPinFailed: 'Pin failed — the post was not pinned.',
    callbackUnpinned: 'Post unpinned.',
    callbackNotPinned: 'This post is not pinned.',
    callbackDeleted: 'Post deleted.',
    callbackDeleteFailed: 'Delete failed — the post was not deleted.',
    callbackEditStarted: 'Edit started — send the new text now.',
    callbackEditDone: 'Post edited.',
    callbackEditFailed: 'Edit failed — the post was not changed.',
    callbackEditFailedRetryable: 'Edit failed for now — send the new text again to retry.',
    callbackEditInvalidText: 'The new text must be 1–4096 characters.',
    callbackAutoPinOn: 'Auto-pin P0 ON — very big news pins itself.',
    callbackAutoPinOff: 'Auto-pin P0 OFF.',
    callbackRetentionOn: 'Retention ON.',
    callbackRetentionOff: 'Retention OFF.',
  },
  fa: {
    helpMenuLine:
      '/menu — پنل مدیریت (حالت، سقف، زمان‌بندی، درفت‌ها، پست‌ها، آمار، هوش مصنوعی و سول)',
    permissionDenied: 'دسترسی رد شد: فقط مالک و سردبیر ارشد می‌توانند تنظیمات انتشار را عوض کنند.',
    invalidUsage:
      'پارامتر نامعتبر است. کاربرد: /menu — /menu mode — /menu cap — /menu event — /menu schedule — /menu drafts — /menu posts — /menu manual — /menu ai — /menu settings — /menu stats — /menu admins — /menu debug — /menu help.',
    aiTitle: 'وضعیت سرویس‌های هوش مصنوعی',
    aiWorkersAiBindingLabel: 'اتصال Workers AI:',
    aiGeminiKeyLabel: 'کلید GEMINI_API_KEY:',
    aiGeminiEnabledLabel: 'گزینهٔ AI_GEMINI_ENABLED:',
    aiPresent: 'موجود',
    aiAbsent: 'ناموجود',
    aiFlagOn: 'روشن',
    aiFlagOff: 'خاموش',
    aiHint: 'فقط حضور و غیاب — هرگز مقدار کلیدها. برای پنل اصلی /menu را بفرستید.',
    aiPresenceUnavailable: 'وضعیت سرویس‌های هوش مصنوعی در این استقرار در دسترس نیست.',
    mainTitle: '👾 پیکسل — داشبورد',
    mainModeLabel: 'حالت:',
    mainCapLabel: 'سقف روزانه:',
    mainTodayLabel: 'امروز:',
    mainEventLabel: 'حالت ایونت:',
    mainEventOn: 'روشن',
    mainEventOff: 'خاموش',
    modeButton: 'حالت',
    capButton: 'سقف روزانه',
    eventButton: 'حالت ایونت',
    modeTitle: 'حالت انتشار',
    modeAutoDesc: 'auto — زمان‌بندی‌شده + مستقیم، بدون پیش‌نمایش',
    modeSafeAutoDesc: 'safe-auto — خودکار، ولی شایعه/لیک و آیتم کم‌امتیاز به تأیید می‌رود',
    modeApprovalDesc: 'approval — هر پست اول پیش‌نمایش می‌خواهد',
    modePausedDesc: 'paused — هیچ‌چیز منتشر نمی‌شود؛ پست‌های ورودی رد می‌شوند',
    modeCurrentMarker: '● فعلی',
    modeHint: 'برای تغییر حالت، روی آن بزنید. برای پنل اصلی /menu را بفرستید.',
    capTitle: 'سقف روزانه',
    capCurrentLabel: 'سقف امروز:',
    capTodayLabel: 'منتشرشدهٔ امروز:',
    capPendingLabel: 'سقف جدید از فردا:',
    capHint: 'تغییر سقف از روز بعد تهران اثر می‌کند، هرگز وسط روز.',
    eventTitle: 'حالت ایونت',
    eventActiveLine: 'حالت ایونت روشن است — سقف روزانه برداشته شده است.',
    eventInactiveLine: 'حالت ایونت خاموش است.',
    eventEndsLine: 'با خاموش‌کردن دستی، بعد از ۶ ساعت، یا بعد از ۲ ساعت بدون P0 تازه تمام می‌شود.',
    eventOnButton: 'روشن‌کردن ایونت',
    eventOffButton: 'خاموش‌کردن ایونت',
    eventHint: 'تا وقتی فعال است، حداقل فاصله ۸ تا ۱۵ دقیقه است.',
    mainPinLabel: 'پین‌شده:',
    mainPinNone: 'هیچ',
    postsButton: 'پست‌ها',
    postsTitle: 'پست‌های چنل',
    postsEmpty: 'هنوز پستی منتشر نشده است.',
    postsFilterAll: 'همه',
    postsFilterExpired: 'منقضی‌شده',
    postsAutoPinLabel: 'پین خودکار P0:',
    postsAutoPinOnButton: 'پین خودکار P0: روشن',
    postsAutoPinOffButton: 'پین خودکار P0: خاموش',
    postsRetentionLine: (rule) =>
      `نگهداری: ${rule.enabled ? 'روشن' : 'خاموش'} — انقضا بعد از ${rule.defaultDays} روز (${rule.freeGameDays} روز برای بازی رایگان).`,
    postsRetentionOnButton: 'نگهداری: روشن',
    postsRetentionOffButton: 'نگهداری: خاموش',
    postsHint: 'برای بازکردن یک پست روی آن بزنید. برای پنل اصلی /menu را بفرستید.',
    postDetailTitle: 'پست',
    postDetailCategoryLabel: 'دسته:',
    postDetailPublishedLabel: 'منتشرشده:',
    postDetailPinnedLabel: 'پین‌شده:',
    postDetailExpiredLabel: 'منقضی‌شده:',
    postDetailPinButton: 'پین',
    postDetailUnpinButton: 'آنپین',
    postDetailEditButton: 'ادیت',
    postDetailDeleteButton: 'حذف',
    deleteConfirmTitle: 'این پست حذف شود؟',
    deleteConfirmButton: 'بله، حذف کن',
    deleteCancelButton: 'لغو',
    editPrompt: 'متن جدید این پست را همین حالا بفرستید (۳۰ دقیقه).',
    mainSoulLabel: 'سول:',
    mainAiLabel: 'هوش مصنوعی:',
    mainWorkerLabel: 'ورکر:',
    mainChannelEditLabel: 'ادیت چنل:',
    mainChannelEditAlwaysOn: 'همیشه روشن (ادیت‌ها ظرف ۴۸ ساعت روی چنل اعمال می‌شوند)',
    scheduleButton: '📅 زمان‌بندی',
    draftsButton: '📚 درفت‌ها و صف',
    manualButton: '✍️ پست دستی',
    settingsButton: '⚙️ تنظیمات',
    statsButton: '📊 آمار',
    helpButton: '❓ راهنما',
    refreshButton: '🔄 تازه‌سازی',
    adminsButton: '👥 ادمین‌ها',
    approvalOnButton: '🟢 تأیید: روشن',
    approvalOffButton: '⚪ تأیید: خاموش',
    scheduleTitle: 'زمان‌بندی',
    schedulePostingLabel: 'انتشار:',
    schedulePostingOn: 'روشن (auto)',
    schedulePostingOff: 'خاموش (paused)',
    scheduleCapLabel: 'سقف روزانه:',
    scheduleWindowLabel: 'پنجره:',
    scheduleWindowValue: '۰۷:۰۰ تا ۰۲:۰۰ تهران',
    scheduleNextTickLabel: 'تیک بعدی پل:',
    scheduleNextTickValue: 'حدود ۵ دقیقه',
    schedulePauseButton: '⏸️ توقف انتشار',
    scheduleResumeButton: '▶️ ازسرگیری انتشار',
    scheduleClearQueueButton: '🗑️ خالی‌کردن صف',
    scheduleHint: 'انتشار با تیک ۵ دقیقه‌ای پل انجام می‌شود. برای پنل اصلی /menu را بفرستید.',
    clearQueueConfirmTitle: 'صف انتشار خالی شود؟',
    clearQueueCountLine: (count) => `${count} انتشار منتظر لغو می‌شود.`,
    clearQueueConfirmButton: 'بله، صف خالی شود',
    clearQueueCancelButton: 'لغو',
    draftsTitle: 'درفت‌ها و صف',
    draftsEmpty: 'درفت آماده‌ای نیست.',
    draftsCountsLine: (c) =>
      `آماده ${c.ready} · تأییدشده ${c.approved} · نیازمند تأیید ${c.approvalRequired} · ردشده ${c.rejected} · در صف ${c.queued}`,
    draftsHint: 'برای پیش‌نمایش روی یک درفت بزنید. برای پنل اصلی /menu را بفرستید.',
    draftDetailTitle: 'درفت',
    draftDetailGateLabel: 'فکت‌گارد:',
    draftDetailFindingsLabel: 'یافته',
    draftDetailPreviewButton: '👁️ پیش‌نمایش',
    draftDetailApproveButton: '✅ تأیید',
    draftDetailRejectButton: '❌ رد',
    draftDetailReevaluateButton: '🔄 ارزیابی دوباره',
    manualTitle: 'پست دستی',
    manualInstructions:
      'یک پست در همین چت بفرستید — تمیزکاری ← دسته‌بندی ← بازنویسی با سول ← پیش‌نمایش را می‌گذراند، بعد منتشر می‌شود (یا در حالت approval منتظر تأیید شما می‌ماند).',
    manualPendingLabel: 'منتظر تأیید:',
    manualPendingEmpty: 'پستی منتظر تأیید نیست.',
    manualExpiresLine: (hours) => `انقضا تا ${hours} ساعت دیگر`,
    manualRecentLabel: 'پست‌های اخیر شما:',
    manualRecentEmpty: 'هنوز پستی از شما نیست.',
    manualHint: 'برای پنل اصلی /menu را بفرستید.',
    aiSoulTitle: 'هوش مصنوعی و سول',
    soulVersionLabel: 'سول:',
    soulStatusLabel: 'وضعیت:',
    soulCurrent: 'فعلی',
    soulPersonaLabel: 'شخصیت:',
    soulUnavailable: 'سول در این استقرار در دسترس نیست.',
    aiProvidersLabel: 'سرویس‌ها:',
    aiGeminiRewriteLabel: 'جمینای (بازنویسی):',
    aiWorkersAiLabel: 'Workers AI (استخراج):',
    aiImageLabel: 'تولید تصویر:',
    aiFailoverLabel: 'فیل‌اور:',
    aiBackupTokenLabel: 'توکن پشتیبان:',
    aiBackupConfigured: 'پیکربندی شده',
    aiBackupNotConfigured: 'پیکربندی نشده',
    testAiButton: '🧪 تست هوش مصنوعی',
    settingsTitle: 'تنظیمات',
    settingsGeneralHeader: 'عمومی',
    settingsContentHeader: 'محتوا',
    settingsAiHeader: 'هوش مصنوعی',
    settingsQualityHeader: 'کیفیت',
    settingsLanguageLabel: 'زبان رابط:',
    settingsLanguageHint: 'با /language عوض کنید (fa / en).',
    settingsFormLabel: 'فرم رندر:',
    settingsFormValue:
      'فرم #۴ (تأیید ۲۰۲۶-۱۱-۲۲): ارقام لاتین، عدد اصلی بولد، بدون تکرار، فوتر > 👾 @pixellores',
    settingsRewriteLabel: 'بازنویسی (سول جمینای):',
    settingsImageLabel: 'تولید تصویر:',
    settingsFactGuardLabel: 'فکت‌گارد:',
    settingsFactGuardValue: 'سخت‌گیرانه (v1، تا کردن ارقام)',
    statsTitle: 'آمار',
    statsTodayHeader: 'امروز',
    statsTotalsHeader: 'مجموع',
    statsAiHeader: 'هوش مصنوعی امروز',
    statsWorkerHeader: 'ورکر',
    statsPublishedLabel: 'منتشرشده:',
    statsOwnerLabel: 'پست‌های مالک:',
    statsQueuedLabel: 'در صف:',
    statsRejectedLabel: 'درفت‌های ردشده:',
    statsLastPublishedLabel: 'آخرین انتشار:',
    statsLastPublishedNone: 'هنوز هیچ',
    statsStoriesLabel: 'استوری‌ها:',
    statsDraftsLabel: 'درفت‌ها:',
    statsClaimsLabel: 'ادعاها:',
    statsSourceItemsLabel: 'آیتم‌های منبع:',
    statsGeminiCallsLabel: 'فراخوانی جمینای:',
    statsWorkersAiCallsLabel: 'فراخوانی Workers AI:',
    statsImageCallsLabel: 'فراخوانی تصویر:',
    statsVersionLabel: 'ورژن:',
    statsCommitLabel: 'کامیت:',
    statsSchemaLabel: 'اسکیما:',
    statsHealthLabel: 'سلامت:',
    statsHealthOk: 'زنده',
    adminsTitle: 'ادمین‌ها',
    adminsEmpty: 'هنوز ادمینی نیست.',
    adminsManageOffNote: 'مدیریت ادمین خاموش است — این لیست فقط‌خواندنی است.',
    adminsHint: 'برای پنل اصلی /menu را بفرستید.',
    debugTitle: 'دیباگ / وضعیت',
    debugWorkerHeader: 'ورکر',
    debugFlagsHeader: 'فلگ‌های قابلیت',
    debugD1Header: 'دیتابیس D1',
    debugWebhookLabel: 'وب‌هوک:',
    debugWebhookActive: 'فعال (این پنل از همین مسیر سرو می‌شود)',
    debugUnavailable: 'در دسترس نیست',
    helpTitle: 'راهنما',
    helpSendPost:
      'ارسال پست: در همین چت بنویسید — با صدای سول بازنویسی و پیش‌نمایش می‌شود، بعد منتشر می‌شود.',
    helpApproveDrafts: 'تأیید درفت: /menu drafts — پیش‌نمایش، تأیید، رد.',
    helpChangeMode: 'تغییر حالت/سقف: /menu schedule — auto، safe-auto، approval، paused.',
    helpWindow: 'پنجره انتشار: ۰۷:۰۰ تا ۰۲:۰۰ تهران. سقف روزانه پیش‌فرض: ۱۵.',
    helpWebPanel: 'پنل وب: در فاز ۳ می‌آید (همان صفحه‌های این پنل بات).',
    callbackApprovalOn: 'تأیید روشن شد — هر پست اول پیش‌نمایش می‌خواهد.',
    callbackApprovalOff: 'تأیید خاموش شد — درفت‌ها خودکار منتشر می‌شوند.',
    callbackDraftApproved: 'درفت تأیید شد — در صف انتشار قرار گرفت.',
    callbackDraftAlreadyApproved: 'درفت همین حالا تأیید است — دوباره در صف قرار گرفت.',
    callbackDraftRejected: 'درفت رد شد.',
    callbackDraftAlreadyRejected: 'درفت همین حالا رد شده است.',
    callbackDraftNotReady: 'این درفت دیگر منتظر نیست — چیزی تغییر نکرد.',
    callbackDraftNotFound: 'درفت پیدا نشد.',
    callbackDraftReevaluateUnavailable:
      'ارزیابی دوباره هنوز در دسترس نیست — فیکس پل مالک این مسیر است.',
    callbackTestAiUnavailable: 'تست هوش مصنوعی هنوز در دسترس نیست — پروب موتور وجود ندارد.',
    callbackClearQueueDone: (applied, skipped) =>
      `صف خالی شد: ${applied} لغو شد${skipped > 0 ? `، ${skipped} رد شد` : ''}.`,
    callbackClearQueueEmpty: 'صف همین حالا خالی است.',
    callbackPausedCannotApprove: 'حالت paused است — اول حالت را عوض کنید.',
    callbackNoDestination: 'مقصد انتشار پیکربندی نشده است.',
    callbackEnqueueFailed: 'تأیید شد، ولی صف رد کرد — دوباره روی تأیید بزنید.',
    callbackInboundUnavailable: 'تأییدیه‌های ورودی در حال حاضر در دسترس نیست.',
    callbackReviewUnavailable: 'پیش‌نمایش درفت در حال حاضر در دسترس نیست.',
    backButton: '‹ بازگشت',
    callbackInvalidToken: 'این دکمه دیگر معتبر نیست.',
    callbackPermissionDenied:
      'دسترسی رد شد: فقط مالک و سردبیر ارشد می‌توانند تنظیمات انتشار را عوض کنند.',
    callbackNoChange: 'چیزی تغییر نکرد — تنظیم همین حالا همین مقدار را داشت.',
    callbackModeSet: {
      auto: 'حالت روی auto تنظیم شد.',
      'safe-auto': 'حالت روی safe-auto تنظیم شد.',
      approval: 'حالت روی approval تنظیم شد.',
      paused: 'حالت روی paused تنظیم شد. هیچ‌چیز منتشر نمی‌شود.',
    },
    callbackCapSet: (cap, effectiveFrom) => `سقف روزانه از ${effectiveFrom} روی ${cap} تنظیم شد.`,
    callbackCapNoChange: (cap) => `سقف روزانه همین حالا ${cap} است.`,
    callbackEventOn: 'حالت ایونت روشن شد — سقف روزانه برداشته شد.',
    callbackEventOff: 'حالت ایونت خاموش شد.',
    callbackPostMgmtUnavailable: 'مدیریت پست در حال حاضر در دسترس نیست.',
    callbackPinned: 'پست پین شد.',
    callbackAlreadyPinned: 'این پست همین حالا پین است.',
    callbackPinFailed: 'پین ناموفق بود — پست پین نشد.',
    callbackUnpinned: 'پین پست برداشته شد.',
    callbackNotPinned: 'این پست پین نیست.',
    callbackDeleted: 'پست حذف شد.',
    callbackDeleteFailed: 'حذف ناموفق بود — پست حذف نشد.',
    callbackEditStarted: 'ادیت شروع شد — متن جدید را همین حالا بفرستید.',
    callbackEditDone: 'پست ویرایش شد.',
    callbackEditFailed: 'ادیت ناموفق بود — پست تغییر نکرد.',
    callbackEditFailedRetryable:
      'ادیت فعلاً ناموفق بود — متن جدید را دوباره بفرستید تا دوباره تلاش شود.',
    callbackEditInvalidText: 'متن جدید باید ۱ تا ۴۰۹۶ کاراکتر باشد.',
    callbackAutoPinOn: 'پین خودکار P0 روشن شد — خبر خیلی بزرگ خودش پین می‌شود.',
    callbackAutoPinOff: 'پین خودکار P0 خاموش شد.',
    callbackRetentionOn: 'نگهداری روشن شد.',
    callbackRetentionOff: 'نگهداری خاموش شد.',
  },
};
