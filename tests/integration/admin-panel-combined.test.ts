import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import {
  NOW,
  OWNER_ID,
  freshDb,
  seedAdmin,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import { parseMenuArgument } from '../../src/admin/panel-command';
import { ADMIN_PANEL_STRINGS } from '../../src/admin/panel-strings';
import {
  createAdminPanelService,
  type AdminPanelReplyResult,
} from '../../src/application/admin-panel/admin-panel-service';
import {
  approveDraftForHumanPublication,
  rejectDraftForHumanPublication,
} from '../../src/adapters/db/human-approval-store';
import { createInboundApproval, recordPublishedPost } from '../../src/adapters/db/inbound-store';
import {
  enqueuePublication,
  cancelPublicationById,
} from '../../src/adapters/db/publication-outbox-store';
import {
  readPublishingSettings,
  recordPublication,
  setPublishMode,
} from '../../src/adapters/db/publishing-settings-store';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';

/**
 * The combined admin panel (ADR-0075) over REAL workerd D1: the 14-screen
 * grammar, the Fredy-style dashboard (Approval toggle, Channel Edit as a
 * status line, owner-only Admins button), the Schedule screen + fenced
 * clear-queue, the Drafts queue with fenced human approve/reject (audit +
 * outbox enqueue + idempotency), the Manual Post screen with real inbound
 * approve/reject tokens, and the AI & Soul / Settings / Stats / Admins /
 * Debug / Help screens with their honest-unavailable paths. The ONLY
 * artificial pieces are the fixed test clock and the fake soul row.
 */

const CHIEF_EDITOR_ID = 2000000001;
const EDITOR_ID = 2000000002;
const VIEWER_ID = 2000000004;

const HOUR_MS = 60 * 60 * 1000;

const CHANNEL = '@pixellores';

async function cleanCombinedTables(): Promise<void> {
  // freshDb() does not clear these three (they belong to other suites'
  // slices) — the combined suite owns its rows, so it clears them.
  await env.DB.prepare('DELETE FROM publications').run();
  await env.DB.prepare('DELETE FROM inbound_approvals').run();
  await env.DB.prepare('DELETE FROM published_posts').run();
  await env.DB.prepare('DELETE FROM souls').run();
}

function buildPanel(input: { inboundEnabled?: boolean } = {}) {
  const executor = createDbExecutor(env.DB);
  return createAdminPanelService({
    executor,
    clock: fixedClock(NOW),
    ownerTelegramId: OWNER_ID,
    publishDestination: CHANNEL,
    workerInfo: {
      applicationVersion: '1.48.0',
      commit: 'testcommit',
      schemaVersion: 12,
    },
    featureFlags: {
      adminPanelEnabled: true,
      aiFailoverEnabled: false,
      aiImageEnabled: false,
      aiGeminiRewriteEnabled: false,
      eventRelationEnabled: false,
      backupTokenConfigured: false,
      adminManageEnabled: false,
      inboundEnabled: input.inboundEnabled ?? true,
    },
  });
}

/** The single-use token behind the first button whose text contains the label. */
function tokenFor(reply: AdminPanelReplyResult, labelPart: string): string {
  const button = reply.buttons?.flat().find((candidate) => candidate.text.includes(labelPart));
  expect(button, `expected a button containing "${labelPart}"`).toBeDefined();
  return button!.callbackData.slice(2);
}

async function seedReadyDraft(id: string, headline: string): Promise<void> {
  const storyId = `story-${id}`;
  await seedStory(storyId, headline);
  await seedDraft({
    id,
    storyId,
    status: 'ready',
    title: headline,
    documentJson: JSON.stringify({
      headlineFa: headline,
      fact_guard_v1: { counts: { numberFindings: 0 } },
    }),
  });
}

async function draftStatus(id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT status FROM drafts WHERE id = ?')
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function auditCount(action: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action = ?')
    .bind(action)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function seedSoul(): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO souls (version, text, sha256, created_by, created_at_ms) VALUES (1, ?, ?, ?, ?)',
  )
    .bind(
      'The plague doctor of the dark room.\nOne fact from the dark, every night.',
      'a'.repeat(64),
      OWNER_ID,
      NOW,
    )
    .run();
}

beforeEach(async () => {
  await freshDb();
  await cleanCombinedTables();
  await seedAdmin(OWNER_ID, 'owner');
  await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
  await seedAdmin(EDITOR_ID, 'editor');
  await seedAdmin(VIEWER_ID, 'viewer');
});

describe('the combined /menu grammar (pure)', () => {
  it('parses all 14 screens, rejects the bare-main form as an argument', () => {
    expect(parseMenuArgument(undefined)).toEqual({ kind: 'main' });
    expect(parseMenuArgument('')).toEqual({ kind: 'main' });
    for (const screen of [
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
    ] as const) {
      expect(parseMenuArgument(screen)).toEqual({ kind: 'screen', screen });
    }
    // 'main' is the bare /menu form — never a screen argument.
    expect(parseMenuArgument('main')).toEqual({ kind: 'invalid' });
    expect(parseMenuArgument('bogus')).toEqual({ kind: 'invalid' });
    expect(parseMenuArgument('mode cap')).toEqual({ kind: 'invalid' });
    expect(parseMenuArgument('MODE')).toEqual({ kind: 'invalid' });
    expect(parseMenuArgument('mode\ncap')).toEqual({ kind: 'invalid' });
  });
});

describe('the main dashboard (combined)', () => {
  it('shows mode/cap/event, the Approval toggle, and Channel Edit as a status line only', async () => {
    const panel = buildPanel();
    const main = await panel.main({ telegramUserId: OWNER_ID, role: 'owner', uiLanguage: 'en' });
    expect(main.text).toContain('Mode: auto');
    expect(main.text).toContain('Daily cap: 15');
    expect(main.text).toContain('Channel Edit:');
    expect(main.text).toContain('always on (edits update the channel within 48h)');
    expect(main.buttons?.flat().some((b) => b.text.includes('Approval: OFF'))).toBe(true);
    // Channel Edit has NO toggle button — it is a status line, not a setting.
    expect(main.buttons?.flat().some((b) => b.text.includes('Channel Edit'))).toBe(false);
  });

  it('shows the Admins button only to the owner; every role can still view', async () => {
    const panel = buildPanel();
    const ownerMain = await panel.main({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(ownerMain.buttons?.flat().some((b) => b.text.includes('Admins'))).toBe(true);
    const viewerMain = await panel.main({
      telegramUserId: VIEWER_ID,
      role: 'viewer',
      uiLanguage: 'en',
    });
    expect(viewerMain.text).toContain('Mode: auto');
    expect(viewerMain.buttons?.flat().some((b) => b.text.includes('Admins'))).toBe(false);
  });

  it('reading the dashboard never moves publishing state', async () => {
    const panel = buildPanel();
    await panel.main({ telegramUserId: OWNER_ID, role: 'owner', uiLanguage: 'en' });
    const executor = createDbExecutor(env.DB);
    expect((await readPublishingSettings(executor)).mode).toBe('auto');
    expect(await auditCount('publishing_mode_changed')).toBe(0);
  });
});

describe('the Approval toggle (design §2 row 5)', () => {
  it('flips approval ↔ auto through the audited mode store', async () => {
    const panel = buildPanel();
    const main = await panel.main({ telegramUserId: OWNER_ID, role: 'owner', uiLanguage: 'en' });
    const on = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(main, 'Approval: OFF'),
    });
    expect(on).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackApprovalOn,
    });
    const executor = createDbExecutor(env.DB);
    expect((await readPublishingSettings(executor)).mode).toBe('approval');
    const mainAfter = await panel.main({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
    });
    expect(mainAfter.buttons?.flat().some((b) => b.text.includes('Approval: ON'))).toBe(true);
    const off = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(mainAfter, 'Approval: ON'),
    });
    expect(off).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackApprovalOff,
    });
    expect((await readPublishingSettings(executor)).mode).toBe('auto');
  });

  it('denies the toggle to an editor and moves nothing', async () => {
    const panel = buildPanel();
    const editorMain = await panel.main({
      telegramUserId: EDITOR_ID,
      role: 'editor',
      uiLanguage: 'en',
    });
    const denied = await panel.handleCallback({
      telegramUserId: EDITOR_ID,
      role: 'editor',
      uiLanguage: 'en',
      token: tokenFor(editorMain, 'Approval: OFF'),
    });
    expect(denied).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackPermissionDenied,
    });
    const executor = createDbExecutor(env.DB);
    expect((await readPublishingSettings(executor)).mode).toBe('auto');
  });
});

