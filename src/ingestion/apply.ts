import { confirmEligible } from '../confirmation/confirm.js';
import { argsToJson, type DecodedEvent, type Erc20TransferArgs } from '../domain/abi.js';
import { LinkageError, ReplayMismatchError, ScannerHaltedError } from '../domain/errors.js';
import type { EventKind, EventStatus, HeadRef, Hex, ScanTrigger } from '../domain/types.js';
import { isHighValue } from '../domain/units.js';
import type { WatchIndex } from '../domain/watchlist.js';
import type { CrashPoints } from '../observability/failpoints.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { orphanCanonicalAbove, type OrphanSummary } from '../recovery/reorg.js';
import { insertAudit, openIncident, recordRecovery, type AuditRow } from '../storage/audit.js';
import { advanceCheckpoint, lockCheckpoint, StaleCheckpointError, type Checkpoint } from '../storage/checkpoint.js';
import type { Db, Tx } from '../storage/db.js';
import type { PreparedBlock } from './prepare.js';
import { addFlows, FlowDeltas } from './projection.js';

/**
 * forward: append blocks after the checkpoint.
 * reorg:   orphan everything above a common ancestor, then append the replacement branch.
 * replay:  re-apply blocks inside the already-processed range; inserts what is missing, changes nothing else.
 */
export type ApplyMode = 'forward' | 'reorg' | 'replay';

export interface ApplyInput {
  chainId: number;
  mode: ApplyMode;
  trigger: ScanTrigger;
  /** forward / reorg: the checkpoint version this batch was computed from. Ignored for replay. */
  expectedVersion: number | null;
  blocks: PreparedBlock[];
  reorg?: { ancestor: HeadRef; oldTip: HeadRef; reason: string };
  confirmationDepth: number;
  watch: WatchIndex;
}

export interface ApplyDeps {
  db: Db;
  logger: Logger;
  metrics: Metrics;
  crash?: CrashPoints;
}

export interface ApplyResult {
  tip: { number: number; hash: Hex | null };
  version: number;
  blocksInserted: number;
  blocksReactivated: number;
  eventsInserted: number;
  eventsReactivated: number;
  eventsDuplicate: number;
  payloadMismatches: number;
  alertsOpened: number;
  quarantined: number;
  confirmed: number;
  notificationsQueued: number;
  reorg: OrphanSummary | null;
}

/**
 * The single write path for chain data. One PostgreSQL transaction does all of this or none of it:
 *
 *   1. take the per-chain checkpoint row lock and check the fencing version (single writer)
 *   2. reorg only: orphan the abandoned branch and correct derived state
 *   3. insert blocks, then events (idempotent on event identity), then derived state and audit rows
 *   4. advance the checkpoint to the new tip
 *   5. confirm events that are now deep enough
 *
 * The checkpoint moves in step 4, in the same transaction as the data it describes. A crash anywhere
 * before COMMIT leaves the previous checkpoint and none of the new rows.
 */
