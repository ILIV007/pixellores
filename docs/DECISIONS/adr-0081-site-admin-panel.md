# ADR-0081 — Site admin panel (Phase 3): worker-served web mirror of the bot panel v2

## Status

Accepted (owner order 2026-11-28 ~11:43: z.ai cancelled for this build —
it claimed a complete build but never produced a retrievable deliverable —
and Nova's team builds the site panel in-house, from the AI-admin +
Fredy-admin reference material).

## Context

- The bot admin panel v2 design
  (`pixel-panel-v2-design.md`, §§2–17 screens, §21 mirror rule) is the
  binding spec: the site panel mirrors the bot panel 1:1 — same screens,
  same names, same actions, same audit trail. No screen exists on the web
  that does not exist in the bot, and vice versa.
- The old Phase 3 plan (`docs/phase3-admin-web-panel-plan.md`) is REJECTED
  (owner 2026-11-28 00:21) and superseded twice over; nothing is built
  from it.
- The bot panel v2 is being built IN PARALLEL by another track from the
  same design doc. The site panel mirrors the DESIGN, not the in-progress
  bot code — if a bot screen changes, the site follows the design doc.
- Reference material (read-only briefs, 2026-11-28): AI-admin v3.8.2
  (`keyboards.ts`, `commands.ts`, `callbacks.ts`, `approval.ts`) and
  Fredy-admin v14.3.2 (`screens/manual.ts`, `main.ts`, `providers.ts`,
  `commands/start.ts`, `V12_ARCHITECTURE.md`, plus the Manager web UI at
  `src/entry/manager.ts`).

## Decision

### Surface

- Served by the same worker, no new deployment, no new dependency, no
  build step: `GET /admin` (HTML shell) + `GET /admin/app.js` +
  `GET /admin/app.css` (static, same worker) + JSON under `/api/admin/*`.
  All routes are enumerated in the allowlist router; the handler does its
  own exact-match dispatch for the API actions.
- Fail-closed flag `ADMIN_WEB_PANEL_ENABLED` (default `"false"`, top-level
  and `env.preview`, same shape as `ADMIN_PANEL_ENABLED`). While OFF (or
  invalid), every `/admin*` and `/api/admin/*` request answers the
  uniform safe 404 — probing reveals neither the route nor the flag.
  Enabling is a SEPARATE flag-flip PR, never this one.
- CSP (no `unsafe-inline`, no `unsafe-eval` — Fredy's Manager pattern is
  explicitly NOT copied): `default-src 'self'; script-src 'self'
https://telegram.org; style-src 'self'; img-src 'self' data:;
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`. All JS
  and CSS live in the two static routes; the only external script is
  Telegram's own Login Widget.

### Auth

- Telegram Login Widget (HMAC-SHA256, standard data-check-string over
  the sorted `key=value` lines, key = SHA-256 of `BOT_TOKEN`, compared
  with the timing-safe helper; `auth_date` must be within 24h). No new
  credential: the widget data is verified against the existing bot token.
- On success the server issues an HttpOnly session cookie:
  `base64url(userId.expiryMs).base64url(HMAC-SHA256(WEBHOOK_SECRET,
payload))`, 24h TTL, `SameSite=Lax`, `Secure` on https. No new D1
  table — the session is a signed cookie, not a row.
- Every API call re-resolves the role fresh from D1 via the existing
  authorization service (owner bootstrap `OWNER_TELEGRAM_ID` + active
  `admins` rows). A deactivated admin loses access immediately; a DB
  failure during lookup is a 503, never a denial (the authorization
  service's contract).
- Permissions follow the design doc §1: viewing needs `dashboard.view`
  (every role holds it); mutating needs owner + chief_editor — except
  the provider toggle, which needs `source.manage` (owner +
  source_manager), and admin add/remove, which is owner-only AND gated
  by `ADMIN_MANAGE_ENABLED` (read-only while off, same as the bot
  panel). The bot username for the widget is the public
  `Pixel_IVbot` (a module constant, not a secret).

### Reads and writes — reuse, never rebuild

- Every read goes through the EXISTING store boundary
  (`readPublishingSettings`, `readTodayCounts`, `countDraftsByStatus`,
  `listReadyDrafts`, `countPublicationsByStatus`,
  `listRecentPublications`, `listCancellablePublications`,
  `listChannelPosts`, `getSoulText`, `countEditorialTotals`,
  `listAdmins`, `readPostManagementSettings`, `getActivePin`).
- Every write goes through the EXISTING fenced store function
  (`setPublishMode`, `setDailyCap`, `setEventMode`,
  `approveDraftForHumanPublication` + `enqueuePublication`
  (`pub:human:<draftId>`, priority 80, destination `TARGET_CHANNEL`),
  `rejectDraftForHumanPublication`, `cancelPublicationById`,
  `pinPost`/`unpinPost`/`deletePost`/`setAutoPin`/`setRetention` via
  the existing `createPostManagementService` with the Bot API transport
  — transport absent (no `BOT_TOKEN`) reports honestly unavailable,
  never writes a ledger row for a call that never happened).
- Two NEW store functions, both in the owning store file:
  `listProvidersWithHealth` (one bounded grouped query: sources +
  source_state + items count + ready/published counts joined through
  the ingestion linkage `source_items → evidence → claims → stories →
drafts/publications`; a multi-source story counts for each of its
  sources) and `setSourceEnabled` (fenced `UPDATE sources SET enabled`,
  one audit row, permission `source.manage`). The provider toggle writes
  `sources.enabled` per the owner's 09:06 approval (design §20 decision
  5).
