import { buildPayload } from '../confirmation/notification.js';
import { notificationIdOf } from '../domain/identity.js';
import type { EventKind, EventStatus, HeadRef, Hex } from '../domain/types.js';
import type { WatchIndex } from '../domain/watchlist.js';
import { FlowDeltas, subtractFlows } from '../ingestion/projection.js';
import { insertAudit, openIncident, type AuditRow } from '../storage/audit.js';
import type { Tx } from '../storage/db.js';

export interface OrphanInput {
  chainId: number;
  /** Last block both branches share. Everything canonical above it is orphaned. */
  ancestor: HeadRef;
  reason: string;
  watch: WatchIndex;
}

export interface OrphanSummary {
  blocks: Array<{ number: number; hash: Hex }>;
  events: number;
  fromProvisional: number;
  fromConfirmed: number;
  alertsWithdrawn: number;
  outboxSuppressed: number;
  retractionsQueued: number;
  incidentId: number | null;
  eventIds: string[];
}

interface OrphanedRow {
  event_id: string;
  kind: EventKind;
  contract_address: Hex;
  block_number: number;
  block_hash: Hex;
  transaction_hash: Hex;
  log_index: number;
  decoded: { from?: string; to?: string; value?: string };
  amount: string;
  confirm_count: number;
  old_status: EventStatus;
}

const EMPTY: OrphanSummary = {
  blocks: [],
  events: 0,
  fromProvisional: 0,
  fromConfirmed: 0,
  alertsWithdrawn: 0,
  outboxSuppressed: 0,
  retractionsQueued: 0,
  incidentId: null,
  eventIds: [],
};

/**
 * Takes every canonical block above `ancestor` out of the canonical chain and corrects everything
 * derived from it, inside the caller's transaction:
 *
 *   blocks    -> flagged non-canonical with the reason (never deleted)
 *   events    -> orphaned, one audit row each
 *   flows     -> the events' contributions are subtracted
 *   alerts    -> withdrawn
 *   outbox    -> undelivered notifications suppressed; already-delivered ones get a retraction
 *   incident  -> opened if any *confirmed* event was orphaned, because that needs a human
 *
 * Idempotent by construction: every statement only matches rows that are still canonical / not yet
 * orphaned, so running it twice changes nothing the second time.
 */
