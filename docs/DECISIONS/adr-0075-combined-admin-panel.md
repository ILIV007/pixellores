# ADR-0075 — Combined admin panel (bot): AI-admin + Fredy-admin, replacing the thin Slice 3 panel

Date: 2026-11-28. Status: Accepted (owner-ordered rebuild 2026-11-28
00:21 — the owner tapped `/menu` himself, found the thin panel shipped
by PR #34 too thin, and ordered it removed and rebuilt as a detailed
complete combination of the AI-admin panel and the Fredy-admin panel;
PR #35 removed the thin panel and the flag shipped OFF again. Design
doc: `pixel-panel-combined-design.md`, 15 sections.)

## Context

The Slice 3 panel (PR #34) had five screens (main/mode/cap/event/ai)
and a settings-only posture: it could change the mode, the cap, and the
event flag, and nothing else. The owner runs his other bots from rich
admin panels — the AI-admin panel (main menu, settings, approval queue,
SMART QUEUE, Spread) and the Fredy-admin panel (dashboard with a Bot
ON/OFF toggle first alone in its row, status lines, a nav grid,
scheduler, categories, providers, AI, language, strategy, settings,
manual post, editor, refresh, approve toggle, stats, debug, manager
dashboard URL) — and expects the Pixel panel to be the same kind of
thing: a working dashboard, not a settings form. The site (web) admin
panel is the same combination — it is a separate Phase 3 job and is NOT
part of this ADR.

## Decision

1. **Fourteen screens, one grammar.** `main, mode, cap, event,
schedule, drafts, posts, manual, ai, settings, stats, admins, debug,
help` (`/menu <screen>`, `parseMenuArgument`; the bare `/menu` is
   still the main form). The main screen is a Fredy-style dashboard:
   status lines (mode, cap, event, Soul version, AI, worker), the nav
   grid, the Approval toggle, and the owner-only Admins button.
2. **The Approval toggle flips the publish mode.** Approval mode IS the
   `approval` publish mode: the toggle flips mode `approval ↔ auto`
   through the audited `setPublishMode` store path. It is not a
   separate flag — there is no approval toggle anywhere else in Pixel,
   and inventing one would have split the mode truth in two.
3. **Channel Edit is a status line, not a setting.** No channel-edit
   setting exists in Pixel (the 48-hour edit window is a Bot API limit,
   not a toggle): the main screen shows "Channel Edit: always on (edits
   update the channel within 48h)" and offers no button. See §9 of the
   design doc and the honest gaps below.
4. **Draft Approve / Reject are fenced human transitions.** New store
   `human-approval-store.ts`: `ready → approved` and `ready → rejected`,
   fenced on the current status, deterministic audit ids
   (`human-approval:<action>:<draftId>`), audited actions
   `draft_approved` / `draft_rejected`, permissions `draft.approve` /
   `draft.reject`, idempotent (`already_approved` / `already_rejected`
   absorb a repeat). Approve then enqueues through the existing engine
   path (`enqueuePublication`, id `pub:human:<draftId>`, priority 80 —
   the bridge's auto-lane score, kept as a local constant so the panel
   never imports bridge job machinery — approval mode from the current
   publish mode, current Soul version stamped). A refused enqueue never
   strands a draft: the draft stays `approved` and the next Approve tap
   retries the enqueue alone. Paused mode answers honestly and writes
   nothing. Reject is terminal and never deletes the draft.
5. **Clear queue is a fenced cancel.** The Schedule screen's confirm
   screen lists the live cancellable count, then cancels each row
   through the Phase 9C `cancelPublicationById` disposition (one audit
   event per row, max 64). A row claimed by a worker between view and
   click is counted as skipped, never forced. An empty queue has no
   confirm button at all — the confirm screen says so.
6. **Manual Post mints real inbound tokens.** The pending inbound
   approvals list carries the inbound service's OWN approve/reject
   buttons (`inbound.approve` / `inbound.reject`, the approval's own
   expiry, permissions `publication.publish` / `draft.approve`). The
   ingress's action-aware dispatcher hands them to the inbound service;
   the panel never consumes them. The recent owner posts list opens the
   post detail (`listChannelPosts` UNION covers owner posts).
