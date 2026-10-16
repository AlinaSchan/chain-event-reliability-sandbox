import { notificationIdOf } from '../domain/identity.js';
import { highestConfirmableBlock } from '../domain/lifecycle.js';
import type { EventKind, Hex } from '../domain/types.js';
import type { WatchIndex } from '../domain/watchlist.js';
import { insertAudit, type AuditRow } from '../storage/audit.js';
import type { Tx } from '../storage/db.js';
import { buildPayload } from './notification.js';

export interface ConfirmInput {
  chainId: number;
  /** The durable checkpoint after this transaction's writes. Depth is measured from it, not from the provider's head. */
  checkpointNumber: number;
  depth: number;
  watch: WatchIndex;
}

export interface ConfirmResult {
  confirmed: number;
  notificationsQueued: number;
  eventIds: string[];
}

interface ConfirmedRow {
  event_id: string;
  kind: EventKind;
  contract_address: Hex;
  block_number: number;
  block_hash: Hex;
  transaction_hash: Hex;
  log_index: number;
  amount: string;
  confirm_count: number;
  alert_status: string | null;
  threshold_units: string | null;
}

/**
 * provisional -> confirmed for every canonical event whose block is at least `depth` below the
 * checkpoint. Runs inside the ingestion transaction, so "the checkpoint reached N" and "events up to
 * N - depth are confirmed" become visible together.
 *
 * This is also the only place that creates external-notification outbox rows: nothing is queued for
 * an event that is still provisional.
 */
export async function confirmEligible(tx: Tx, input: ConfirmInput): Promise<ConfirmResult> {
  const upTo = highestConfirmableBlock(input.checkpointNumber, input.depth);
  if (upTo < 0) return { confirmed: 0, notificationsQueued: 0, eventIds: [] };

  const reason = `checkpoint ${input.checkpointNumber} is at least ${input.depth} blocks above the event's block`;
  const { rows } = await tx.query<ConfirmedRow>(
    `WITH eligible AS (
       SELECT e.event_id
         FROM chain_events e
         JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_hash = e.block_hash
        WHERE e.chain_id = $1 AND e.status = 'provisional' AND b.canonical AND e.block_number <= $2
          FOR UPDATE OF e
     ), updated AS (
       UPDATE chain_events e
          SET status = 'confirmed', status_reason = $3, status_changed_at = now(), confirm_count = e.confirm_count + 1
         FROM eligible
        WHERE e.event_id = eligible.event_id
        RETURNING e.event_id, e.kind, e.contract_address, e.block_number, e.block_hash, e.transaction_hash,
                  e.log_index, e.amount::text AS amount, e.confirm_count
     )
     SELECT u.*, a.status AS alert_status, a.threshold_units::text AS threshold_units
       FROM updated u LEFT JOIN alerts a ON a.event_id = u.event_id
      ORDER BY u.block_number, u.log_index`,
    [input.chainId, upTo, reason],
  );
  if (rows.length === 0) return { confirmed: 0, notificationsQueued: 0, eventIds: [] };

  const audit: AuditRow[] = rows.map((r) => ({
    eventId: r.event_id,
    action: 'confirmed',
    from: 'provisional',
    to: 'confirmed',
    reason,
    details: {
      blockNumber: r.block_number,
      checkpoint: input.checkpointNumber,
      blocksOnTop: input.checkpointNumber - r.block_number,
      depth: input.depth,
    },
  }));
  await insertAudit(tx, input.chainId, audit);

  // Only high-value events (those with an open alert) produce a downstream notification.
  const notifications = rows
    .filter((r) => r.alert_status === 'open' && r.threshold_units !== null)
    .map((r) => {
      const notificationId = notificationIdOf(r.event_id, 'event_confirmed', r.confirm_count);
      const payload = buildPayload(
        {
          notificationId,
          type: 'event_confirmed',
          chainId: input.chainId,
          eventId: r.event_id,
          eventKind: r.kind,
          contract: r.contract_address,
          blockNumber: r.block_number,
          blockHash: r.block_hash,
          transactionHash: r.transaction_hash,
          logIndex: r.log_index,
          amountUnits: r.amount,
          thresholdUnits: r.threshold_units ?? '0',
          confirmationEpoch: r.confirm_count,
        },
        input.watch.byAddress.get(r.contract_address),
        { confirmedAtCheckpoint: input.checkpointNumber, confirmationDepth: input.depth },
      );
      return { notificationId, eventId: r.event_id, payload };
    });

  let queued = 0;
  if (notifications.length > 0) {
    const res = await tx.query(
      `INSERT INTO outbox (chain_id, notification_id, event_id, notification_type, payload)
       SELECT $1::bigint, t.notification_id, t.event_id, 'event_confirmed', t.payload::jsonb
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(notification_id, event_id, payload)
       ON CONFLICT (notification_id) DO NOTHING`,
      [
        input.chainId,
        notifications.map((n) => n.notificationId),
        notifications.map((n) => n.eventId),
        notifications.map((n) => JSON.stringify(n.payload)),
      ],
    );
    queued = res.rowCount ?? 0;
  }
  return { confirmed: rows.length, notificationsQueued: queued, eventIds: rows.map((r) => r.event_id) };
}
