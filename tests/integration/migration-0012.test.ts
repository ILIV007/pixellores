import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0012 — AI image-generation provenance (ADR-0072; schema
 * version 11 → 12). This file has its OWN isolated storage
 * (vitest-pool-workers isolates per test FILE), so it proves the full
 * upgrade path of a POPULATED schema-v11 database:
 *
 *  1. apply ONLY migrations 0001..0011 -> a genuine schema-v11 database;
 *  2. apply the real append-only plan -> ONLY 0012 is pending;
 *  3. schema version becomes 12 with the 0012 migration id;
 *  4. the four nullable `media_assets.ai_*` columns exist and accept
 *     valid provenance (NULL seed for the seed-less flux model), and
 *     the `ai_seed` CHECK refuses negative seeds at the DATABASE level;
 *  5. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019); a real database receives
 * 0012 exclusively through `wrangler d1 migrations apply` with explicit
 * owner approval (NONE has been requested or executed).
 */

const db: D1Database = env.DB;

const V11_ONLY: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 11,
);

const executor = createDbExecutor(db);

async function appliedSchemaVersion(): Promise<number> {
  const row = await executor
    .first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'schema_version'`,
    })
    .catch(() => null);
  return row === null ? 0 : Number.parseInt(row.value, 10);
}

beforeEach(async () => {
  // Build the version-11 baseline ONCE per test; storage persists across
  // tests WITHIN this file, so on later tests the V11 plan is a no-op.
  await applyMigrations(db, V11_ONLY);
  // Upgrade to the real append-only plan — on the first run ONLY 0012 is
  // pending; on later tests this is an idempotent no-op. Either way the
  // database ends at version 12.
  const upgrade = await applyMigrations(db);
  expect(upgrade.finalVersion).toBe(12);
});

describe('ADR-0072 — migration 0012: AI image provenance (schema 11 → 12)', () => {
  it('applies exactly 0012 as the only pending step on a fresh schema-v11 database', async () => {
    const rerun = await applyMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(12);
    expect(await appliedSchemaVersion()).toBe(12);
    const idRow = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(idRow?.value).toBe('0012_ai_image_provenance');
  });

  it('adds the four nullable ai_* columns; pre-existing rows stay NULL', async () => {
    // A legacy source-photo row (inserted through the pre-0012 column
    // set) carries NULL provenance — NULL means "not AI-generated".
    await executor.run({
      sql: `INSERT INTO media_assets (id, source_item_id, type, canonical_url, source_url,
              mime_type, width, height, duration_seconds, file_size, sha256, visual_key,
              rights_status, attribution, r2_key, telegram_file_id, status, expires_at,
              created_at, updated_at)
            VALUES ('mda-legacy', NULL, 'photo', 'https://cdn.example.com/old.jpg',
              'https://cdn.example.com/old.jpg', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              'attribution_required', 'cdn.example.com', NULL, NULL, 'validated', NULL, 1, 1)`,
    });
    const legacy = await executor.first<{
      ai_provider: string | null;
      ai_model: string | null;
      ai_prompt: string | null;
      ai_seed: number | null;
    }>({
      sql: `SELECT ai_provider, ai_model, ai_prompt, ai_seed FROM media_assets WHERE id = ?`,
      params: ['mda-legacy'],
    });
    expect(legacy).toEqual({
      ai_provider: null,
      ai_model: null,
      ai_prompt: null,
      ai_seed: null,
    });
  });

  it('accepts a generated row with full provenance and a NULL seed (flux takes no seed)', async () => {
    await executor.run({
      sql: `INSERT INTO media_assets (id, source_item_id, type, canonical_url, source_url,
              mime_type, width, height, duration_seconds, file_size, sha256, visual_key,
              rights_status, attribution, r2_key, telegram_file_id, status, expires_at,
              created_at, updated_at, ai_provider, ai_model, ai_prompt, ai_seed)
            VALUES ('mda-gen', NULL, 'photo', NULL, NULL,
              'image/jpeg', 1024, 1024, NULL, 1234, 'aabbcc', NULL,
              'official', 'ai-generated', NULL, NULL, 'validated', NULL, 1, 1,
              'workers-ai', '@cf/black-forest-labs/flux-1-schnell',
              'Cinematic wide shot, dramatic breaking-news scene, no text in image, no logo, no watermark', NULL)`,
    });
    const row = await executor.first<{
      ai_provider: string | null;
      ai_model: string | null;
      ai_prompt: string | null;
      ai_seed: number | null;
      sha256: string | null;
    }>({
      sql: `SELECT ai_provider, ai_model, ai_prompt, ai_seed, sha256 FROM media_assets WHERE id = ?`,
      params: ['mda-gen'],
    });
    expect(row?.ai_provider).toBe('workers-ai');
    expect(row?.ai_model).toBe('@cf/black-forest-labs/flux-1-schnell');
    expect(row?.ai_prompt).toContain('no text in image');
    expect(row?.ai_seed).toBeNull();
    expect(row?.sha256).toBe('aabbcc');
  });

  it('accepts a non-negative seed and refuses a negative seed at the database level', async () => {
    await executor.run({
      sql: `INSERT INTO media_assets (id, type, rights_status, status, created_at, updated_at,
              ai_provider, ai_model, ai_prompt, ai_seed)
            VALUES ('mda-seeded', 'photo', 'official', 'validated', 1, 1,
              'workers-ai', '@cf/future/model', 'prompt', 42)`,
    });
    const seeded = await executor.first<{ ai_seed: number | null }>({
      sql: `SELECT ai_seed FROM media_assets WHERE id = ?`,
      params: ['mda-seeded'],
    });
    expect(seeded?.ai_seed).toBe(42);
    await expect(
      executor.run({
        sql: `INSERT INTO media_assets (id, type, rights_status, status, created_at, updated_at,
                ai_provider, ai_model, ai_prompt, ai_seed)
              VALUES ('mda-bad-seed', 'photo', 'official', 'validated', 1, 1,
                'workers-ai', '@cf/future/model', 'prompt', -1)`,
      }),
    ).rejects.toThrow();
  });
});
