/**
 * Audit-events read boundary (ADR-0081).
 *
 * Writes stay where they belong: every owning store inlines its own
 * `INSERT INTO audit_events` (publishing-settings, human-approval,
 * post-management, admin-manage, source-registry, …) because the audit
 * row must ride the SAME atomic batch as the change it records. This
 * module owns only the READ side — the recent-events feed for the admin
 * panels' audit screens. `metadata_json` parses defensively: a corrupt
 * row surfaces as `metadata: null`, never an exception.
 */
import type { DbExecutor } from './db-executor';

export interface AuditEventRow {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: number;
}

interface AuditEventDbRow {
  readonly id: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly metadata_json: string;
  readonly created_at: number;
}

function parseMetadata(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The most recent audit events, newest first. Bounded (limit ≤ 50) —
 * the audit feed is a human screen, never a dump.
 */
export async function listRecentAuditEvents(
  executor: DbExecutor,
  input: { readonly limit: number },
): Promise<readonly AuditEventRow[]> {
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit)));
  const rows = await executor.query<AuditEventDbRow>({
    sql: `SELECT id, actor_type, actor_id, action, target_type, target_id,
            metadata_json, created_at
          FROM audit_events
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
    params: [limit],
  });
  return rows.rows.map((row) => ({
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  }));
}
