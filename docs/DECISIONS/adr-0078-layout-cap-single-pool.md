# ADR-0078 — Layout run cap: single-layout-pool exemption

Date: 2026-11-28. Status: Accepted (owner order 2026-11-27 23:23 +
2026-11-28 00:22, everything OK by Sat 2026-11-28 09:00; the bridge
and category-cap fixes PR #38 / #41 shipped and deployed, the date
render fix PR #42 shipped and deployed, but posting still has ZERO
new posts since msg 18 at 03:15).

## Context

PR #41 (ADR-0076) fixed the second livelock: the category cap's
single-category-pool exemption went live and the bridge enqueued
again — 52 pending rows by 05:00, the gate re-stamping `eligible_auto`
every 5-minute tick. Yet by 05:00 — more than ninety minutes after
msg 18 — still ZERO new publications: pubs stuck at 3, max message
id stuck at 18.

The D1 numbers name the third stall exactly (live reads 05:00–05:35
Tehran, re-confirmed at ship time):

- Live worker: `1.49.0 / b3ecb418 / schema 13 / preview`,
  `/health/ready` ok. The code is healthy; the scheduler defers.
- Publications: 52 pending + 3 published; max `publication_messages`
  .message_id = 18 (Temtem: Swarm, 03:15:47).
- Drafts: ALL 55 ready/auto_approved drafts are layout `news_v1`
  (`SELECT layout, COUNT(*) … GROUP BY layout` → one row, 55).
- 36 pending rows have `run_after - updated_at = 600000` exactly —
  the `planReleaseAfterScheduleDecision({dueAtMs: null})` →
  `deferred_policy` 10-minute re-evaluation signature.
- Last 3 published (msgs 12, 13, 18) ALL have layout `news_v1` →
  trailing run = 3 → every `news_v1` candidate defers
  `layout_run_cap`. No other layout exists in the queue, so the run
  can never drop.

The category cap is NOT the blocker (ADR-0076's bypass is live,
proven by the msg-18 send; all drafts are `industry` → the
single-category-pool bypass applies at the scheduler — but the layout
cap is checked FIRST in `planPublicationTime`, before the category
cap). Album misconfiguration is ruled out (0 due drafts with
`media: 'album'`); transport is present (msg 18 sent 03:15). The
bridge is not the blocker either: it never calls the layout cap (it
only enqueues); the scheduler is the send-time enforcement point.

The cap's premise does not hold here. It is a VARIETY rule: it
defers a fourth consecutive same-layout post so ANOTHER layout can
take its place. When the pool holds no other layout there is no
variety to shape — deferring only throttles the channel's only
layout. And the trail can never dilute: dilution needs a new
publication, and no publication can ever happen. The stall is
indefinite (the 10-minute `deferred_policy` re-evaluation cycles
forever).

Two adjacent facts, out of this fix's scope: the 22 P2 rows starve
behind the 30 cycling P1 rows (scan limit 10/tick, priority DESC) —
OD-024/starvation; once P1s send they leave the due set. P2s are
also quiet-gated to morning_scan 09:30 by design, so even fixed,
P2s only send from 09:30 — P1s are NOT quiet-gated and can land
before the 09:00 review.

## Decision

The cap admits a candidate when the candidate pool holds NO layout
OTHER than the candidate's. The exemption is threaded as an
EXPLICIT boolean, never inferred — mirroring ADR-0076 exactly:

- `enforceLayoutRunCap` (domain,
  `src/domain/publishing/anti-robot.ts`) gains the required input
  `alternativeLayoutAvailable: boolean`. The allow rule becomes
  `trailingRun < MAX_CONSECUTIVE_SAME_LAYOUT ||
!alternativeLayoutAvailable`. A non-boolean flag is
  `invalid_input`. The decision shape is unchanged (`{ allowed,
trailingRun }`) — callers derive the bypass label themselves, as
  they already do for `eventDriven`.