export async function applyBatch(deps: ApplyDeps, input: ApplyInput): Promise<ApplyResult> {
  const { db, logger, metrics, crash } = deps;

  const result = await db.tx(async (tx): Promise<ApplyResult> => {
    const cp = await lockCheckpoint(tx, input.chainId);
    if (cp.scanStatus === 'halted') throw new ScannerHaltedError(`chain ${input.chainId} is halted; refusing to write`);
    if (input.mode !== 'replay' && cp.version !== input.expectedVersion) {
      throw new StaleCheckpointError(input.expectedVersion ?? -1, cp.version);
    }
    await verifyAttachment(tx, cp, input);

    let orphan: OrphanSummary | null = null;
    if (input.mode === 'reorg' && input.reorg) {
      orphan = await orphanCanonicalAbove(tx, {
        chainId: input.chainId,
        ancestor: input.reorg.ancestor,
        reason: input.reorg.reason,
        watch: input.watch,
      });
    }
    if (input.mode === 'replay') await verifyReplayBlocks(tx, input);

    const blockStats = await insertBlocks(tx, input);
    const eventStats = await insertEvents(tx, input);
    const quarantined = await quarantineLogs(tx, input);

    // A crash here is a crash before COMMIT: the whole transaction rolls back, checkpoint included.
    crash?.hit('scanner.before_commit');

    const lastBlock = input.blocks[input.blocks.length - 1];
    let tip: { number: number; hash: Hex | null } = { number: cp.lastBlockNumber, hash: cp.lastBlockHash };
    let version = cp.version;
    if (input.mode !== 'replay') {
      tip = lastBlock
        ? { number: lastBlock.header.number, hash: lastBlock.header.hash }
        : { number: input.reorg?.ancestor.number ?? cp.lastBlockNumber, hash: input.reorg?.ancestor.hash ?? cp.lastBlockHash };
      await advanceCheckpoint(tx, input.chainId, tip.number, tip.hash);
      version += 1;
    }

    const confirm = await confirmEligible(tx, {
      chainId: input.chainId,
      checkpointNumber: tip.number,
      depth: input.confirmationDepth,
      watch: input.watch,
    });

    if (input.mode === 'reorg' && input.reorg) {
      const depth = input.reorg.oldTip.number - input.reorg.ancestor.number;
      await recordRecovery(tx, input.chainId, {
        kind: 'reorg',
        fromBlock: input.reorg.ancestor.number + 1,
        toBlock: input.reorg.oldTip.number,
        summary:
          `reorganization of depth ${depth} corrected: ${orphan?.blocks.length ?? 0} block(s) and ${orphan?.events ?? 0} event(s) orphaned, ` +
          `${eventStats.inserted + eventStats.reactivated} event(s) taken from the replacement branch`,
        details: {
          commonAncestor: input.reorg.ancestor,
          oldTip: input.reorg.oldTip,
          newTip: tip,
          depth,
          orphanedBlocks: orphan?.blocks ?? [],
          orphanedEvents: orphan?.events ?? 0,
          orphanedFromConfirmed: orphan?.fromConfirmed ?? 0,
          alertsWithdrawn: orphan?.alertsWithdrawn ?? 0,
          outboxSuppressed: orphan?.outboxSuppressed ?? 0,
          retractionsQueued: orphan?.retractionsQueued ?? 0,
          incidentId: orphan?.incidentId ?? null,
          replacementBlocks: input.blocks.map((b) => ({ number: b.header.number, hash: b.header.hash })),
        },
      });
    }

    return {
      tip,
      version,
      blocksInserted: blockStats.inserted,
      blocksReactivated: blockStats.reactivated,
      eventsInserted: eventStats.inserted,
      eventsReactivated: eventStats.reactivated,
      eventsDuplicate: eventStats.duplicates,
      payloadMismatches: eventStats.payloadMismatches,
      alertsOpened: eventStats.alertsOpened,
      quarantined,
      confirmed: confirm.confirmed,
      notificationsQueued: confirm.notificationsQueued,
      reorg: orphan,
    };
  });

  // Committed. A crash from here on loses nothing: the data and the checkpoint are already durable.
  crash?.hit('scanner.after_commit');

  metrics.inc('blocks_ingested_total', result.blocksInserted + result.blocksReactivated);
  metrics.inc('events_inserted_total', result.eventsInserted);
  metrics.inc('events_reactivated_total', result.eventsReactivated);
  metrics.inc('events_duplicate_total', result.eventsDuplicate);
  metrics.inc('events_confirmed_total', result.confirmed);
  if (result.reorg) {
    metrics.inc('reorgs_applied_total');
    metrics.inc('events_orphaned_total', result.reorg.events);
  }
  if (input.mode === 'reorg' && input.reorg) {
    logger.warn(
      {
        event: 'reorg.applied',
        chainId: input.chainId,
        commonAncestor: input.reorg.ancestor,
        oldTip: input.reorg.oldTip,
        newTip: result.tip,
        orphanedBlocks: result.reorg?.blocks.length ?? 0,
        orphanedEvents: result.reorg?.events ?? 0,
        orphanedFromConfirmed: result.reorg?.fromConfirmed ?? 0,
        replacementEvents: result.eventsInserted + result.eventsReactivated,
      },
      'reorganization corrected',
    );
  } else {
    logger.info(
      {
        event: input.mode === 'replay' ? 'replay.applied' : 'checkpoint.advanced',
        chainId: input.chainId,
        mode: input.mode,
        trigger: input.trigger,
        tip: result.tip,
        blocks: input.blocks.length,
        eventsInserted: result.eventsInserted,
        eventsDuplicate: result.eventsDuplicate,
        eventsReactivated: result.eventsReactivated,
        confirmed: result.confirmed,
      },
      input.mode === 'replay' ? 'range replayed' : 'checkpoint advanced',
    );
  }
  return result;
}

// ---- Guards ----------------------------------------------------------------------------------------

