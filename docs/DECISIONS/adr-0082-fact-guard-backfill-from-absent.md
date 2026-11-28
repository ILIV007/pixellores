# ADR-0082 — Fact-guard backfill: build the missing report from stored bytes (no regeneration)

Date: 2026-11-28. Status: Accepted (coordinator decision 2026-11-28,
fix round: backfill by EXTENDING re-evaluation, NOT regenerating drafts).

## Context

PR-1 flips `EDITORIAL_FACT_GUARD_ENABLED` on in `env.preview`, so
fresh drafts carry a `factGuard` report. But the 29 ready drafts
already stored have NO report at all — the flag was off when they were
built, so the key was never written. The auto-gate reads STORED reports
only and refuses those drafts with `report_absent` (no measurable
basis), and the bridge never re-evaluated them: `reevaluateDraftFactGuard`
returned `not_applicable` / `report_absent` for a missing report. The
queue head-blocks on them forever.

Regeneration was considered and rejected: it would burn AI budget
(both autonomous budgets are exhausted until Tehran midnight) and
discard the stored v4 mapper output. The rebuild below is a pure
zero-cost derivation from stored bytes — the same derivation the
numbers path already performs.

## Decision

### 1. A missing report is BUILT, not skipped

`reevaluateDraftFactGuard` no longer returns `not_applicable` /
`report_absent`. When `readFactGuardReport` reads `absent`, the service
builds the report from the draft's OWN stored claims + the stored
source item the document names, through the SAME builder
(`buildFactGuardReport`), the SAME read-back validation (must read back
as a v1 report), the SAME CAS write (`replaceDraftFactGuardReport`) and
the SAME audit row (`insertFactGuardReevaluationAudit`) as the
numbers path. The `report_absent` reason is deleted from the outcome
union — nothing returns it anymore.

### 2. Guards for the absent path

- The stored claims must be well-formed and non-empty
  (`readStoredModelClaims`), else `not_applicable` / `claims_malformed`
  — nothing is written.
- The source item is named by the document itself:
  `sourceReport.sourceItemId`, and it must AGREE with
  `evidenceGuard.snapshot.sourceItemId` when that record exists (the
  exact-content basis discipline: a document whose own records disagree
  names no item at all). Unresolvable ⇒ `not_applicable` /
  `source_item_unresolvable` — nothing is written, nothing is guessed.
- The item must exist, else `skipped` / `source_item_missing`.
- NO stored-report comparisons exist to check (no snapshot hash, no
  excerpt-truncated flag — there is no stored report to compare
  against), so none are performed: the item as read IS the basis.
- A lost CAS race reports `concurrent_change` and writes no audit row,
  like the numbers path.

### 3. The audit's before-count marks absence

`claimsRequiringReviewBefore` is `0` for a build-from-absent: no prior
report existed, so `0` marks absence, not a measured count. The
`claimsRequiringReviewAfter` is the rebuilt report's measured count,
and `factGuardVersion` stays `1` (no lens change — `FACT_GUARD_VERSION`
is untouched).

### 4. The bridge triggers on `report_absent`

`bridgeReadyDrafts` attempts re-evaluation not only on a
`requires_review` / `fact_guard_findings` verdict with a numbers
finding (ADR-0074) but also on a `refused` / `report_absent` verdict —
the same try/catch + counters pattern, and on `updated` the gate
re-runs on the rebuilt bytes. The `concurrent_change` branch records
the ORIGINAL verdict (requires_review for the numbers family, refused
for the absent family) instead of hard-coding the numbers verdict.
Bounded: one attempt per draft per pass — after a successful build the
report exists, so later passes never re-trigger; a rebuilt report that
still fails the gate (e.g. substance) goes to human review and is not
rebuilt again.

### 5. The numbers path is byte-identical

The numbers-findings branch of `reevaluateDraftFactGuard` is untouched
(the diff deletes exactly two lines: the old union member and the old
early return). Its trigger conditions, snapshot-hash and
excerpt-truncated comparisons, and outcomes are unchanged.

## Tests

- 7 new unit tests (`tests/unit/fact-guard-reevaluation.test.ts`,
  fake executor): absent→built + stored + validated, claims untouched,
  malformed claims, empty claims, missing item, unresolvable source,
  disagreeing records, lost CAS race.
- 1 new integration test (`tests/integration/fact-guard-backfill.test.ts`,
  real workerd D1, live livelock-front-5 bytes with the `factGuard` key
  stripped): first bridge pass rebuilds (`reevaluated` 1, report
  present with 0 claims requiring review, one audit row), the draft
  goes to human review on substance (2 claims < the 3-claim floor),
  and a second pass never re-triggers (`reevaluated` 0, still one audit
  row).

## Consequences

- The 29 ready flag-off drafts become gate-decidable over the next
  bridge passes, one rebuild each, with zero AI spend.
- No migration, schema stays 13, app stays 1.49.0. No flag: the build
  runs whenever the bridge meets a `report_absent` draft, in any mode
  the bridge runs in.
- Honest limit: a rebuilt report can only ground what the stored
  excerpt contains — a draft whose claims were never witnessed stays
  refused/review, and the rebuild never rewrites a claim's stored
  `unverified` status.