describe('the Schedule screen and clear queue (design §4)', () => {
  it('shows posting state, cap, window, next tick, and the clear-queue button', async () => {
    const panel = buildPanel();
    const schedule = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'schedule',
    });
    expect(schedule.text).toContain('Posting: on (auto)');
    expect(schedule.text).toContain('Daily cap: 15');
    expect(schedule.text).toContain('Window: 07:00–02:00 Tehran');
    expect(schedule.text).toContain('Next bridge tick: ~5 min');
    expect(schedule.buttons?.flat().some((b) => b.text.includes('Clear queue'))).toBe(true);
  });

  it('clearing an empty queue shows the empty confirm screen (no dead confirm button)', async () => {
    const panel = buildPanel();
    const schedule = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'schedule',
    });
    const confirm = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(schedule, 'Clear queue'),
    });
    expect(confirm.kind).toBe('reply');
    if (confirm.kind === 'reply') {
      expect(confirm.text).toContain('Clear the publication queue?');
      expect(confirm.text).toContain('The queue is already empty.');
      expect(confirm.buttons).toBeUndefined();
    }
  });

  it('a queue that drains between confirm and tap answers the empty toast', async () => {
    const executor = createDbExecutor(env.DB);
    await seedReadyDraft('draft-clear-2', 'Drain race draft');
    await approveDraftForHumanPublication(executor, {
      draftId: 'draft-clear-2',
      actorId: OWNER_ID,
      nowMs: NOW,
    });
    const enqueued = await enqueuePublication(executor, {
      publicationId: 'pub:clear:2',
      draftId: 'draft-clear-2',
      destination: CHANNEL,
      priorityScore: 50,
      approvalMode: 'auto',
      nowMs: NOW,
      soulVersion: null,
    });
    expect(enqueued.kind).toBe('created');
    const panel = buildPanel();
    const schedule = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'schedule',
    });
    const confirm = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(schedule, 'Clear queue'),
    });
    expect(confirm.kind).toBe('reply');
    if (confirm.kind !== 'reply') return;
    expect(confirm.text).toContain('1 waiting publications will be cancelled.');
    // The worker claims the row between the confirm screen and the tap.
    await cancelPublicationById(executor, {
      publicationId: 'pub:clear:2',
      actorId: String(OWNER_ID),
      nowMs: NOW,
    });
    const done = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(confirm, 'Yes, clear queue'),
    });
    expect(done).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackClearQueueEmpty,
    });
  });

  it('cancels a due publication through the fenced disposition', async () => {
    const executor = createDbExecutor(env.DB);
    await seedReadyDraft('draft-clear-1', 'Clear queue draft');
    // The outbox only accepts an approved draft (MODE_STATUS_MATRIX) —
    // approve it first, exactly as the panel's Approve flow does.
    await approveDraftForHumanPublication(executor, {
      draftId: 'draft-clear-1',
      actorId: OWNER_ID,
      nowMs: NOW,
    });
    const enqueued = await enqueuePublication(executor, {
      publicationId: 'pub:clear:1',
      draftId: 'draft-clear-1',
      destination: CHANNEL,
      priorityScore: 50,
      approvalMode: 'auto',
      nowMs: NOW,
      soulVersion: null,
    });
    expect(enqueued.kind).toBe('created');
    const panel = buildPanel();
    const schedule = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'schedule',
    });
    const confirm = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(schedule, 'Clear queue'),
    });
    expect(confirm.kind).toBe('reply');
    if (confirm.kind === 'reply') {
      expect(confirm.text).toContain('1 waiting publications will be cancelled.');
      const done = await panel.handleCallback({
        telegramUserId: OWNER_ID,
        role: 'owner',
        uiLanguage: 'en',
        token: tokenFor(confirm, 'Yes, clear queue'),
      });
      expect(done).toEqual({
        kind: 'answer',
        callbackText: ADMIN_PANEL_STRINGS.en.callbackClearQueueDone(1, 0),
      });
    }
    const row = await env.DB.prepare('SELECT status FROM publications WHERE id = ?')
      .bind('pub:clear:1')
      .first<{ status: string }>();
    expect(row?.status).toBe('cancelled');
  });
});

