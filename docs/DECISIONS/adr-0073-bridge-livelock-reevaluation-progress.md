# ADR-0073 — Bridge livelock: fact-guard re-evaluation + gate-evaluation progress

Date: 2026-11-28. Status: Accepted (owner order 2026-11-27 23:32 Tehran:
everything OK by Fri 2026-11-28 08:00; posting live on auto since 23:15
with ZERO new posts).

## Context

Posting went live on auto at 23:15:33 Tehran, 2026-11-27 (mode flipped
paused → auto, audit row present, daily cap default 15, cron every
5 min). By 23:28 NOTHING had published: the first-post monitor (12 min,
12 ticks) confirmed NO_POST_AFTER_12_MIN, and the D1 state showed zero
new publications, zero budgets, zero audit rows from the bridge — while
53 drafts sat `ready`.

The bridge (`src/application/publishing/auto-publish-bridge.ts`) scans
ready drafts oldest-first, LIMIT 5, with NO cursor or progress marker
(`listReadyDrafts`: ORDER BY created_at ASC, id ASC LIMIT ?). The
auto-gate (`evaluateAutoPublishGate`) is TOTAL and deterministic over
stored bytes: same bytes → same verdict, every pass. The five oldest
ready drafts (eddr_c402…, eddr_60e4…, eddr_27b5…, eddr_a19b…,
eddr_6cae… — full documents in the goal hidden files,
`bridge-livelock-probe-2026-11-27.json`) ALL fail the gate with
requires_review / fact_guard_findings / number_not_observed_in_evidence
(claim 0/1). The failing tokens are PERSIAN digits (۲۰۲۷، ۲۷، ۱۸، ۱۷،
۲۱) that exist in the stored evidence excerpt ONLY as LATIN digits
(2027, 27, 18, 17, 21). Verified token by token against the live D1,
and reproduced locally by running the repo's own gate over the stored
bytes.

Their stored fact-guard reports were computed Nov 21 with the PRE-fix
numbers lens — before PR #27 (ADR-0066, merged Nov 22 ~11:40) added
digit folding (Persian/Arabic-Indic digits fold to Latin in the
numbers lens ONLY). ADR-0066 deliberately left FACT_GUARD_VERSION at 1
and recorded that the stored pre-fix reports "are NOT retroactively
re-evaluated" — the bridge reads stored reports only, so no
re-evaluation path existed to rebuild them. The 20 held drafts were
the known victims; the 5 oldest ready drafts are the live ones.

Because the gate leaves failing drafts `ready` with ZERO writes, every
pass re-scans the SAME five, fails the same way, writes nothing — no
jobs, no budgets, no audit rows, no publications. The other 48 ready
drafts are NEVER scanned. The stall is INDEFINITE, not a delay.

Ruled OUT (verified live 23:28–23:31): Soul (souls v1 exists,
soul.current_version=1 — the bridge's Soul gate passes); the ADR-0070
rewrite seam (AI_GEMINI_REWRITE_ENABLED defaults 'false' — seam OFF);
the mode (publishing.mode=auto in D1).

## Decision

Two layers, shipped together. Neither changes the gate's verdict
semantics for NEW drafts, and neither loosens the fact-guard.

### 1. The fact-guard re-evaluation path (the proximate cause)

New service `src/application/editorial/fact-guard-reevaluation.ts`:
for ONE ready draft it rebuilds the fact-guard report from the draft's
OWN stored claims + the stored source item's OWN stored fields, with
the CURRENT folded lens, and replaces the stored report when — and
ONLY when — the rebuild validates:

- the stored report is a well-formed v1 report with at least one
  `number_not_observed_in_evidence` finding (the fold family — the
  ONLY family the ADR-0066 lens change can clear; every other lens
  evaluates identically under current code, so re-running it would be
  a no-op write);
- the source item still exists AND its `content_hash` still equals the
  stored report's snapshot hash (a changed item can never produce a
  report claiming an identity it does not have);
- the rebuilt excerpt's `truncated` flag still equals the stored
  report's (the excerpt is rebuilt from the item's own title +
  body_excerpt with the mapper's own `buildTraceableExcerpt` — the
  same function the original build used, so a matching item yields
  the identical excerpt text);
- the rebuilt report reads back as a valid v1 report through the
  reader's own contract (a rebuild that cannot validate is never
  stored).