async function verifyAttachment(tx: Tx, cp: Checkpoint, input: ApplyInput): Promise<void> {
  const first = input.blocks[0];
  if (input.mode === 'forward') {
    if (!first) throw new LinkageError('forward batch without blocks');
    if (first.header.number !== cp.lastBlockNumber + 1) {
      throw new LinkageError(`batch starts at ${first.header.number}, checkpoint is at ${cp.lastBlockNumber}`);
    }
    if (cp.lastBlockHash !== null && first.header.parentHash !== cp.lastBlockHash) {
      throw new LinkageError(`block ${first.header.number} does not attach to checkpoint block ${cp.lastBlockHash}`);
    }
  } else if (input.mode === 'reorg') {
    const { ancestor } = input.reorg ?? {};
    if (!ancestor) throw new LinkageError('reorg batch without a common ancestor');
    const { rows } = await tx.query(
      'SELECT 1 FROM chain_blocks WHERE chain_id = $1 AND canonical AND block_number = $2 AND block_hash = $3',
      [input.chainId, ancestor.number, ancestor.hash],
    );
    if (rows.length === 0) throw new LinkageError(`common ancestor ${ancestor.hash} is not in the stored canonical chain`);
    if (first && (first.header.number !== ancestor.number + 1 || first.header.parentHash !== ancestor.hash)) {
      throw new LinkageError(`replacement block ${first.header.number} does not attach to common ancestor ${ancestor.number}`);
    }
  }
}

async function verifyReplayBlocks(tx: Tx, input: ApplyInput): Promise<void> {
  const numbers = input.blocks.map((b) => b.header.number);
  const { rows } = await tx.query<{ block_number: number; block_hash: Hex }>(
    'SELECT block_number, block_hash FROM chain_blocks WHERE chain_id = $1 AND canonical AND block_number = ANY($2::bigint[])',
    [input.chainId, numbers],
  );
  const stored = new Map(rows.map((r) => [r.block_number, r.block_hash]));
  for (const block of input.blocks) {
    const hash = stored.get(block.header.number);
    if (hash !== undefined && hash !== block.header.hash) {
      throw new ReplayMismatchError(
        `block ${block.header.number}: provider says ${block.header.hash}, stored canonical block is ${hash}; run a normal scan to handle the reorganization first`,
      );
    }
  }
}

// ---- Blocks ----------------------------------------------------------------------------------------

async function insertBlocks(tx: Tx, input: ApplyInput): Promise<{ inserted: number; reactivated: number }> {
  if (input.blocks.length === 0) return { inserted: 0, reactivated: 0 };
  const headers = input.blocks.map((b) => b.header);
  const { rows } = await tx.query<{ inserted: boolean }>(
    `INSERT INTO chain_blocks (chain_id, block_hash, block_number, parent_hash, block_timestamp, tx_count)
     SELECT $1::bigint, t.hash, t.number, t.parent, to_timestamp(t.ts), t.tx_count
       FROM unnest($2::text[], $3::bigint[], $4::text[], $5::double precision[], $6::int[])
            AS t(hash, number, parent, ts, tx_count)
     ON CONFLICT (chain_id, block_hash) DO UPDATE
        SET canonical = true, orphaned_at = NULL, orphan_reason = NULL
      WHERE chain_blocks.canonical = false
     RETURNING (xmax = 0) AS inserted`,
    [
      input.chainId,
      headers.map((h) => h.hash),
      headers.map((h) => h.number),
      headers.map((h) => h.parentHash),
      headers.map((h) => h.timestamp),
      headers.map((h) => h.transactionHashes.length),
    ],
  );
  const inserted = rows.filter((r) => r.inserted).length;
  return { inserted, reactivated: rows.length - inserted };
}

// ---- Events ----------------------------------------------------------------------------------------

interface EventRow {
  event_id: string;
  kind: EventKind;
  contract_address: Hex;
  amount: string;
  decoded: Record<string, string | number>;
  inserted: boolean;
}

interface EventStats {
  inserted: number;
  reactivated: number;
  duplicates: number;
  payloadMismatches: number;
  alertsOpened: number;
}