describe('draft approve / reject (fenced, audited, idempotent)', () => {
  it('lists ready drafts with counts, and the detail shows the honest preview note', async () => {
    await seedReadyDraft('draft-list-1', 'List me draft');
    const panel = buildPanel();
    const drafts = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'drafts',
    });
    expect(drafts.text).toContain(
      'Ready 1 · Approved 0 · Needs approval 0 · Rejected 0 · Queued 0',
    );
    expect(drafts.text).toContain('List me draft');
    const detail = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(drafts, 'List me draft'),
    });
    expect(detail.kind).toBe('reply');
    if (detail.kind === 'reply') {
      expect(detail.text).toContain('List me draft');
      expect(detail.text).toContain('Draft preview is not available right now.');
      expect(detail.buttons?.flat().some((b) => b.text.includes('Approve'))).toBe(true);
      expect(detail.buttons?.flat().some((b) => b.text.includes('Reject'))).toBe(true);
    }
  });

  it('approve moves ready → approved, audits, and enqueues at priority 80', async () => {
    await seedReadyDraft('draft-approve-1', 'Approve me draft');
    const panel = buildPanel();
    const drafts = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'drafts',
    });
    const detail = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(drafts, 'Approve me draft'),
    });
    expect(detail.kind).toBe('reply');
    if (detail.kind !== 'reply') return;
    const approved = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(detail, 'Approve'),
    });
    expect(approved).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackDraftApproved,
    });
    expect(await draftStatus('draft-approve-1')).toBe('approved');
    expect(await auditCount('draft_approved')).toBe(1);
    const pub = await env.DB.prepare(
      'SELECT status, priority, approval_mode FROM publications WHERE id = ?',
    )
      .bind('pub:human:draft-approve-1')
      .first<{ status: string; priority: number; approval_mode: string }>();
    expect(pub).toEqual({ status: 'pending', priority: 80, approval_mode: 'auto' });
  });

  it('an approved draft shows no Approve button on its detail', async () => {
    await seedReadyDraft('draft-approve-2', 'Already approved draft');
    const panel = buildPanel();
    const drafts = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'drafts',
    });
    const detail = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(drafts, 'Already approved draft'),
    });
    expect(detail.kind).toBe('reply');
    if (detail.kind !== 'reply') return;
    await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(detail, 'Approve'),
    });
    const again = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'drafts',
    });
    // The draft left the ready list — the queue is empty again.
    expect(again.text).toContain('No ready drafts.');
  });

  it('an editor cannot approve: denied, draft stays ready, nothing audited', async () => {
    await seedReadyDraft('draft-approve-3', 'Editor cannot approve draft');
    const panel = buildPanel();
    const drafts = await panel.screen({
      telegramUserId: EDITOR_ID,
      role: 'editor',
      uiLanguage: 'en',
      screen: 'drafts',
    });
    const detail = await panel.handleCallback({
      telegramUserId: EDITOR_ID,
      role: 'editor',
      uiLanguage: 'en',
      token: tokenFor(drafts, 'Editor cannot approve'),
    });
    expect(detail.kind).toBe('reply');
    if (detail.kind !== 'reply') return;
    const denied = await panel.handleCallback({
      telegramUserId: EDITOR_ID,
      role: 'editor',
      uiLanguage: 'en',
      token: tokenFor(detail, 'Approve'),
    });
    expect(denied).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackPermissionDenied,
    });
    expect(await draftStatus('draft-approve-3')).toBe('ready');
    expect(await auditCount('draft_approved')).toBe(0);
  });

  it('approve while paused answers honestly and moves nothing', async () => {
    await seedReadyDraft('draft-approve-4', 'Paused cannot approve draft');
    const executor = createDbExecutor(env.DB);
    await setPublishMode(executor, { mode: 'paused', actorId: OWNER_ID, nowMs: NOW });
    const panel = buildPanel();
    const drafts = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'drafts',
    });
    const detail = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(drafts, 'Paused cannot approve'),
    });
    expect(detail.kind).toBe('reply');
    if (detail.kind !== 'reply') return;
    const paused = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(detail, 'Approve'),
    });
    expect(paused).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackPausedCannotApprove,
    });
    expect(await draftStatus('draft-approve-4')).toBe('ready');
  });

  it('reject moves ready → rejected, audits, and never deletes the draft', async () => {
    await seedReadyDraft('draft-reject-1', 'Reject me draft');
    const panel = buildPanel();
    const drafts = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'drafts',
    });
    const detail = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(drafts, 'Reject me draft'),
    });
    expect(detail.kind).toBe('reply');
    if (detail.kind !== 'reply') return;
    const rejected = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(detail, 'Reject'),
    });
    expect(rejected).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackDraftRejected,
    });
    expect(await draftStatus('draft-reject-1')).toBe('rejected');
    expect(await auditCount('draft_rejected')).toBe(1);
  });

  it('re-evaluate answers the honest-unavailable toast (the bridge owns that path)', async () => {
    await seedReadyDraft('draft-reeval-1', 'Re-evaluate me draft');
    const panel = buildPanel();
    const drafts = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'drafts',
    });
    const detail = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(drafts, 'Re-evaluate me draft'),
    });
    expect(detail.kind).toBe('reply');
    if (detail.kind !== 'reply') return;
    const unavailable = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(detail, 'Re-evaluate'),
    });
    expect(unavailable).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackDraftReevaluateUnavailable,
    });
    expect(await draftStatus('draft-reeval-1')).toBe('ready');
  });
});