The replacement is the compare-and-swap update (the rewrite
handler's discipline): it applies ONLY when the draft is still
`ready` AND its document is byte-identical to the one evaluated. ONE
system audit event (`fact_guard_reevaluated`, ids and counts only)
records the rebuild. A re-evaluation that cannot validate leaves the
stored report untouched — fail-closed, never a guessed report.

The service NEVER touches model claims, excerpts, titles or claim
`status` — only the DERIVED guard report moves. It never invents an
excerpt (no stored excerpt text exists to drift from). Reports with
an invalid snapshot identity carry only `identity_inconsistent`
findings, so the numbers trigger never fires for them.

The bridge invokes it exactly when the gate fails a draft on a
numbers finding, then decides on the REBUILT bytes in the same pass.
A re-evaluation failure (or a concurrent document change) never kills
the pass: the draft stays `ready` and the next draft is scanned.

This SUPERSEDES ADR-0066's "no re-evaluation path exists" statement:
the path now exists, scoped to the fold family, and stored pre-fix
reports clear on first contact instead of blocking the queue forever.

### 2. Bridge scan progress (the structural bug)

Migration 0013 (`draft_gate_evaluations`: draft_id, last evaluated
at, last outcome, consecutive failures, last failure reason) +
`listReadyDraftsForBridge`, which orders the scan by
(consecutive_failures ASC, created_at ASC, id ASC). `draft_id` is a
FOREIGN KEY to `drafts(id) ON DELETE CASCADE` (the repo's convention):
progress belongs to the draft and vanishes with it, so a draft wipe
never strands a gate row. Each pass records
every gate verdict it computes (best-effort: a recording failure is
logged and the pass continues — progress must never block
publishing), so deterministically-failing drafts sink below
unevaluated ones instead of head-blocking the queue. The ordering
NEVER changes what the gate decides — a draft's verdict is computed
from its own stored bytes, whatever its position in the scan. A
draft with no evaluation row counts as zero failures.

The table is PROGRESS, not a verdict: it never approves, refuses, or
re-evaluates anything on its own. If every ready draft is failing,
the oldest-failing drafts are still re-scanned (their re-evaluation
attempts are idempotent no-ops after the first pass), so no draft is
ever permanently skipped.

### 3. Schema capability (mechanical, must not be forgotten)

Schema 12 → 13 (migration 0013). `resolveSchemaCapability` gains
`known_v13_bridge_gate_progress` (+ the `BRIDGE_GATE_PROGRESS_`
constants), and BOTH ingestion ownership lists (poll-handler,
scheduler) gain the v13 kind — the documented contract is that every
newer linear state takes the ownership path exactly like v4, and a
v13 database that fell off those lists would silently lose poll
ownership. APP_VERSION 1.48.0 → 1.49.0; every version touchpoint in
`scripts/check-versions.mjs` moves with it.

## Verification

- New integration suite `tests/integration/bridge-livelock-fix.test.ts`
  over REAL workerd D1, using the five live drafts' EXACT stored bytes
  (fixture `tests/fixtures/bridge-livelock-front5.json`: the real
  `document_json` values + their source items' stored title /
  body_excerpt / content_hash): (1) all five clear under the folded
  lens and bridge in ONE pass (5 approved, 5 enqueued, 5 audit rows,
  5 progress rows, claims untouched); (2) a genuinely ungrounded
  number (۲۰۳۰, in no script in the excerpt) is NOT laundered — the
  rebuild is byte-identical, nothing is written, the draft still
  requires review; (3) fail-closed: a missing source item and a
  content-hash mismatch both leave the stored report untouched
  (reevaluationSkipped 2, zero audit rows); (4) the progress
  regression: five deterministically-failing oldest drafts + one
  passable draft behind them — pass 1 fails the front five and
  records them, pass 2 reaches the passable draft FIRST and bridges
  it (failing counts end [1, 2, 2, 2, 2]).
- New migration suite `tests/integration/migration-0013.test.ts`
  (v12 → 13, exactly 0013 pending, CHECK constraints enforced at the
  database level, re-apply is a no-op), registered in `test:db` with
  the bridge suite.
- Existing exact-equality bridge expectations updated for the two new
  report fields (`reevaluated`, `reevaluationSkipped`):
  slice09 (2 sites) + publication-96 (3 sites).
- Gate semantics for NEW drafts unchanged: the full `npm run check`
  - `npm run test:db` suite passes unmodified apart from the above.
- Live verification (required before calling it done): after deploy,
  /version shows the new commit, /health ready, mode still auto in
  D1, and NEW publication rows appear with the FIRST new post landing
  in @pixellores in the approved form #4. If the first new post comes
  out in the OLD form, the render path is broken too — report it, do
  not paper over it.

## Consequences

- The 5 front drafts clear on the first post-fix bridge pass; the
  remaining 48 ready drafts are reached within ~11 passes (5/pass).
  Any future deterministic front-block degrades to a slow rotation,
  never a stall.
- Stored pre-0066 reports are now self-healing on contact. The
  re-evaluation runs ONLY on gate failure with a numbers finding, so
  healthy drafts cost zero extra reads/writes.
- The `draft_gate_evaluations` table grows one row per evaluated
  draft, bounded by the drafts table. It is never read by any path
  except the bridge scan ordering.
- The bridge now performs up to one extra item read + one CAS update
  - one audit insert per numbers-failing draft per pass (bounded:
    ≤ 5/pass). The pass stays within the cron's time budget.
