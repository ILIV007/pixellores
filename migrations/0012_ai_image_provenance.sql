-- PIXEL — D1 migration 0012: AI image-generation provenance (ADR-0069).
--
-- A generated image has no canonical URL and no R2 object: its identity
-- is its content hash (`media_assets.sha256`, already present) and its
-- provenance is these four NULLABLE columns (NULL = not an AI-generated
-- asset — every pre-existing row, and every source-photo row, stays
-- NULL; a generated row carries all four, with ai_seed NULL when the
-- model takes no seed — flux-1-schnell's typed input has no seed
-- parameter, so NULL is the honest value, never a fabricated number).
--
--   media_assets    new NULLABLE columns `ai_provider` (e.g.
--                   'workers-ai'), `ai_model` (the exact model id),
--                   `ai_prompt` (the full English prompt text, D1-only
--                   audit — never rendered), `ai_seed` (the seed the
--                   provider actually used, or NULL).
--
-- LINEAR MIGRATION PATH (append-only, AGENTS.md §6): 0001 (v1) -> 0002 (v2)
-- -> 0003 (v3) -> 0004 (v4) -> 0005 (v5) -> 0006 (v6) -> 0007 (v7)
-- -> 0008 (v8) -> 0009 (v9) -> 0010 (v10) -> 0011 (v11) -> THIS FILE (v12).
-- Version 12 therefore MEANS "AI image provenance present AND the
-- autonomous publications outbox carries the Soul stamp". Remote
-- application is performed exclusively by `wrangler d1 migrations apply`
-- with explicit owner approval.

ALTER TABLE media_assets
  ADD COLUMN ai_provider TEXT;

ALTER TABLE media_assets
  ADD COLUMN ai_model TEXT;

ALTER TABLE media_assets
  ADD COLUMN ai_prompt TEXT;

ALTER TABLE media_assets
  ADD COLUMN ai_seed INTEGER CHECK (ai_seed IS NULL OR ai_seed >= 0);

UPDATE schema_metadata
   SET value = '12',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0012_ai_image_provenance',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