describe('the human approval store (fenced transitions)', () => {
  it('approve is idempotent: the second call absorbs, no second audit row', async () => {
    await seedReadyDraft('draft-store-1', 'Store approve draft');
    const executor = createDbExecutor(env.DB);
    const first = await approveDraftForHumanPublication(executor, {
      draftId: 'draft-store-1',
      actorId: OWNER_ID,
      nowMs: NOW,
    });
    expect(first.kind).toBe('applied');
    const second = await approveDraftForHumanPublication(executor, {
      draftId: 'draft-store-1',
      actorId: OWNER_ID,
      nowMs: NOW,
    });
    expect(second.kind).toBe('already_approved');
    expect(await auditCount('draft_approved')).toBe(1);
  });

  it('approve of a missing draft and reject-after-approve are fenced', async () => {
    const executor = createDbExecutor(env.DB);
    expect(
      await approveDraftForHumanPublication(executor, {
        draftId: 'draft-missing',
        actorId: OWNER_ID,
        nowMs: NOW,
      }),
    ).toEqual({ kind: 'draft_not_found' });
    await seedReadyDraft('draft-store-2', 'Store reject draft');
    await approveDraftForHumanPublication(executor, {
      draftId: 'draft-store-2',
      actorId: OWNER_ID,
      nowMs: NOW,
    });
    expect(
      await rejectDraftForHumanPublication(executor, {
        draftId: 'draft-store-2',
        actorId: OWNER_ID,
        nowMs: NOW,
      }),
    ).toEqual({ kind: 'not_ready' });
  });

  it('reject is idempotent: the second call absorbs, no second audit row', async () => {
    await seedReadyDraft('draft-store-3', 'Store reject twice draft');
    const executor = createDbExecutor(env.DB);
    const first = await rejectDraftForHumanPublication(executor, {
      draftId: 'draft-store-3',
      actorId: OWNER_ID,
      nowMs: NOW,
    });
    expect(first.kind).toBe('applied');
    const second = await rejectDraftForHumanPublication(executor, {
      draftId: 'draft-store-3',
      actorId: OWNER_ID,
      nowMs: NOW,
    });
    expect(second.kind).toBe('already_rejected');
    expect(await auditCount('draft_rejected')).toBe(1);
  });
});

