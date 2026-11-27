import type { DbExecutor } from './db-executor';
import { isAppError } from '../../shared/errors/app-error';

/**
 * THE DURABLE HUMAN-APPROVAL TRANSITIONS (combined admin panel, design
 * §5) — the fenced routes a human approval takes:
 *   'ready' → 'approved'   (the panel then enqueues the outbox row)
 *   'ready' → 'rejected'   (terminal, audited, never deleted)
 *
 * THE HONESTY BOUNDARY (pinned by the combined-panel suite, mirroring
 * the auto-approval store's discipline):
 *  - THE FENCE IS `WHERE id = ? AND status = 'ready'` — an already
 *    approved/rejected draft, a superseded/failed draft or any other
 *    status refuses `not_ready` with ZERO writes; the UPDATE rowcount is
 *    the authority, and the post-fence re-read distinguishes the honest
 *    idempotent absorption (`already_approved` / `already_rejected`,
 *    no second audit event) from a lost race.
 *  - THE AUDIT: ONE admin event per applied transition, carrying the
 *    actor telegram id and the measured data only — never document
 *    content, never secrets. The audit failure does NOT roll back the
 *    fence (the status is the authority); a duplicate audit id is
 *    absorbed, never a second event.
 *  - APPROVE DOES NOT ENQUEUE: the caller (the panel) enqueues the
 *    outbox row AFTER the flip, through `enqueuePublication`. If the
 *    enqueue refuses, the draft stays `approved` and the next Approve
 *    tap retries the enqueue alone — the transition is idempotent, so a
 *    refused enqueue never strands a draft.
 *
 * The status vocabulary is UNTOUCHED: `approved` / `rejected` are the
 * blueprint drafts CHECK values the outbox MODE_STATUS_MATRIX already
 * accepts for the 'approval' mode (`approved`) — this store is the
 * producer the human path was missing. ZERO DDL (schema 12 UNCHANGED).
 */

/** The deterministic audit actions (the query surface of the panel suite). */
export const HUMAN_APPROVAL_AUDIT_ACTIONS = {
  approved: 'draft_approved',
  rejected: 'draft_rejected',
} as const;

/** The audit permissions recorded on each human-approval event. */
export const HUMAN_APPROVAL_AUDIT_PERMISSIONS = {
  approved: 'draft.approve',
  rejected: 'draft.reject',
} as const;

export type ApproveDraftForHumanPublicationOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'already_approved' }
  | { readonly kind: 'draft_not_found' }
  | { readonly kind: 'not_ready' };

export type RejectDraftForHumanPublicationOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'already_rejected' }
  | { readonly kind: 'draft_not_found' }
  | { readonly kind: 'not_ready' };

async function recordHumanApprovalAudit(
  executor: DbExecutor,
  input: {
    readonly draftId: string;
    readonly actorId: number;
    readonly action: string;
    readonly permission: string;
    readonly nowMs: number;
  },
): Promise<void> {
  try {
    await executor.run({
      sql: `INSERT INTO audit_events (id, actor_type, actor_id, action, target_type,
              target_id, trace_id, metadata_json, created_at)
            VALUES (?, 'admin', ?, ?, 'draft', ?, NULL, ?, ?)`,
      params: [
        `human-approval:${input.action}:${input.draftId}`,
        String(input.actorId),
        input.action,
        input.draftId,
        JSON.stringify({
          permission: input.permission,
          priorStatus: 'ready',
        }),
        input.nowMs,
      ],
    });
  } catch (error) {
    if (!(isAppError(error) && error.code === 'db_constraint_violation')) {
      throw error;
    }
    // A duplicate audit id means the fence fired twice for the same draft
    // within the same millisecond window — the audit absorption, never a
    // second event.
  }
}

export async function approveDraftForHumanPublication(
  executor: DbExecutor,
  input: {
    readonly draftId: string;
    readonly actorId: number;
    readonly nowMs: number;
  },
): Promise<ApproveDraftForHumanPublicationOutcome> {
  // THE FENCED TRANSITION: only a 'ready' draft may become 'approved'.
  // The rowcount is the authority.
  const fence = await executor.run({
    sql: `UPDATE drafts SET status = 'approved', updated_at = ?
          WHERE id = ? AND status = 'ready'`,
    params: [input.nowMs, input.draftId],
  });
  if (fence.changes === 0) {
    // The fence did not fire: re-read for the HONEST reason — an idempotent
    // re-call (already approved) is absorbed, a human/terminal state is
    // refused, a missing draft is reported, never guessed.
    const existing = await executor.first<{ readonly status: string }>({
      sql: `SELECT status FROM drafts WHERE id = ?`,
      params: [input.draftId],
    });
    if (!existing) {
      return { kind: 'draft_not_found' };
    }
    return existing.status === 'approved' ? { kind: 'already_approved' } : { kind: 'not_ready' };
  }

  await recordHumanApprovalAudit(executor, {
    draftId: input.draftId,
    actorId: input.actorId,
    action: HUMAN_APPROVAL_AUDIT_ACTIONS.approved,
    permission: HUMAN_APPROVAL_AUDIT_PERMISSIONS.approved,
    nowMs: input.nowMs,
  });
  return { kind: 'applied' };
}

export async function rejectDraftForHumanPublication(
  executor: DbExecutor,
  input: {
    readonly draftId: string;
    readonly actorId: number;
    readonly nowMs: number;
  },
): Promise<RejectDraftForHumanPublicationOutcome> {
  // THE FENCED TRANSITION: only a 'ready' draft may become 'rejected'.
  // The rowcount is the authority.
  const fence = await executor.run({
    sql: `UPDATE drafts SET status = 'rejected', updated_at = ?
          WHERE id = ? AND status = 'ready'`,
    params: [input.nowMs, input.draftId],
  });
  if (fence.changes === 0) {
    // The fence did not fire: re-read for the HONEST reason — an idempotent
    // re-call (already rejected) is absorbed, any other state is refused,
    // a missing draft is reported, never guessed.
    const existing = await executor.first<{ readonly status: string }>({
      sql: `SELECT status FROM drafts WHERE id = ?`,
      params: [input.draftId],
    });
    if (!existing) {
      return { kind: 'draft_not_found' };
    }
    return existing.status === 'rejected' ? { kind: 'already_rejected' } : { kind: 'not_ready' };
  }

  await recordHumanApprovalAudit(executor, {
    draftId: input.draftId,
    actorId: input.actorId,
    action: HUMAN_APPROVAL_AUDIT_ACTIONS.rejected,
    permission: HUMAN_APPROVAL_AUDIT_PERMISSIONS.rejected,
    nowMs: input.nowMs,
  });
  return { kind: 'applied' };
}