export async function orphanCanonicalAbove(tx: Tx, input: OrphanInput): Promise<OrphanSummary> {
  const { chainId, ancestor, reason } = input;

  const blockRows = await tx.query<{ block_number: number; block_hash: Hex }>(
    `UPDATE chain_blocks
        SET canonical = false, orphaned_at = now(), orphan_reason = $3
      WHERE chain_id = $1 AND canonical AND block_number > $2
      RETURNING block_number, block_hash`,
    [chainId, ancestor.number, reason],
  );
  if (blockRows.rows.length === 0) return { ...EMPTY };
  const blocks = blockRows.rows
    .map((r) => ({ number: r.block_number, hash: r.block_hash }))
    .sort((a, b) => a.number - b.number);

  const { rows: events } = await tx.query<OrphanedRow>(
    `WITH old AS (
       SELECT event_id, status AS old_status
         FROM chain_events
        WHERE chain_id = $1 AND block_hash = ANY($2::text[]) AND status <> 'orphaned'
          FOR UPDATE
     )
     UPDATE chain_events e
        SET status = 'orphaned', status_reason = $3, status_changed_at = now()
       FROM old
      WHERE e.event_id = old.event_id
      RETURNING e.event_id, e.kind, e.contract_address, e.block_number, e.block_hash, e.transaction_hash,
                e.log_index, e.decoded, e.amount::text AS amount, e.confirm_count, old.old_status`,
    [chainId, blocks.map((b) => b.hash), reason],
  );
  if (events.length === 0) return { ...EMPTY, blocks };

  const eventIds = events.map((e) => e.event_id);

  // Derived state: subtract what these events contributed.
  const deltas = new FlowDeltas();
  for (const e of events) {
    if (e.kind === 'erc20_transfer' && e.decoded.from && e.decoded.to) {
      deltas.addTransfer(e.contract_address, e.decoded.from, e.decoded.to, BigInt(e.amount));
    }
  }
  await subtractFlows(tx, chainId, deltas);

  const alerts = await tx.query(
    `UPDATE alerts SET status = 'withdrawn', status_reason = $2, updated_at = now()
      WHERE event_id = ANY($1::text[]) AND status = 'open'`,
    [eventIds, reason],
  );

  // Notifications that were delivered before we learned the event is gone need a correction. Do this
  // before suppressing, while their status is still readable.
  const delivered = await tx.query<{ event_id: string }>(
    `SELECT DISTINCT event_id FROM outbox
      WHERE event_id = ANY($1::text[]) AND notification_type = 'event_confirmed' AND status = 'processed'`,
    [eventIds],
  );
  const deliveredIds = new Set(delivered.rows.map((r) => r.event_id));

  const suppressed = await tx.query(
    `UPDATE outbox
        SET status = 'suppressed', status_reason = 'event orphaned before delivery', processed_at = now()
      WHERE event_id = ANY($1::text[]) AND notification_type = 'event_confirmed' AND status IN ('pending', 'published')`,
    [eventIds],
  );

  const retractions = events
    .filter((e) => e.old_status === 'confirmed' && deliveredIds.has(e.event_id))
    .map((e) => {
      const notificationId = notificationIdOf(e.event_id, 'event_retracted', e.confirm_count);
      return {
        notificationId,
        eventId: e.event_id,
        payload: buildPayload(
          {
            notificationId,
            type: 'event_retracted',
            chainId,
            eventId: e.event_id,
            eventKind: e.kind,
            contract: e.contract_address,
            blockNumber: e.block_number,
            blockHash: e.block_hash,
            transactionHash: e.transaction_hash,
            logIndex: e.log_index,
            amountUnits: e.amount,
            thresholdUnits: '0',
            confirmationEpoch: e.confirm_count,
          },
          input.watch.byAddress.get(e.contract_address),
          { retractionReason: reason },
        ),
      };
    });
  if (retractions.length > 0) {
    await tx.query(
      `INSERT INTO outbox (chain_id, notification_id, event_id, notification_type, payload)
       SELECT $1::bigint, t.notification_id, t.event_id, 'event_retracted', t.payload::jsonb
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(notification_id, event_id, payload)
       ON CONFLICT (notification_id) DO NOTHING`,
      [chainId, retractions.map((r) => r.notificationId), retractions.map((r) => r.eventId), retractions.map((r) => JSON.stringify(r.payload))],
    );
  }

  const audit: AuditRow[] = events.map((e) => ({
    eventId: e.event_id,
    action: 'orphaned',
    from: e.old_status,
    to: 'orphaned',
    reason,
    details: { blockNumber: e.block_number, blockHash: e.block_hash, commonAncestor: ancestor },
  }));
  await insertAudit(tx, chainId, audit);

  const confirmed = events.filter((e) => e.old_status === 'confirmed');
  let incidentId: number | null = null;
  if (confirmed.length > 0) {
    incidentId = await openIncident(tx, chainId, {
      kind: 'confirmed_event_orphaned',
      severity: 'critical',
      requiresManualReview: true,
      summary:
        `${confirmed.length} event(s) that had already reached the confirmation depth were orphaned by a reorganization ` +
        `above block ${ancestor.number}. ${deliveredIds.size} had been delivered downstream. Automatic recovery corrected ` +
        `this service's state but cannot undo effects outside it.`,
      details: {
        commonAncestor: ancestor,
        confirmedEventIds: confirmed.map((e) => e.event_id),
        deliveredEventIds: [...deliveredIds],
        retractionNotificationIds: retractions.map((r) => r.notificationId),
      },
    });
  }

  return {
    blocks,
    events: events.length,
    fromProvisional: events.length - confirmed.length,
    fromConfirmed: confirmed.length,
    alertsWithdrawn: alerts.rowCount ?? 0,
    outboxSuppressed: suppressed.rowCount ?? 0,
    retractionsQueued: retractions.length,
    incidentId,
    eventIds,
  };
}