describe('the Manual Post screen (design §7)', () => {
  it('says honestly when the inbound pipeline is not wired', async () => {
    const panel = buildPanel({ inboundEnabled: false });
    const manual = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'manual',
    });
    expect(manual.text).toContain('Inbound approvals are not available right now.');
    expect(manual.text).toContain('No owner posts yet.');
  });

  it('lists pending approvals with real inbound approve/reject buttons, plus recent posts', async () => {
    const executor = createDbExecutor(env.DB);
    await createInboundApproval(executor, {
      id: 'inb-test-1',
      sourceChatId: OWNER_ID,
      sourceMessageId: 77,
      sourceUpdateId: 1001,
      createdByUserId: OWNER_ID,
      contentJson: JSON.stringify({ parts: [{ text: 'Test owner post text' }] }),
      fingerprint: 'f'.repeat(64),
      category: 'news',
      presentation: 'classic',
      expiresAtMs: NOW + 6 * HOUR_MS,
      nowMs: NOW,
    });
    await recordPublishedPost(executor, {
      id: 'pub-post-1',
      sourceChatId: OWNER_ID,
      sourceMessageId: 78,
      channelMessageIds: [1234],
      kind: 'text',
      mediaFileId: null,
      category: 'news',
      presentation: 'classic',
      createdByUserId: OWNER_ID,
      soulVersion: null,
      nowMs: NOW,
    });
    const panel = buildPanel();
    const manual = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'manual',
    });
    expect(manual.text).toContain(
      '#test-1 · news · classic · expires in 6h — Test owner post text',
    );
    expect(manual.text).toContain('#1234 · news · 2025-10-09');
    const labels = manual.buttons?.flat().map((b) => b.text) ?? [];
    expect(labels).toContain('✅ #test-1');
    expect(labels).toContain('❌ #test-1');
    // The tokens are real single-use tokens (the ingress dispatches them to
    // the inbound service — the panel itself never consumes them).
    expect(
      manual.buttons
        ?.flat()
        .find((b) => b.text === '✅ #test-1')
        ?.callbackData.startsWith('a:'),
    ).toBe(true);
  });
});

