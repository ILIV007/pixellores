# ADR-0084 — Scheduler cap binding: the daily publication cap binds at the send terminal

- Status: Accepted
- Date: 2026-11-28
- Deciders: coordinator (owner decision via the fix-round brief)

## Context

The daily publication cap (`settings.publishing.daily_cap`, currently 6) was
enforced in exactly one place: `checkPublishGate`, called ONLY from the admin
panel (`admin-panel-service.ts:2567`) — i.e. only when a human tapped
Publish in the panel. The scheduler — the ONLY autonomous sender — never
consulted it. `recordPublication` was already wired into the scheduler
(it counts every successful send in today's Tehran-day `daily_posts`
bucket), so the counter moved while nothing ever read it: the cap could
not bind a send.

Live evidence on 2026-11-28: mode auto since ~11:17 Tehran, cap 6/day,
15 published + 40 cancelled, and no post since msg 30 at 07:50 — the cap
was a display number, not a gate.

A second, smaller gap: the panel's cap presets were `[12, 15, 18]`, which
cannot express the live cap 6 — the owner could not even set the cap the
channel actually runs at from the panel.

## Decision

1. **The cap binds at `sendClaimed` — the scheduler's single send
   terminal** (the loop calls it at one site; album dispatches inside it).
   Before the pre-send evidence check, for autonomous rows only
   (`approval_mode` `auto` / `safe_auto`), the scheduler calls the SAME
   `checkPublishGate` the panel uses and refuses when it refuses.
2. **Semantics are the gate's own** (`evaluatePublishGate`): count =
   today's publication-scope budget rows for the Tehran day; refuse when
   `counted >= cap` from `settings.publishing.daily_cap` (`cap_reached`);
   `paused` refuses too. The gate's P0 bypass (blueprint: no daily cap
   for P0) and its event lift carry over unchanged — the scheduler
   inherits the panel's rule, it does not fork one. Priority maps from
   the row's score via `classifyPriority` (P0 → `p0`, P1 → `p1`, else
   `normal`); an unclassified score never earns the P0 bypass — it rides
   as `normal` and consumes the cap (unreachable for rows that passed
   enqueue + policy validation, which already classify the score).
3. **Owner/human rows (`approval_mode` `approval`) stay cap-exempt.**
   Their posts count in the separate `daily_posts_owner` bucket (PR #36);
   the check never runs for them, so an owner post is never blocked by
   the cap.
4. **A refusal is a policy deferral, never a loss.** The claim is
   RELEASED (attempt restored — a cap refusal consumes no attempt) with
   `run_after = now + 10 min` (`planReleaseAfterScheduleDecision` with
   `dueAtMs: null`, the same 10-minute re-evaluation as every policy
   deferral) and the scan detail is `{outcome: 'deferred_policy', code:
'cap_reached' | 'paused'}`. The row re-evaluates on the next pass and
   sends once the cap lifts (midnight reset or a human cap raise).
5. **Fail closed.** A gate-read failure refuses too (`cap_check_failed`,
   same release + deferral): an unevaluated cap never silently passes.
   The check runs after the transport guard and before the evidence
   check, so a cap refusal never touches the delivery ledger.
6. **Presets fixed:** `ADMIN_PANEL_CAP_PRESETS` is now `[6, 12, 15, 18]`
   (6 first — the live cap). 6 is already a valid cap (`MIN_DAILY_CAP =
6`); the render maps the array generically, so no render change was
   needed.

## Consequences

- An autonomous send can no longer exceed the daily cap: at `counted >=
cap` the row defers, re-checks every 10 minutes, and sends after the
  reset or a cap raise. Zero sends happen past the cap.
- The panel and the scheduler now enforce the identical rule from the
  identical function — one gate, two call sites.
- No migration, schema stays 13, app stays 1.49.0.

## Honest gaps (observed, NOT changed here)

- **Counting asymmetry (pre-existing).** The scheduler's
  `recordPublicationCounted` counts EVERY scheduler send — including an
  approval-mode owner send — in the `daily_posts` counted bucket; only
  the inbound pipeline's `recordOwnerPublication` writes the separate
  owner bucket. So an owner post sent through the scheduler still
  consumes one counted unit and can push `counted` over the cap, after
  which autonomous rows defer until the reset. The CHECK is correctly
  scoped (owner rows are never refused); the COUNTING is the pre-existing
  behaviour and changing it is its own decision, not smuggled into this
  PR.
- The event lift (an active event allows sends past the cap) is inherited
  from the shared gate — it is the panel's existing rule, not a new
  scheduler behaviour.
