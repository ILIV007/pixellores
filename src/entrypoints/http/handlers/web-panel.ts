/**
 * Site admin panel HTTP handler (ADR-0081).
 *
 * Surface:
 *   GET  /admin             → the shell (no data, no auth — the API
 *                              enforces the session, the shell is static)
 *   GET  /admin/app.js      → the SPA script
 *   GET  /admin/app.css     → the stylesheet
 *   POST /api/admin/auth    → Telegram Login Widget verification → session
 *                              cookie (the ONLY unauthenticated API call)
 *   GET  /api/admin/me      → the session's user + role
 *   POST /api/admin/logout  → clears the session cookie
 *   GET  /api/admin/*       → reads (dashboard, queue, drafts/:id, posts,
 *                              schedule, soul, settings, stats, admins,
 *                              manual, providers, debug)
 *   POST /api/admin/*       → mutations (approve/reject/cancel, mode/cap/
 *                              event, pin/unpin/delete/edit, auto-pin,
 *                              retention, provider toggle, admin add/remove)
 *
 * Fail-closed, everywhere:
 * - The `ADMIN_WEB_PANEL_ENABLED` flag is OFF → every route here answers
 *   the uniform safe 404 (the same 404 as an unknown route — probing
 *   reveals neither the route nor the flag).
 * - No session, a tampered/expired session, or a user with no admin role
 *   → 401. A role without `dashboard.view` never reaches the service.
 * - Missing OWNER_TELEGRAM_ID / WEBHOOK_SECRET / BOT_TOKEN (auth only)
 *   → 503 config_invalid. The session secret is the existing
 *   WEBHOOK_SECRET; no new secret is minted for the panel.
 * - Unknown routes and wrong methods on known paths → the uniform 404.
 *
 * Outcomes are outcome-shaped, not exceptions: a mutation returns 200
 * with its `{kind}` (denied / not_found / invalid / transport_unavailable
 * / no_destination / applied / …) and the UI toasts the kind. Only
 * auth failures (401), malformed input (400), a missing draft on the
 * preview read (404), and configuration failures (503) are HTTP errors.
 * Logs carry the action + outcome kind only — never ids, never values.
 */
import { AppError } from '../../../shared/errors/app-error';
import type { WorkerEnv } from '../../../shared/types/env';
import type { Logger } from '../../../observability/logger';
import { createDbExecutor, type DbExecutor } from '../../../adapters/db/db-executor';
import { systemClock } from '../../../shared/time/clock';
import { parseAdminReviewConfig } from '../../../shared/config/phase9';
import {
  parseTelegramPhase2Config,
  type TelegramPhase2Config,
} from '../../../shared/config/phase2';
import { parseAiConfig } from '../../../shared/config/phase6';
import { parseWorkerConfig } from '../../../shared/config/phase0';
import { parseDataFoundationConfig } from '../../../shared/config/phase1a';
import { createBotApiClient } from '../../../adapters/telegram/bot-api-client';
import { createAuthorizationService } from '../../../admin/authorization';
import { createAdminRoleLookup } from '../../../adapters/telegram/admin-lookup';
import { roleHasPermission, type AdminRole } from '../../../admin/roles';
import {
  createWebPanelService,
  type WebPanelService,
} from '../../../application/web-panel/web-panel-service';
import {
  verifyTelegramLogin,
  type TelegramLoginData,
} from '../../../application/web-panel/telegram-login';
import {
  buildSessionClearCookie,
  buildSessionSetCookie,
  issueAdminSession,
  readSessionCookie,
  verifyAdminSession,
} from '../../../application/web-panel/session';
import {
  ADMIN_APP_CSS,
  ADMIN_APP_JS,
  ADMIN_SHELL_HTML,
} from '../../../application/web-panel/web-panel-ui';
import { cssResponse, htmlResponse, jsResponse, jsonResponse } from '../responses';
import { POST_EDIT_MAX_CHARS } from '../../../application/publishing/post-management-service';
import type { ChannelPostRefType } from '../../../domain/publishing/post-management';

export interface WebPanelRouteContext {
  readonly logger: Logger;
}

