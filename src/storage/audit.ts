import type { LifecycleState } from '../domain/types.js';
import type { Queryable, Tx } from './db.js';

export type AuditAction = 'ingested' | 'duplicate_sighting' | 'confirmed' | 'orphaned' | 'reactivated' | 'payload_mismatch';

export interface AuditRow {
  eventId: string;
  action: AuditAction;
  from: LifecycleState | null;
  to: LifecycleState | null;
  reason: string;
  details?: Record<string, unknown>;
}

/** Appends to the event audit trail. Rows are never updated or deleted. */
export async function insertAudit(tx: Tx, chainId: number, rows: readonly AuditRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.query(
    `INSERT INTO event_audit (chain_id, event_id, action, from_state, to_state, reason, details)
     SELECT $1::bigint, t.event_id, t.action, t.from_state, t.to_state, t.reason, t.details::jsonb
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
            AS t(event_id, action, from_state, to_state, reason, details)`,
    [
      chainId,
      rows.map((r) => r.eventId),
      rows.map((r) => r.action),
      rows.map((r) => r.from),
      rows.map((r) => r.to),
      rows.map((r) => r.reason),
      rows.map((r) => JSON.stringify(r.details ?? {})),
    ],
  );
}

export type RecoveryKind = 'backfill' | 'reorg' | 'resume' | 'halt' | 'unhalt' | 'replay' | 'outbox_requeue';

export interface RecoveryEntry {
  kind: RecoveryKind;
  fromBlock?: number | null;
  toBlock?: number | null;
  summary: string;
  details?: Record<string, unknown>;
}

/** Evidence that a recovery step happened; surfaced by GET /status and in the scenario output. */
export async function recordRecovery(db: Queryable, chainId: number, entry: RecoveryEntry): Promise<void> {
  await db.query(
    `INSERT INTO recovery_log (chain_id, kind, from_block, to_block, summary, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [chainId, entry.kind, entry.fromBlock ?? null, entry.toBlock ?? null, entry.summary, JSON.stringify(entry.details ?? {})],
  );
}

export type IncidentKind = 'scanner_halted' | 'confirmed_event_orphaned' | 'undecodable_log' | 'payload_mismatch';

export interface IncidentInput {
  kind: IncidentKind;
  severity: 'warning' | 'critical';
  requiresManualReview: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export async function openIncident(db: Queryable, chainId: number, incident: IncidentInput): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO incidents (chain_id, kind, severity, requires_manual_review, summary, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [chainId, incident.kind, incident.severity, incident.requiresManualReview, incident.summary, JSON.stringify(incident.details ?? {})],
  );
  return rows[0]?.id ?? 0;
}