- Every mutation writes ONE audit_events row (the stores' own pattern:
  setting + audit in one atomic batch; deterministic or `webpanel:`
  ids; actor telegram id; measured metadata only — never content,
  never destinations, never secrets).
- The draft preview parses `document_json` defensively
  (`headlineFa`/`summaryFa`/`sourceReport`/`modelClaims`, structured
  `figures`/`quote`/`verdict` when present) and never throws on a
  malformed document.

### Honestly disabled (no engine seam yet — never a fake)

- 🚀 Send Now: no shared claim-protected publish function exists yet —
  that is the bot v2 PR's §19 seam 2. The endpoint answers
  `{available:false, reason:'send_now_unavailable'}` and the button
  shows "not available". It lights up when the seam lands; the site
  calls the same seam, never a second publish path.
- Manual trigger (provider/category/dry-run) and ▶️ Force tick: the
  manual-trigger engine seam is the bot v2 PR's §19 seam 4; the force
  tick needs a manual-tick engine action. Both answer
  `{available:false}` with the reason. The duplicate-to-PM fallback,
  the PM report, and the approval-mode READY preview are the seam's
  behavior when it lands — the site does not invent them.
- 🧪 Test AI: honestly disabled, same as the bot panel (open decision 1
  — no engine probe exists).
- Debug "Last tick": no stored tick marker exists anywhere in v1 (the
  v1 panel's Debug screen has no such source either). The site shows
  the latest audit event as "Last change" instead, and records the gap:
  a true last-tick readout needs a stored tick marker — a future seam,
  not this PR.

### Deliberately absent (same as the bot panel)

- No Source toggle (PR #26 removed it). No Spread/Grid (Pixel's
  scheduler is the 5-minute bridge tick). Channel Edit is status-only.
  No dead buttons (Fredy's Simulate is dead — not copied). No
  hard-coded toggle labels (Fredy's Providers screen hardcodes 11
  plugin toggles to `true` — the site reads live state). No token in a
  URL (Fredy's Manager Dashboard link appends `?token=` — not copied).
  No single-admin-by-env-var (Pixel has owner + chief_editor roles).
  Version comes from one source (`/version`), never a scattered string.

## Verification

- Full gate `npm run check` (lint + format + typecheck + full test
  suite + secrets scan + build dry-run) exit 0.
- New suites: unit (Login Widget HMAC verification incl. wrong hash,
  stale `auth_date`, bad id; session issue/verify incl. expired,
  tampered, wrong secret) + integration over REAL workerd D1
  (flag-off → uniform 404 on every `/admin*` route; flag-on +
  no session → 401; login with a fixture bot token → cookie + role;
  dashboard/queue/posts/schedule/soul/stats/admins/providers/debug
  reads; mode flip with its audit row; draft approve → outbox row;
  cancel; provider toggle with its audit row; viewer reads but cannot
  mutate; owner-only admin writes; the golden path — login → overview
  → a settings change with its audit row → mode restored — with REAL
  observed output).
- The integration suite is registered in `test:db`.

## Consequences

- Zero DDL (schema 13 untouched, no migration). No new dependency.
- The site panel ships DISABLED (`ADMIN_WEB_PANEL_ENABLED` `"false"`);
  a separate flag-flip PR enables it after the deploy, and the bot
  panel's `🎛️ Web Admin` button (row 8, §3) points at `GET /admin` on
  this worker once live.
- The bot panel v2 PR and this PR both branch from main `9acb17c`;
  they touch different files (bot: `admin-panel-service.ts` +
  `panel-strings.ts` + §19 seams; site: `web-panel/*` + the flag +
  the two source-store functions). If both land, the site's
  honestly-disabled actions light up from the bot PR's seams.