const MAX_ID_LENGTH = 128;
const MAX_CATEGORY_LENGTH = 64;

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isValidChannelMessageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidRefType(value: unknown): value is ChannelPostRefType {
  return value === 'publication' || value === 'inbound';
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

interface SessionIdentity {
  readonly userId: number;
  readonly firstName: string | null;
  readonly role: AdminRole;
}

async function requireSession(input: {
  readonly request: Request;
  readonly executor: DbExecutor;
  readonly ownerTelegramId: number;
  readonly webhookSecret: string;
}): Promise<SessionIdentity> {
  const cookieValue = readSessionCookie(input.request.headers.get('cookie'));
  if (cookieValue === null) {
    throw new AppError('unauthorized');
  }
  const session = await verifyAdminSession({
    cookieValue,
    secret: input.webhookSecret,
    nowMs: systemClock.now(),
  });
  if (session === null) {
    throw new AppError('unauthorized');
  }
  // The role resolves FRESH from D1 on every call (the authorization
  // service's contract): a deactivated admin loses access immediately.
  // A DB failure during lookup THROWS — a transient internal failure,
  // never a denial.
  const authorization = createAuthorizationService({
    ownerTelegramId: input.ownerTelegramId,
    lookup: createAdminRoleLookup(input.executor),
  });
  const actor = await authorization.resolveActor(session.userId);
  if (actor.kind !== 'authorized' || !roleHasPermission(actor.role, 'dashboard.view')) {
    throw new AppError('unauthorized');
  }
  return { userId: session.userId, firstName: session.firstName, role: actor.role };
}

function buildService(input: {
  readonly env: WorkerEnv;
  readonly executor: DbExecutor;
  readonly phase2Config: TelegramPhase2Config;
  readonly ownerTelegramId: number;
  readonly adminManageEnabled: boolean;
  readonly logger: Logger;
}): WebPanelService {
  const ai = parseAiConfig(input.env as Readonly<Record<string, unknown>>);
  const worker = parseWorkerConfig(input.env as Readonly<Record<string, unknown>>);
  const data = parseDataFoundationConfig(
    input.env as Readonly<Record<string, unknown>>,
    worker.config.ENVIRONMENT,
  );
  if (!worker.result.ok || data.config === null) {
    throw new AppError('config_invalid');
  }
  const botApi =
    input.phase2Config.botToken !== undefined
      ? createBotApiClient({ botToken: input.phase2Config.botToken, logger: input.logger })
      : undefined;
  return createWebPanelService({
    executor: input.executor,
    clock: systemClock,
    channelChatId: input.phase2Config.targetChannel,
    transport: botApi,
    ownerTelegramId: input.ownerTelegramId,
    adminManageEnabled: input.adminManageEnabled,
    aiFlags: {
      aiEnabled: ai.config.AI_ENABLED,
      geminiEnabled: ai.config.AI_GEMINI_ENABLED,
      imageEnabled: ai.config.AI_IMAGE_ENABLED,
      failoverEnabled: ai.config.AI_FAILOVER_ENABLED,
      geminiRewriteEnabled: ai.config.AI_GEMINI_REWRITE_ENABLED,
      eventRelationEnabled: ai.config.EVENT_RELATION_ENABLED,
    },
    buildInfo: {
      version: worker.config.APP_VERSION,
      commit: data.config.APP_COMMIT,
      schema: data.config.schemaVersion,
    },
    logger: input.logger,
  });
}

async function handleAuth(input: {
  readonly request: Request;
  readonly executor: DbExecutor;
  readonly ownerTelegramId: number;
  readonly webhookSecret: string;
  readonly botToken: string | undefined;
}): Promise<Response> {
  if (input.botToken === undefined) {
    // Without the bot token the widget data cannot be verified — fail
    // closed, never accept an unverified login.
    throw new AppError('config_invalid');
  }
  const body = await readJsonBody(input.request);
  if (body === null) {
    throw new AppError('bad_request');
  }
  const verification = await verifyTelegramLogin(
    body as unknown as TelegramLoginData,
    input.botToken,
    systemClock.now(),
  );
  if (verification.kind === 'rejected') {
    throw new AppError('unauthorized');
  }
  const user = verification.user;
  const authorization = createAuthorizationService({
    ownerTelegramId: input.ownerTelegramId,
    lookup: createAdminRoleLookup(input.executor),
  });
  const actor = await authorization.resolveActor(user.id);
  if (actor.kind !== 'authorized') {
    // Verified Telegram user, not an admin — no session is issued.
    throw new AppError('unauthorized');
  }
  const cookieValue = await issueAdminSession({
    userId: user.id,
    firstName: user.firstName,
    secret: input.webhookSecret,
    nowMs: systemClock.now(),
  });
  const secure = new URL(input.request.url).protocol === 'https:';
  return jsonResponse(
    200,
    {
      userId: user.id,
      role: actor.role,
      firstName: user.firstName,
      username: user.username ?? null,
    },
    { 'set-cookie': buildSessionSetCookie(cookieValue, secure) },
  );
}

export async function handleWebPanel(
  request: Request,
  env: WorkerEnv,
  ctx: WebPanelRouteContext,
): Promise<Response> {
  const { config: reviewConfig } = parseAdminReviewConfig(env as Readonly<Record<string, unknown>>);
  if (!reviewConfig.webPanelEnabled) {
    throw new AppError('not_found');
  }
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Static surface — no data, no auth (the API enforces the session).
  if (method === 'GET' && path === '/admin') {
    return htmlResponse(ADMIN_SHELL_HTML);
  }
  if (method === 'GET' && path === '/admin/app.js') {
    return jsResponse(ADMIN_APP_JS);
  }
  if (method === 'GET' && path === '/admin/app.css') {
    return cssResponse(ADMIN_APP_CSS);
  }
  if (!path.startsWith('/api/admin/')) {
    throw new AppError('not_found');
  }

  const phase2 = parseTelegramPhase2Config(env as Readonly<Record<string, unknown>>);
  const phase2Config = phase2.config;
  if (phase2Config === null) {
    // A misconfigured Telegram ingress is a nonexistent route (the
    // webhook's treatment): without it the panel can neither verify
    // logins nor resolve roles.
    throw new AppError('not_found');
  }
  const ownerTelegramId = phase2Config.ownerTelegramId;
  if (ownerTelegramId === undefined) {
    throw new AppError('config_invalid');
  }
  const webhookSecret = phase2Config.webhookSecret;
  if (webhookSecret === undefined) {
    throw new AppError('config_invalid');
  }
  // Durable auth + audit require D1 (no in-memory-only sessions): without
  // the binding the panel fails closed as unavailable (the webhook's
  // treatment of a missing DB).
  if (env.DB === undefined) {
    throw new AppError('service_unavailable');
  }
  const executor = createDbExecutor(env.DB);

  if (method === 'POST' && path === '/api/admin/auth') {
    return await handleAuth({
      request,
      executor,
      ownerTelegramId,
      webhookSecret,
      botToken: phase2Config.botToken,
    });
  }

  const identity = await requireSession({ request, executor, ownerTelegramId, webhookSecret });
  const service = buildService({
    env,
    executor,
    phase2Config,
    ownerTelegramId,
    adminManageEnabled: reviewConfig.adminManageEnabled,
    logger: ctx.logger,
  });

  const segments = path.split('/').filter((segment) => segment.length > 0);
  // segments: ['api', 'admin', <resource>, <id?>, <action?>]
  const resource = segments[2];
  const id = segments[3];
  const action = segments[4];

  function logMutation(route: string, kind: string): void {
    ctx.logger.info('webpanel.api', { action: route, kind });
  }

  // --- Reads -------------------------------------------------------------
  if (method === 'GET' && path === '/api/admin/me') {
    return jsonResponse(200, {
      userId: identity.userId,
      role: identity.role,
      firstName: identity.firstName,
    });
  }
  if (method === 'GET' && path === '/api/admin/dashboard') {
    return jsonResponse(200, await service.getDashboard());
  }
  if (method === 'GET' && path === '/api/admin/queue') {
    return jsonResponse(200, await service.getQueue());
  }
  if (method === 'GET' && resource === 'drafts' && id !== undefined && action === undefined) {
    if (!isValidId(id)) {
      throw new AppError('bad_request');
    }
    const preview = await service.getDraftPreview(decodeURIComponent(id));
    if (preview === null) {
      throw new AppError('not_found');
    }
    return jsonResponse(200, preview);
  }
  if (method === 'GET' && path === '/api/admin/posts') {
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    if (status !== null && status !== 'all' && status !== 'published' && status !== 'expired') {
      throw new AppError('bad_request');
    }
    if (category !== null && (category.length === 0 || category.length > MAX_CATEGORY_LENGTH)) {
      throw new AppError('bad_request');
    }
    return jsonResponse(
      200,
      await service.getPosts({
        ...(status !== null ? { status: status as 'all' | 'published' | 'expired' } : {}),
        ...(category !== null ? { category } : {}),
      }),
    );
  }
  if (method === 'GET' && path === '/api/admin/schedule') {
    return jsonResponse(200, await service.getSchedule());
  }
  if (method === 'GET' && path === '/api/admin/soul') {
    return jsonResponse(200, await service.getSoul());
  }
  if (method === 'GET' && path === '/api/admin/settings') {
    return jsonResponse(200, await service.getSettings());
  }
  if (method === 'GET' && path === '/api/admin/stats') {
    return jsonResponse(200, await service.getStats());
  }
  if (method === 'GET' && path === '/api/admin/admins') {
    return jsonResponse(200, await service.getAdmins());
  }
  if (method === 'GET' && path === '/api/admin/manual') {
    return jsonResponse(200, await service.getManual());
  }
  if (method === 'GET' && path === '/api/admin/providers') {
    return jsonResponse(200, await service.getProviders());
  }
  if (method === 'GET' && path === '/api/admin/debug') {
    return jsonResponse(200, await service.getDebug());
  }

  // --- Mutations ---------------------------------------------------------
  if (method === 'POST' && path === '/api/admin/logout') {
    return jsonResponse(200, { ok: true }, { 'set-cookie': buildSessionClearCookie() });
  }

  // Honestly disabled (ADR-0081): no engine seam exists yet — the API
  // says so and the UI shows "Not available". They light up when the
  // bot v2 PR's §19 seams land; the site calls the same seams.
  if (
    method === 'POST' &&
    ((resource === 'queue' && action === 'send-now') ||
      (resource === 'schedule' && id === 'force-tick') ||
      (resource === 'soul' && id === 'test-ai') ||
      resource === 'manual')
  ) {
    const reason =
      resource === 'queue'
        ? 'send_now_unavailable'
        : resource === 'schedule'
          ? 'force_tick_unavailable'
          : resource === 'soul'
            ? 'test_ai_unavailable'
            : 'manual_trigger_unavailable';
    return jsonResponse(200, { available: false, reason });
  }

  if (method === 'POST' && resource === 'drafts' && id !== undefined && action === 'approve') {
    if (!isValidId(id)) {
      throw new AppError('bad_request');
    }
    const outcome = await service.approveDraft({
      telegramUserId: identity.userId,
      role: identity.role,
      draftId: decodeURIComponent(id),
    });
    logMutation('drafts.approve', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'drafts' && id !== undefined && action === 'reject') {
    if (!isValidId(id)) {
      throw new AppError('bad_request');
    }
    const outcome = await service.rejectDraft({
      telegramUserId: identity.userId,
      role: identity.role,
      draftId: decodeURIComponent(id),
    });
    logMutation('drafts.reject', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'queue' && id !== undefined && action === 'cancel') {
    if (!isValidId(id)) {
      throw new AppError('bad_request');
    }
    const outcome = await service.cancelPublication({
      telegramUserId: identity.userId,
      role: identity.role,
      publicationId: decodeURIComponent(id),
    });
    logMutation('queue.cancel', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'posts' && action === undefined) {
    const body = await readJsonBody(request);
    if (body === null) {
      throw new AppError('bad_request');
    }
    if (id === 'pin' || id === 'delete') {
      if (
        !isValidRefType(body.refType) ||
        !isValidId(body.refId) ||
        !isValidChannelMessageId(body.channelMessageId)
      ) {
        throw new AppError('bad_request');
      }
      const outcome =
        id === 'pin'
          ? await service.pinPost({
              telegramUserId: identity.userId,
              role: identity.role,
              refType: body.refType,
              refId: body.refId,
              channelMessageId: body.channelMessageId,
            })
          : await service.deletePost({
              telegramUserId: identity.userId,
              role: identity.role,
              refType: body.refType,
              refId: body.refId,
              channelMessageId: body.channelMessageId,
            });
      logMutation(`posts.${id}`, outcome.kind);
      return jsonResponse(200, outcome);
    }
    if (id === 'unpin') {
      if (!isValidChannelMessageId(body.channelMessageId)) {
        throw new AppError('bad_request');
      }
      const outcome = await service.unpinPost({
        telegramUserId: identity.userId,
        role: identity.role,
        channelMessageId: body.channelMessageId,
      });
      logMutation('posts.unpin', outcome.kind);
      return jsonResponse(200, outcome);
    }
    if (id === 'edit') {
      if (
        !isValidRefType(body.refType) ||
        !isValidId(body.refId) ||
        !isValidChannelMessageId(body.channelMessageId) ||
        typeof body.text !== 'string' ||
        body.text.length === 0 ||
        body.text.length > POST_EDIT_MAX_CHARS
      ) {
        throw new AppError('bad_request');
      }
      const outcome = await service.editPost({
        telegramUserId: identity.userId,
        role: identity.role,
        refType: body.refType,
        refId: body.refId,
        channelMessageId: body.channelMessageId,
        text: body.text,
      });
      logMutation('posts.edit', outcome.kind);
      return jsonResponse(200, outcome);
    }
  }
  if (method === 'POST' && resource === 'posts' && id === 'settings' && action === 'auto-pin') {
    const body = await readJsonBody(request);
    if (body === null || typeof body.enabled !== 'boolean') {
      throw new AppError('bad_request');
    }
    const outcome = await service.setAutoPin({
      telegramUserId: identity.userId,
      role: identity.role,
      enabled: body.enabled,
    });
    logMutation('posts.auto_pin', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'posts' && id === 'settings' && action === 'retention') {
    const body = await readJsonBody(request);
    const rule = (body === null ? null : body.rule) as Record<string, unknown> | null;
    if (
      rule === null ||
      typeof rule.enabled !== 'boolean' ||
      typeof rule.defaultDays !== 'number' ||
      typeof rule.freeGameDays !== 'number'
    ) {
      throw new AppError('bad_request');
    }
    const outcome = await service.setRetention({
      telegramUserId: identity.userId,
      role: identity.role,
      rule: {
        enabled: rule.enabled,
        defaultDays: rule.defaultDays,
        freeGameDays: rule.freeGameDays,
      },
    });
    logMutation('posts.retention', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'schedule' && id === 'mode') {
    const body = await readJsonBody(request);
    if (body === null) {
      throw new AppError('bad_request');
    }
    const outcome = await service.setMode({
      telegramUserId: identity.userId,
      role: identity.role,
      mode: body.mode,
    });
    logMutation('schedule.mode', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'schedule' && id === 'cap') {
    const body = await readJsonBody(request);
    if (body === null) {
      throw new AppError('bad_request');
    }
    const outcome = await service.setCap({
      telegramUserId: identity.userId,
      role: identity.role,
      cap: body.cap,
    });
    logMutation('schedule.cap', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'schedule' && id === 'event') {
    const body = await readJsonBody(request);
    if (body === null || typeof body.active !== 'boolean') {
      throw new AppError('bad_request');
    }
    const outcome = await service.setEvent({
      telegramUserId: identity.userId,
      role: identity.role,
      active: body.active,
    });
    logMutation('schedule.event', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'schedule' && id === 'clear-queue') {
    const outcome = await service.clearQueue({
      telegramUserId: identity.userId,
      role: identity.role,
    });
    logMutation('schedule.clear_queue', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'admins' && id === undefined) {
    const body = await readJsonBody(request);
    if (
      body === null ||
      typeof body.targetUserId !== 'number' ||
      !Number.isSafeInteger(body.targetUserId) ||
      body.targetUserId <= 0
    ) {
      throw new AppError('bad_request');
    }
    const outcome = await service.addAdmin({
      telegramUserId: identity.userId,
      role: identity.role,
      targetUserId: body.targetUserId,
      targetRole: body.targetRole,
    });
    logMutation('admins.add', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'admins' && id !== undefined && action === 'remove') {
    const targetUserId = Number(decodeURIComponent(id));
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
      throw new AppError('bad_request');
    }
    const outcome = await service.removeAdmin({
      telegramUserId: identity.userId,
      role: identity.role,
      targetUserId,
    });
    logMutation('admins.remove', outcome.kind);
    return jsonResponse(200, outcome);
  }
  if (method === 'POST' && resource === 'providers' && id !== undefined && action === 'toggle') {
    const body = await readJsonBody(request);
    if (body === null || typeof body.enabled !== 'boolean' || !isValidId(id)) {
      throw new AppError('bad_request');
    }
    const outcome = await service.setProviderEnabled({
      telegramUserId: identity.userId,
      role: identity.role,
      sourceId: decodeURIComponent(id),
      enabled: body.enabled,
    });
    logMutation('providers.toggle', outcome.kind);
    return jsonResponse(200, outcome);
  }

  throw new AppError('not_found');
}