7. **AI & Soul is read-only; Test AI is honestly unavailable.** Soul
   version + persona line (first non-empty line, truncated), provider
   flags + presence booleans (never values), failover display. No engine
   probe exists, so Test AI answers the honest toast — never a pretend
   test.
8. **Settings groups the real values** (mode/cap/event, language
   display-only with the `/language` hint, form #4, rewrite + image
   flags, fact-guard strict v1 with digit folding). **Stats** reads D1
   (today, totals, AI calls by budget scope, worker metadata).
   **Admins** is owner-only and read-only while
   `ADMIN_MANAGE_ENABLED=false` (list + the note; the Slice 2 mutation
   surface stays behind its own flag). **Debug** is read-only (worker
   metadata, flags, D1 totals). **Help** is the short how-to.
9. **The panel now drives publish actions through the engine.** The old
   "settings only, never a send path" posture is gone: draft approve →
   outbox, mode/cap/event settings, queue clear. The panel still never
   sends a post itself and never enables any scheduler path. The webhook
   comment and the router's panel-gate comment were updated to say so.
10. **One shared review instance.** The webhook builds the editorial
    review service once and reuses it for the ingress (`/drafts`) and
    the panel (Drafts screen preview). The panel's `workerInfo` is the
    same build metadata `/version` serves; its `featureFlags` are the
    same validated Phase 6 flags the AI wiring already parses, plus the
    admin-manage / admin-post gates and the backup-token presence
    (boolean only). All four new deps are optional with
    honest-unavailable fallbacks, so the panel degrades instead of
    failing the webhook.

## Honest gaps (carried from the design doc §9 / §15 — not hidden)

- **No Source toggle.** PR #26 removed source lines from all editorial
  renderings; there is no source setting to toggle. The gap is recorded
  here, not papered over with a button that does nothing.
- **No Spread / Grid.** Pixel's scheduler is the 5-minute bridge tick;
  the AI-admin Spread concept (multi-channel fan-out) has no Pixel
  equivalent. The Schedule screen shows the window, the next tick, and
  the queue instead.
- **No Channel Edit setting** (decision 3 above).
- **No re-evaluation path.** The Re-evaluate button answers the honest
  toast; the re-evaluation path belongs to the bridge fix (the
  digit-folding livelock), not to this panel.
- **No Test AI probe** (decision 7 above) — an engine dependency.
- **Admins mutations need `ADMIN_MANAGE_ENABLED`** — the Slice 2 flag
  stays off; the screen is list-only until the owner enables it.
- **Language is display-only** — the per-admin language store needs
  Telegram message-order metadata the panel callback does not carry;
  the screen points at `/language`.

## Consequences

- The owner gets the dashboard he asked for: approve/reject drafts
  from his phone, flip approval, pause/resume, clear the queue, see
  stats and debug state — without touching D1 by hand.
- Every mutation is still fenced, audited, and RBAC-checked
  (owner + chief_editor for publishing settings; `draft.approve` /
  `draft.reject` for the queue; the Admins screen is owner-only; a
  forged token can never leak the list — the screen re-checks the role).
- Single-use tokens everywhere (10-minute TTL, consumed on use);
  foreign (`inbound.*`) tokens are rejected by the panel's
  `panel.`-prefix check.
- The site panel (Phase 3) mirrors these screens; this ADR is the bot
  half only.

## Verification

- 29 new integration tests (`tests/integration/admin-panel-combined.test.ts`,
  real workerd D1): the 14-screen grammar, the dashboard, the Approval
  toggle (owner flips, editor denied), Schedule + clear queue (empty,
  drain-race, fenced cancel), draft approve/reject (audit + outbox row
  at priority 80 + idempotency at the store level + paused/RBAC
  denials), Manual Post (pending approvals + real inbound tokens +
  recent posts), and all six info screens with their
  honest-unavailable paths.
- Full gate (`npm run check`: lint + format + typecheck + full suite +
  secrets scans + dry-run build) green before ship.
- Ship: rebuild PR, then a SEPARATE flag-flip PR
  (`ADMIN_PANEL_ENABLED` `"true"` in `env.preview` vars only). The
  panel is verified only when the owner taps through `/menu` on his
  phone — the live-test script ships with the flag flip.
