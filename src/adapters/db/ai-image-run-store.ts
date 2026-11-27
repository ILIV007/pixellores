/**
 * AI IMAGE attempt recording (ADR-0072): the DURABLE per-attempt log
 * for image generation, over the EXISTING `ai_runs` table (migration
 * 0001, unchanged) with `task = 'image_generation'`.
 *
 * One row per provider attempt that actually ran (model, prompt
 * version, input hash of the prompt, status, latency, error code).
 * A never-attempted run (zero provider involvement — budget denied,
 * breaker open, flag off) is never written: a provider that did not
 * run is never fabricated. The insert is idempotent by id
 * (`WHERE NOT EXISTS`): a retried record of the same attempt id is
 * absorbed, never duplicated.
 *
 * The prompt TEXT lives in `media_assets.ai_prompt` (migration 0012,
 * only for the winning attempt that produced a stored asset); this
 * table carries the prompt's SHA-256 hash (input identity), never the
 * text — the same discipline as the text draft path.
 */
import type { DbExecutor } from './db-executor';

/** The ai_runs task value for image-generation attempts. */
export const AI_IMAGE_RUN_TASK = 'image_generation';

export interface ImageAiRunRecord {
  readonly id: string;
  readonly model: string;
  readonly promptVersion: string;
  /** SHA-256 hex of the prompt text (input identity, never the text). */
  readonly inputHash: string;
  readonly status: 'succeeded' | 'failed' | 'invalid';
  readonly latencyMs: number | null;
  readonly errorCode: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

/**
 * Insert ONE image-generation ai_runs row (idempotent by id). Returns
 * true when the row was written. Throws on a D1 error — callers treat
 * a failed record as best-effort bookkeeping (warn + continue), never
 * as a failed generation.
 */
export async function recordImageAiRun(
  executor: DbExecutor,
  run: ImageAiRunRecord,
): Promise<boolean> {
  const meta = await executor.run({
    sql: `INSERT INTO ai_runs (id, task, provider, model, prompt_version, input_hash, status,
                                latency_ms, input_tokens, output_tokens, error_code,
                                error_message, created_at, completed_at)
          SELECT ?, ?, 'workers-ai', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM ai_runs WHERE id = ?)`,
    params: [
      run.id,
      AI_IMAGE_RUN_TASK,
      run.model,
      run.promptVersion,
      run.inputHash,
      run.status,
      run.latencyMs,
      run.errorCode,
      run.createdAt,
      run.completedAt,
      run.id,
    ],
  });
  return meta.changes > 0;
}