- `planPublicationTime`
  (`src/domain/publishing/publication-schedule.ts`) gains the
  required input `alternativeLayoutAvailable: boolean` (non-boolean
  → `invalid_input`), threads it to the cap, and labels the applied
  rule `bypassed_single_layout_pool` when the exemption is what
  admitted the candidate (mirroring
  `bypassed_single_category_pool`). The layout entry of
  `ScheduleAppliedRule` widens to `'within_cap' |
'bypassed_single_layout_pool' | 'blocked'`.
- The scheduler (`src/application/publishing/scheduler.ts`) reads
  the pool ONCE per scan: `duePoolLayouts` (one bounded DISTINCT
  query over the loaded due rows' draft ids — layouts live on
  drafts, not stories), fed into `buildPolicyDecision`, which
  threads the per-row flag into `planPublicationTime`. Both scan
  paths (decision-only and live) compute the pool. A pool-query
  failure throws — the scan fails closed with zero sends, like an
  unreadable published history.

What does NOT change: the cap math (`MAX_CONSECUTIVE_SAME_LAYOUT
= 3`, trailing-run count), the category cap, the gate, the guide
lane, the daily cap, the weekly mix, the bridge,
`planReleaseAfterScheduleDecision`, scan limit/order, mode, drafts.
In a MIXED pool the cap behaves exactly as before — it defers the
fourth consecutive same-layout post and the alternative bridges.
The exemption only engages where shaping is impossible.

## Consequences

- Tonight: the first P1 sends within ~20 minutes of the fix going
  live (P1 latency runs from the enqueue instant, long elapsed),
  and the queue keeps flowing pass after pass because the pool
  stays single-layout until new ingestion diversifies it. The
  first send proves both bypasses working (layout + category).
- Steady state: once the due set holds two layouts, the cap resumes
  shaping exactly as the blueprint specifies.
- Honest gap, recorded as OD-024 (open, follow-up — NOT tonight's
  blocker): a cap/guide/rewrite DEFERRAL still records no
  progress. In a MIXED pool, five deferred drafts at the front can
  head-block an alternative sitting behind them (scan limit 5).
  Closing it means recording deferrals in
  `draft_gate_evaluations` — which needs the `last_outcome` CHECK
  widened (migration 0014) — so it ships as its own change, not
  smuggled into this one. Tonight's queue is single-layout, so no
  deferral can occur tonight. The P2 starvation behind cycling P1s
  (scan limit 10/tick) resolves once sends resume, and P2s are
  quiet-gated to morning_scan 09:30 by design.

## Tests

- Unit: `tests/unit/anti-robot.test.ts` — single-layout pool with
  trailing run 3 admits; the same trail with an alternative defers;
  trailing run 4 with no alternative admits (the bypass is
  pool-based, not run-length-based); non-boolean flag is
  `invalid_input`; all pre-existing cap cases pass
  `alternativeLayoutAvailable: true` (the old behavior's
  assumption, now explicit).
- Unit: `tests/unit/publication-schedule.test.ts` — the exemption
  schedules with applied rule `bypassed_single_layout_pool`; the
  pre-existing cap cases keep deferring (base input defaults the
  flag true); non-boolean flag is `invalid_input`; the precedence
  test is unchanged (layout still beats category with the default
  true).
- Integration (REAL workerd D1, registered in `test:db`):
  `tests/integration/publication-82-scheduler.test.ts` — (1) the
  exact live shape (3-post `news_v1` trail + one due `news_v1` row)
  SENDS (both bypasses working — the trail also carries 3
  mainstream in the rolling six); (2) the mixed-pool control (same
  trail + a due `hero` row, decision-only) defers the `news_v1`
  row and schedules the `hero` row.
- No migration, schema stays 13, app stays 1.49.0 (code-only fix).

## Live verification (owed)

After deploy: `/version` shows the new merge commit + schema 13,
`/health/ready` ok, stable across 2+ reads 2 minutes apart; D1
must show a new `publications` row and the first new post must land
in @pixellores in form #4 (a P1 should send within ~20 minutes of
the fix going live). The 36 pending rows with the 10-minute
`deferred_policy` signature are the before-picture to compare
against.
