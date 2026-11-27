import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0013 — bridge gate-evaluation progress (ADR-0073; schema
 * version 12 → 13). This file has its OWN isolated storage
 * (vitest-pool-workers isolates per test FILE), so it proves the full
 * upgrade path of a POPULATED schema-v12 database:
 *
 *  1. apply ONLY migrations 0001..0012 -> a genuine schema-v12 database;
 *  2. apply the real append-only plan -> ONLY 0013 is pending;
 *  3. schema version becomes 13 with the 0013 migration id;
 *  4. the `draft_gate_evaluations` table exists with its CHECK
 *     constraints enforced at the DATABASE level (an unknown outcome
 *     and a negative consecutive-failure count both refuse);
 *  5. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019); a real database receives
 * 0013 exclusively through `wrangler d1 migrations apply` with explicit
 * owner approval (NONE has been requested or executed).
 */

const db: D1Database = env.DB;

const V12_ONLY: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 12,
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
  // Build the version-12 baseline ONCE per test; storage persists across
  // tests WITHIN this file, so on later tests the V12 plan is a no-op.
  await applyMigrations(db, V12_ONLY);
  // Upgrade to the real append-only plan — on the first run ONLY 0013 is
  // pending; on later tests this is an idempotent no-op. Either way the
  // database ends at version 13.
  const upgrade = await applyMigrations(db);
  expect(upgrade.finalVersion).toBe(13);
});

describe('ADR-0073 — migration 0013: bridge gate-evaluation progress (schema 12 → 13)', () => {
  it('applies exactly 0013 as the only pending step on a fresh schema-v12 database', async () => {
    const rerun = await applyMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.finalVersion).toBe(13);
    expect(await appliedSchemaVersion()).toBe(13);
    const idRow = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(idRow?.value).toBe('0013_bridge_gate_progress');
  });

  it('creates draft_gate_evaluations with its CHECK constraints enforced', async () => {
    await executor.run({
      sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, first_seen_at, last_evidence_at, created_at, updated_at)
            VALUES ('edst-mig13', 'editorial.story:mig13', 'discovered', 'official', 'official_news', 1, 1, 1, 1)`,
    });
    await executor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json, version, created_by, created_at, updated_at)
            VALUES ('eddr-mig13', 'edst-mig13', 'ready', 'fa', 'news_v1', 'تیتر آزمون ۱۳', '{}', 1, 'test', 1, 1)`,
    });
    await executor.run({
      sql: `INSERT INTO draft_gate_evaluations
              (draft_id, last_evaluated_at_ms, last_outcome, consecutive_failures, last_failure_reason, updated_at_ms)
            VALUES ('eddr-mig13', 1000, 'requires_review', 2, 'fact_guard_findings', 1000)`,
    });
    const row = await executor.first<{
      draft_id: string;
      last_outcome: string;
      consecutive_failures: number;
      last_failure_reason: string | null;
    }>({
      sql: `SELECT draft_id, last_outcome, consecutive_failures, last_failure_reason
             FROM draft_gate_evaluations WHERE draft_id = ?`,
      params: ['eddr-mig13'],
    });
    expect(row).toEqual({
      draft_id: 'eddr-mig13',
      last_outcome: 'requires_review',
      consecutive_failures: 2,
      last_failure_reason: 'fact_guard_findings',
    });
    // An unknown outcome refuses at the DATABASE level.
    await expect(
      executor.run({
        sql: `INSERT INTO draft_gate_evaluations
                (draft_id, last_evaluated_at_ms, last_outcome, consecutive_failures, last_failure_reason, updated_at_ms)
              VALUES ('eddr-mig13-bad-outcome', 1000, 'maybe', 0, NULL, 1000)`,
      }),
    ).rejects.toThrow();
    // A negative consecutive-failure count refuses at the DATABASE level.
    await expect(
      executor.run({
        sql: `INSERT INTO draft_gate_evaluations
                (draft_id, last_evaluated_at_ms, last_outcome, consecutive_failures, last_failure_reason, updated_at_ms)
              VALUES ('eddr-mig13-bad-count', 1000, 'refused', -1, 'report_absent', 1000)`,
      }),
    ).rejects.toThrow();
  });
});
