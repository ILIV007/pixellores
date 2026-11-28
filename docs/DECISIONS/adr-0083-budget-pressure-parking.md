# ADR-0083 — Budget-pressure parking: prepare_draft parks until after Tehran midnight

Date: 2026-11-28. Status: Accepted (coordinator decision 2026-11-28,
fix round: parking, not more retries).

## Context

On 2026-11-28 the autonomous AI budgets hit their effective caps
(workers-ai 114, gemini 34) around 11:36–11:47 Tehran. 88
`editorial.prepare_draft` jobs then dead-lettered with `job_exhausted`
(all 3 attempts spent, created ~11:10–11:15, dead by ~11:48). Two
failure shapes fed the same bonfire:

- `budget_pressure` (the reserve-window denial, ai-policy-v2.3) mapped
  onto the engine's recoverable retry with the ordinary short backoff —
  so the job re-denied minutes later, burned attempt 2, re-denied, burned
  attempt 3, and dead-lettered. Retries during a closed budget can only
  re-deny.
- `budget_denied` (the hard-cap denial) mapped onto TERMINAL
  `editorial_budget_exhausted` (ai-policy-v2.2) and dead-lettered on the
  first hit — discarding a good item for a budget that resets at Tehran
  midnight.

## Decision

### 1. Both denials PARK; neither dead-letters on the day

`classifyAiOutcome` maps `budget_pressure` AND `budget_denied` onto
`retry` (the old explicit `budget_denied` → permanent branch is
deleted). The handler's retry branch then returns the parking outcome
for exactly those two deferral reasons:

```ts
{ kind: 'retry', reasonCode: 'job_budget_parked',
  retryAfterMs: msUntilNextTehranMidnight(nowMs()) + 5 * 60 * 1000 }
```

`run_after` is the next Tehran midnight + 5 minutes (the 5-minute
buffer keeps the retry off the reset boundary itself). The item is NOT
a quality rejection and is never written into the 30-day negative
cache — parking runs through the retry branch, which never caches
fingerprints, so the old permanent-branch budget exception is deleted
with it.

### 2. The engine honors the park past the 1h backoff cap — for this code only

`computeBackoffDelayMs` caps every delay at 1h, and the pinned test
(`job-contracts.test.ts`: "raises to the retry_after floor and caps
it") documents that the `retryAfterMs` floor never exceeds the cap —
so a midnight `retryAfterMs` returned through the ordinary path would
silently clamp to 1h and the job would re-deny hourly. The engine was
therefore extended minimally, scoped by reason code: `decideRetry`
returns `{ kind: 'reschedule', delayMs: retryAfterFloorMs }` (uncapped)
when — and only when — the reason code is the new `job_budget_parked`
(new `JOB_ERROR_CODES` entry). Every other code keeps the capped floor
exactly as before. `decideRetry`'s `errorCode` parameter was previously
unused; this is its first use.

### 3. What does NOT change

- The 3-attempt budget, the model ladder, the daily caps and the
  6-unit reserve are untouched. Parking consumes the ONE attempt that
  hit the denial; the remaining attempts are preserved for after the
  reset. A job that hits a budget denial on its LAST attempt still
  exhausts (`decideRetry` checks `generation >= maxAttempts` before
  the parking branch) — parking never grants a 4th attempt.
- `editorial_budget_exhausted` is produced by NOTHING anymore; it stays
  in the `JOB_ERROR_CODES` registry because old rows still carry it in
  `jobs.last_error`.
- `budget_denied` stays terminal everywhere else it already was (the
  rewrite service's own `budget_denied` mapping is untouched).

## Tests

- Unit (`tests/unit/editorial-contracts.test.ts`): `budget_denied` and
  `budget_pressure` both classify as `retry`.
- Unit (`tests/unit/job-contracts.test.ts`): a `job_budget_parked`
  floor of 10,000,000 ms is honored whole; the same floor under
  `job_handler_retryable_error` still caps at 3,600,000 ms; a parked
  job on its last attempt still exhausts.
- Integration (`tests/integration/editorial-source-to-draft.test.ts`):
  the pre-exhausted-cap case (120 charges → `budget_denied`) now parks
  (`retry_scheduled`, `retry_wait`, `last_error` `job_budget_parked`,
  1 attempt, `run_after` exactly midnight + 5 min, zero provider calls,
  budget still 120, no draft); a NEW reserve-window case (114 charges
  → `budget_pressure`) parks identically.
- Integration (`tests/integration/editorial-64-end-to-end.test.ts`):
  the budget-first chain case now parks the same way (same pins +
  the honest failed `budget_denied` ai_run row, unchanged); the
  `deadline_exceeded` control pins the UNCHANGED short retry
  (`run_after` within 60 s of now).

## Consequences

- A budget closure now costs each affected job ONE attempt and a wait
  until after midnight, instead of all 3 attempts in minutes. After the
  reset the parked jobs dispatch and decide honestly again.
- No migration, schema stays 13, app stays 1.49.0.
- Honest gaps (NOT done here): the rewrite handler returns the same
  midnight `retryAfterMs` with the generic `job_handler_retryable_error`
  code, so the engine STILL clamps its deferral to 1h — the identical
  one-line fix (return `job_budget_parked` there) is a follow-up for the
  coordinator, not smuggled into this PR. The 88 already-dead jobs are
  unrecoverable through the drain (idempotency key) and are requeued by
  the coordinator's one-off D1 requeue, not by this change.