async function insertEvents(tx: Tx, input: ApplyInput): Promise<EventStats> {
  const stats: EventStats = { inserted: 0, reactivated: 0, duplicates: 0, payloadMismatches: 0, alertsOpened: 0 };
  const events: DecodedEvent[] = input.blocks.flatMap((b) => b.events);
  if (events.length === 0) return stats;

  const copies = new Map<string, number>();
  for (const block of input.blocks) for (const [id, n] of block.copies) copies.set(id, n);

  const { rows } = await tx.query<EventRow>(
    `INSERT INTO chain_events (event_id, chain_id, block_hash, transaction_hash, log_index, block_number,
                               contract_address, kind, decoded, amount, payload_hash, status, status_reason)
     SELECT t.event_id, $1::bigint, t.block_hash, t.transaction_hash, t.log_index, t.block_number,
            t.contract_address, t.kind, t.decoded::jsonb, t.amount::numeric, t.payload_hash, 'provisional', $2::text
       FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::bigint[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
            AS t(event_id, block_hash, transaction_hash, log_index, block_number, contract_address, kind, decoded, amount, payload_hash)
     ON CONFLICT (event_id) DO UPDATE
        SET status = 'provisional', status_reason = $13::text, status_changed_at = now(),
            last_seen_at = now(), seen_count = chain_events.seen_count + 1
      WHERE chain_events.status = 'orphaned'
     RETURNING event_id, kind, contract_address, amount::text AS amount, decoded, (xmax = 0) AS inserted`,
    [
      input.chainId,
      'ingested: block linked to the canonical chain at the checkpoint',
      events.map((e) => e.eventId),
      events.map((e) => e.blockHash),
      events.map((e) => e.transactionHash),
      events.map((e) => e.logIndex),
      events.map((e) => e.blockNumber),
      events.map((e) => e.contract),
      events.map((e) => e.kind),
      events.map((e) => JSON.stringify(argsToJson(e))),
      events.map((e) => e.amount.toString()),
      events.map((e) => e.payloadHash),
      'reactivated: block returned to the canonical chain',
    ],
  );

  const touched = new Map(rows.map((r) => [r.event_id, r]));
  const byId = new Map(events.map((e) => [e.eventId, e]));
  stats.inserted = rows.filter((r) => r.inserted).length;
  stats.reactivated = rows.length - stats.inserted;

  // Derived state and alerts follow exactly the rows this statement changed - never the input.
  const deltas = new FlowDeltas();
  const alerts: Array<{ alertId: string; eventId: string; contract: Hex; amount: string; threshold: string; reason: string }> = [];
  for (const row of rows) {
    const event = byId.get(row.event_id);
    if (!event) continue;
    if (event.kind === 'erc20_transfer') {
      const args = event.args as Erc20TransferArgs;
      deltas.addTransfer(event.contract, args.from, args.to, event.amount);
    }
    const watch = input.watch.byAddress.get(event.contract);
    if (watch && isHighValue(event.amount, watch.thresholdUnits)) {
      alerts.push({
        alertId: `hv:${row.event_id}`,
        eventId: row.event_id,
        contract: event.contract,
        amount: event.amount.toString(),
        threshold: watch.thresholdUnits.toString(),
        reason: row.inserted ? 'amount at or above the high-value threshold when first ingested' : 'event returned to the canonical chain',
      });
    }
  }
  await addFlows(tx, input.chainId, deltas);
  if (alerts.length > 0) {
    await tx.query(
      `INSERT INTO alerts (alert_id, chain_id, event_id, rule, contract_address, amount, threshold_units, status, status_reason)
       SELECT t.alert_id, $1::bigint, t.event_id, 'high_value', t.contract, t.amount::numeric, t.threshold::numeric, 'open', t.reason
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS t(alert_id, event_id, contract, amount, threshold, reason)
       ON CONFLICT (event_id) DO UPDATE
          SET status = 'open', status_reason = EXCLUDED.status_reason, updated_at = now()
        WHERE alerts.status = 'withdrawn'`,
      [
        input.chainId,
        alerts.map((a) => a.alertId),
        alerts.map((a) => a.eventId),
        alerts.map((a) => a.contract),
        alerts.map((a) => a.amount),
        alerts.map((a) => a.threshold),
        alerts.map((a) => a.reason),
      ],
    );
    stats.alertsOpened = alerts.length;
  }

  const audit: AuditRow[] = [];
  for (const row of rows) {
    const event = byId.get(row.event_id);
    if (!event) continue;
    audit.push(
      row.inserted
        ? {
            eventId: row.event_id,
            action: 'ingested',
            from: 'observed',
            to: 'provisional',
            reason: `first sighting in block ${event.blockNumber} (${input.mode}, trigger ${input.trigger})`,
            details: { blockNumber: event.blockNumber, blockHash: event.blockHash, mode: input.mode },
          }
        : {
            eventId: row.event_id,
            action: 'reactivated',
            from: 'orphaned',
            to: 'provisional',
            reason: `block ${event.blockNumber} returned to the canonical chain`,
            details: { blockNumber: event.blockNumber, blockHash: event.blockHash, mode: input.mode },
          },
    );
  }

  // Sightings that changed nothing: already stored, or delivered more than once in this response.
  const extra: Array<{ id: string; n: number }> = [];
  for (const event of events) {
    const n = (copies.get(event.eventId) ?? 1) - 1 + (touched.has(event.eventId) ? 0 : 1);
    if (n > 0) extra.push({ id: event.eventId, n });
  }
  if (extra.length > 0) {
    const { rows: seen } = await tx.query<{ event_id: string; payload_hash: Hex; status: EventStatus }>(
      `UPDATE chain_events e
          SET seen_count = e.seen_count + x.extra, last_seen_at = now()
         FROM unnest($1::text[], $2::int[]) AS x(id, extra)
        WHERE e.event_id = x.id
        RETURNING e.event_id, e.payload_hash, e.status`,
      [extra.map((x) => x.id), extra.map((x) => x.n)],
    );
    const extraById = new Map(extra.map((x) => [x.id, x.n]));
    for (const row of seen) {
      const event = byId.get(row.event_id);
      if (!event) continue;
      stats.duplicates += extraById.get(row.event_id) ?? 0;
      audit.push({
        eventId: row.event_id,
        action: 'duplicate_sighting',
        from: row.status,
        to: row.status,
        reason: `delivered ${extraById.get(row.event_id) ?? 0} more time(s); identity already stored, no new effect`,
        details: { mode: input.mode, trigger: input.trigger },
      });
      if (row.payload_hash !== event.payloadHash) {
        stats.payloadMismatches += 1;
        audit.push({
          eventId: row.event_id,
          action: 'payload_mismatch',
          from: row.status,
          to: row.status,
          reason: 'a different payload arrived under an identity that is already stored; the stored row was kept',
          details: { storedPayloadHash: row.payload_hash, incomingPayloadHash: event.payloadHash },
        });
        await openIncident(tx, input.chainId, {
          kind: 'payload_mismatch',
          severity: 'critical',
          requiresManualReview: true,
          summary: `event ${row.event_id} was delivered with a different payload than the one stored`,
          details: { eventId: row.event_id, storedPayloadHash: row.payload_hash, incomingPayloadHash: event.payloadHash },
        });
      }
    }
  }

  await insertAudit(tx, input.chainId, audit);
  return stats;
}

