-- PIXEL — D1 migration 0013: bridge gate-evaluation progress (ADR-0074).
--
-- THE BUG IT FIXES: the draft→publication bridge scans ready drafts
-- oldest-first, LIMIT 5, with no progress marker. The auto-gate is TOTAL
-- and deterministic over stored bytes, so five oldest drafts that fail
-- the gate deterministically (stale pre-ADR-0066 fact-guard reports: the
-- numbers lens evaluated Persian digits verbatim) are re-scanned on EVERY
-- 5-minute pass, fail the same way, and write nothing — the other 48
-- ready drafts are NEVER reached and the channel stalls indefinitely.
-- Two layers, both recorded here:
--
--   draft_gate_evaluations  one row per draft the bridge has gate-
--                           evaluated: the last verdict, the consecutive
--                           failure count, and the last failure reason.
--                           The bridge orders its scan by
--                           (consecutive_failures ASC, created_at ASC),
--                           so each pass reaches unevaluated drafts
--                           first; a draft that keeps failing sinks
--                           below fresh ones instead of head-blocking
--                           the queue. The table is PROGRESS, not a
--                           verdict: it never changes what the gate
--                           decides, only which drafts a pass looks at.
--
-- The fact-guard re-evaluation itself (ADR-0074 layer 1) needs NO DDL:
-- the report rides INSIDE drafts.document_json, and the re-evaluation
-- rewrites that field under the existing compare-and-swap update.
--
-- LINEAR MIGRATION PATH (append-only, AGENTS.md §6): 0001 (v1) -> 0002 (v2)
-- -> 0003 (v3) -> 0004 (v4) -> 0005 (v5) -> 0006 (v6) -> 0007 (v7)
-- -> 0008 (v8) -> 0009 (v9) -> 0010 (v10) -> 0011 (v11) -> 0012 (v12)
-- -> THIS FILE (v13). Version 13 therefore MEANS "bridge gate-evaluation
-- progress present AND AI image provenance present AND the autonomous
-- publications outbox carries the Soul stamp". Remote application is
-- performed exclusively by `wrangler d1 migrations apply` with explicit
-- owner approval.

CREATE TABLE IF NOT EXISTS draft_gate_evaluations (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  last_evaluated_at_ms INTEGER NOT NULL,
  last_outcome TEXT NOT NULL CHECK (last_outcome IN ('eligible_auto', 'requires_review', 'refused')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_failure_reason TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_evaluations_progress
  ON draft_gate_evaluations(consecutive_failures, last_evaluated_at_ms);

UPDATE schema_metadata
   SET value = '13',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0013_bridge_gate_progress',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