describe('AI & Soul / Settings / Stats / Admins / Debug / Help', () => {
  it('the AI screen shows the Soul version + persona line when seeded, flags off otherwise', async () => {
    await seedSoul();
    const panel = buildPanel();
    const ai = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'ai',
    });
    expect(ai.text).toContain('Soul: v1 · current');
    expect(ai.text).toContain('Persona: The plague doctor of the dark room.');
    expect(ai.text).toContain('Image generation: off');
    expect(ai.text).toContain('Failover: off');
    const unavailable = await panel.handleCallback({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      token: tokenFor(ai, 'Test AI'),
    });
    expect(unavailable).toEqual({
      kind: 'answer',
      callbackText: ADMIN_PANEL_STRINGS.en.callbackTestAiUnavailable,
    });
  });

  it('the AI screen says honestly when no Soul is seeded', async () => {
    const panel = buildPanel();
    const ai = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'ai',
    });
    expect(ai.text).toContain('Soul is not available in this deployment.');
  });

  it('the Settings screen groups the real values: form #4, fact-guard v1, language hint', async () => {
    const panel = buildPanel();
    const settings = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'settings',
    });
    expect(settings.text).toContain('Form #4 (approved 2026-11-22)');
    expect(settings.text).toContain('Fact-guard: strict (v1, digit folding)');
    expect(settings.text).toContain('UI language: en');
    expect(settings.text).toContain('Change it with /language (fa / en).');
  });

  it('the Stats screen counts today, totals, and AI calls from D1', async () => {
    const executor = createDbExecutor(env.DB);
    await recordPublication(executor, { isP0: false, nowMs: NOW });
    await recordPublication(executor, { isP0: false, nowMs: NOW });
    await seedReadyDraft('draft-stats-1', 'Stats draft');
    const panel = buildPanel();
    const stats = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'stats',
    });
    expect(stats.text).toContain('Published: 2 of 15');
    expect(stats.text).toContain('Drafts: 1');
    expect(stats.text).toContain('Version: 1.48.0');
    expect(stats.text).toContain('Last published: none yet');
  });

  it('the Admins screen is owner-only: the list for the owner, a denial for a viewer', async () => {
    const panel = buildPanel();
    const ownerAdmins = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'admins',
    });
    expect(ownerAdmins.text).toContain(String(OWNER_ID));
    expect(ownerAdmins.text).toContain(String(CHIEF_EDITOR_ID));
    expect(ownerAdmins.text).toContain('Admin management is off');
    const viewerAdmins = await panel.screen({
      telegramUserId: VIEWER_ID,
      role: 'viewer',
      uiLanguage: 'en',
      screen: 'admins',
    });
    expect(viewerAdmins.text).toContain(ADMIN_PANEL_STRINGS.en.permissionDenied);
    expect(viewerAdmins.text).not.toContain(String(CHIEF_EDITOR_ID));
  });

  it('the Debug screen shows worker metadata, flags, and D1 totals', async () => {
    await seedReadyDraft('draft-debug-1', 'Debug draft');
    const panel = buildPanel();
    const debug = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'debug',
    });
    expect(debug.text).toContain('Version: 1.48.0');
    expect(debug.text).toContain('Commit: testcommit');
    expect(debug.text).toContain('Schema: 12');
    expect(debug.text).toContain('AI_FAILOVER_ENABLED off');
    expect(debug.text).toContain('ADMIN_POST_ENABLED ON');
    expect(debug.text).toContain('Drafts: 1');
  });

  it('the Help screen carries the short how-to', async () => {
    const panel = buildPanel();
    const help = await panel.screen({
      telegramUserId: OWNER_ID,
      role: 'owner',
      uiLanguage: 'en',
      screen: 'help',
    });
    expect(help.text).toContain('Send a post: write it in this chat');
    expect(help.text).toContain('Approve drafts: /menu drafts');
  });
});
