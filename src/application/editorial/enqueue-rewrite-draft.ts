/**
 * Rewrite-job enqueue boundary (ADR-0070 §5): the ONLY way an
 * `editorial.rewrite_draft` durable job is created at draft creation.
 * The prepare-draft handler calls this immediately after its fenced
 * commit succeeds, while `AI_GEMINI_REWRITE_ENABLED` is on.
 *
 * The job row is inserted DIRECTLY through the job store (not through
 * the engine's `createDurableJob` — the handler has no engine
 * reference, and the engine is constructed AFTER the handlers): the
 * row lands `pending` with a deterministic id + idempotency key per
 * draft, and the engine's ordinary dispatch scan picks it up. The
 * payload is validated through the same `parseJobPayload` contract
 * before the insert, so a schema drift fails loud here instead of
 * planting an unexecutable row.
 *
 * Idempotency: the idempotency key AND the job id are deterministic per
 * draft id — re-enqueueing the same draft resolves the SAME job row
 * (`jobs.idempotency_key` UNIQUE); an incompatible re-use is the
 * engine's `conflict` outcome, surfaced verbatim, never swallowed.
 *
 * Best-effort by design: the caller treats an enqueue failure as a
 * WARN, never as a prepare-draft failure — the draft is already
 * committed, and failing the job would only replay into the
 * stable-result reuse path, which never re-enqueues. A missed enqueue
 * leaves the draft raw; the bridge defers it while the flag is on (see
 * docs/OPEN_DECISIONS.md — the backfill question for pre-existing raw
 * drafts).
 *
 * `maxAttempts: 10` (engine default is 3): one execution per rewrite
 * invocation (max 2 service attempts) PLUS quota-deferral retries —
 * one execution per Tehran day at most, so 10 executions cover the
 * service budget with headroom across quota days.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import { createJob } from '../../adapters/db/job-store';
import { canonicalizeJson, parseJobPayload } from '../../domain/jobs/payloads';
import {
  editorialRewriteDraftIdempotencyKey,
  rewriteJobIdForDraft,
} from '../../domain/editorial/identity';
import type { Logger } from '../../observability/logger';

/** Engine executions allowed for one draft's rewrite job (see header). */
export const REWRITE_JOB_MAX_ATTEMPTS = 10;

export type EnqueueRewriteDraftResult =
  | { readonly kind: 'created' | 'existing' | 'conflict'; readonly jobId: string }
  | { readonly kind: 'rejected'; readonly reason: 'payload_invalid' | 'store_error' };

export async function enqueueRewriteDraftForDraft(input: {
  readonly executor: DbExecutor;
  readonly draftId: string;
  readonly nowMs: number;
  readonly logger?: Logger;
}): Promise<EnqueueRewriteDraftResult> {
  const canonical = canonicalizeJson({ draftId: input.draftId });
  const check = parseJobPayload('editorial.rewrite_draft', canonical);
  if (!check.ok) {
    input.logger?.warn('editorial.rewrite_enqueue.payload_invalid');
    return { kind: 'rejected', reason: 'payload_invalid' };
  }
  const idempotencyKey = await editorialRewriteDraftIdempotencyKey(input.draftId);
  const jobId = await rewriteJobIdForDraft(input.draftId);
  try {
    const result = await createJob(
      input.executor,
      {
        id: jobId,
        type: 'editorial.rewrite_draft',
        idempotencyKey,
        canonicalPayloadJson: canonical,
        priority: 50,
        runAfterMs: input.nowMs,
        maxAttempts: REWRITE_JOB_MAX_ATTEMPTS,
        aggregateType: 'draft',
        aggregateId: input.draftId,
      },
      input.nowMs,
    );
    input.logger?.info('editorial.rewrite_enqueue.created', {
      draftId: input.draftId,
      jobId: result.jobId,
      kind: result.kind,
    });
    return result;
  } catch {
    input.logger?.warn('editorial.rewrite_enqueue.store_error', { draftId: input.draftId });
    return { kind: 'rejected', reason: 'store_error' };
  }
}