async function quarantineLogs(tx: Tx, input: ApplyInput): Promise<number> {
  const rows = input.blocks.flatMap((b) => b.quarantined);
  if (rows.length === 0) return 0;
  const { rows: created } = await tx.query<{ transaction_hash: Hex; log_index: number; reason: string; contract_address: Hex }>(
    `INSERT INTO quarantined_logs (chain_id, block_hash, transaction_hash, log_index, block_number, contract_address, reason, raw)
     SELECT $1::bigint, t.block_hash, t.transaction_hash, t.log_index, t.block_number, t.contract_address, t.reason, t.raw::jsonb
       FROM unnest($2::text[], $3::text[], $4::int[], $5::bigint[], $6::text[], $7::text[], $8::text[])
            AS t(block_hash, transaction_hash, log_index, block_number, contract_address, reason, raw)
     ON CONFLICT (chain_id, block_hash, transaction_hash, log_index) DO NOTHING
     RETURNING transaction_hash, log_index, reason, contract_address`,
    [
      input.chainId,
      rows.map((q) => q.log.blockHash.toLowerCase()),
      rows.map((q) => q.log.transactionHash.toLowerCase()),
      rows.map((q) => q.log.logIndex),
      rows.map((q) => q.log.blockNumber),
      rows.map((q) => q.log.address.toLowerCase()),
      rows.map((q) => q.reason),
      rows.map((q) => JSON.stringify({ topics: q.log.topics, data: q.log.data })),
    ],
  );
  for (const row of created) {
    await openIncident(tx, input.chainId, {
      kind: 'undecodable_log',
      severity: 'warning',
      requiresManualReview: true,
      summary: `log ${row.transaction_hash}#${row.log_index} from watched contract ${row.contract_address} looks like a tracked event but does not decode`,
      details: { reason: row.reason },
    });
  }
  return created.length;
}
