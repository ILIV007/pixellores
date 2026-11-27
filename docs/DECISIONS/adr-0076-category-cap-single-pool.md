# ADR-0076 — Category cap: single-category-pool exemption

Date: 2026-11-28. Status: Accepted (owner order 2026-11-27 23:32 Tehran:
everything OK by Sat 2026-11-28 09:00; the bridge-livelock fix PR #38
shipped and deployed, but posting still has ZERO new posts).

## Context

PR #38 (ADR-0074) fixed the first livelock: the five oldest ready
drafts' stale pre-ADR-0066 fact-guard reports were re-evaluated at
01:50:46 Tehran and their gate rows read `eligible_auto`. Yet by 02:18
— sixteen more minutes of watching, four more cron ticks — still ZERO
new publications: pubs stuck at 2, ready stuck at 53.

The worker logs (wrangler tail, ticks 02:30 and 02:35 Tehran) name the
second stall exactly:

```
cron.auto_publish_bridged {scanned:5, approved:0, enqueued:0,
  requiresReview:0, refused:0, reevaluated:0,
  deferredCategoryCap:5, deferredRewrite:0, failedRewrite:0, rejected:0}
```

Every pass scans the same five drafts, the gate passes them all, and
the CATEGORY CAP defers all five. The cap is the arp1 40%-of-rolling-six
rule (ADR-0068): at most 2 of the rolling six in one mix category
(`CATEGORY_MAX_ALLOWED_COUNT = 2`). The live numbers:

- Published trail (weekly window): exactly 2 posts, both Nov 22, both
  content_type `industry` → mix category `mainstream_industry`.
- The five front drafts: all `industry` → `mainstream_industry`.
- The whole ready queue: all 53 drafts are `industry`.
- For each draft: `rollingCount = 2`, `2 + 1 = 3 > 2` → not allowed.

The deferral happens AFTER the eligible gate row is recorded (failures
reset to 0), so the ADR-0074 progress ordering never sinks these
drafts — the same five are scanned every pass (limit 5) and nothing
behind them is ever reached. And the trail can never dilute: dilution
needs a new publication, and no publication can ever happen. The stall
is indefinite (the Nov-22 posts age out of the 168h window only around
Nov 29 00:45 Tehran — too late for the 09:00 review).

The cap's premise does not hold here. It is a MIX-SHAPING rule: it
defers the over-represented category so ANOTHER category can take its
place. When the pool holds no other category there is no mix to shape —
deferring only throttles the channel's only content. (The earlier
02:05–02:20 silence was the rapid redeploys disrupting trigger
delivery, not a dead cron: from 02:30 the trigger fires every 5 min
and the gate rows re-stamp each pass. The cron is alive; the cap is
the sole remaining blocker.)

## Decision

The cap admits a candidate when the candidate pool holds NO
classifiable draft/publication of another mix category. The exemption
is threaded as an EXPLICIT boolean, never inferred:

- `enforceCategoryShare` (domain, `src/domain/publishing/anti-robot.ts`)
  gains the required input `alternativeCategoryAvailable: boolean`.
  The allow rule becomes `rollingCount + 1 <= maxAllowedCount ||
eventDriven || !alternativeCategoryAvailable`. A non-boolean flag is
  `invalid_input`. The decision shape is unchanged — callers derive
  the bypass label themselves, as they already do for `eventDriven`.
- `planPublicationTime` (`src/domain/publishing/publication-schedule.ts`)
  gains the required input `alternativeCategoryAvailable: boolean`
  (non-boolean → `invalid_input`), threads it to the cap, and labels
  the applied rule `bypassed_single_category_pool` when the exemption
  is what admitted the candidate (mirroring `bypassed_event_driven`).
- The bridge (`src/application/publishing/auto-publish-bridge.ts`)
  reads the pool ONCE per pass: `listReadyDraftContentTypes` (new
  store function — DISTINCT content types over the WHOLE ready set,
  not the scanned five, which cannot see the alternatives behind it),
  mapped to mix categories. Per draft, an alternative exists iff the
  pool contains a category other than the draft's own. An unreadable
  pool fails the WHOLE pass with zero writes — a cap that cannot be
  evaluated never silently passes (the same discipline as an
  unreadable published history).
- The scheduler (`src/application/publishing/scheduler.ts`) is the
  send-time backstop and gets the same treatment, or the posts the
  bridge enqueues would never send: per scan, `duePoolCategories`
  (one bounded DISTINCT query over the loaded due rows' story ids)
  feeds `buildPolicyDecision`, which threads the per-row flag into
  `planPublicationTime`. A pool-query failure throws — the scan fails
  closed with zero sends.

What does NOT change: the cap math (2-of-6, exact integers), the
event-driven bypass, the gate, the guide lane, the daily cap, the
weekly mix assessment. In a MIXED pool the cap behaves exactly as
before — it defers the over-represented category and the alternative
bridges. The exemption only engages where shaping is impossible.

## Consequences

- Tonight: the front five bridge in the first pass after deploy, and
  the scheduler sends them (the backstop carries the same exemption).
  The daily cap (default 15) bounds the night's total; the queue
  keeps flowing pass after pass because the pool stays
  single-category until new ingestion diversifies it.
- Steady state: once the ready queue (or the due set) holds two mix
  categories, the cap resumes shaping exactly as ADR-0068 specifies.
- Honest gap, recorded as OD-024 (open, follow-up — NOT tonight's
  blocker): a cap/guide/rewrite DEFERRAL still records no progress.
  In a MIXED pool, five deferred drafts at the front can head-block
  an alternative sitting behind them (scan limit 5). Closing it means
  recording deferrals in `draft_gate_evaluations` — which needs the
  `last_outcome` CHECK widened (migration 0014) — so it ships as its
  own change, not smuggled into this one. Tonight's queue is
  single-category, so no deferral can occur tonight.

## Tests

- Unit: `tests/unit/anti-robot.test.ts` — single-category pool with
  rollingCount 2 admits; the same trail with an alternative defers;
  non-boolean flag is `invalid_input`; all pre-existing cap cases
  pass `alternativeCategoryAvailable: true` (the old behavior's
  assumption, now explicit).
- Unit: `tests/unit/publication-schedule.test.ts` — the exemption
  schedules with applied rule `bypassed_single_category_pool`; the
  pre-existing cap cases keep deferring (base input defaults the flag
  true).
- Integration (REAL workerd D1, registered in `test:db`):
  `tests/integration/bridge-category-cap-pool.test.ts` — (1) the exact
  live shape (2-post mainstream trail + 5 ready mainstream) bridges
  all five in one pass; (2) the mixed-pool control (same trail + 4
  mainstream + 1 mods) defers the four and bridges the mods draft.
- Updated: `tests/integration/publication-96-guide-lane-cap.test.ts` —
  both cap tests now seed a mixed pool (the cap's shaping is proven
  where shaping is possible); the guide-lane test is unchanged.
- Unaffected: `bridge-livelock-fix`, `slice09` (both assert
  `deferredCategoryCap: 0`), the scheduler-policy suite.
- No migration, schema stays 13, app stays 1.49.0 (code-only fix).

## Live verification (owed)

After deploy: the next cron pass must log `approved:5, enqueued:5,
deferredCategoryCap:0`, new `publications` rows must appear in D1,
and the first new post must land in @pixellores in form #4. The
02:30/02:35 log lines are the before-picture to compare against.
