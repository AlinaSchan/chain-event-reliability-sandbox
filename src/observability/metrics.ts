/**
 * Process-local counters for things this process actually did. There is deliberately no uptime and no
 * throughput figure: the sandbox does not measure performance and does not claim any.
 */
export type CounterName =
  | 'rpc_retries_total'
  | 'rpc_exhausted_total'
  | 'scan_cycles_total'
  | 'blocks_ingested_total'
  | 'events_inserted_total'
  | 'events_duplicate_total'
  | 'events_reactivated_total'
  | 'events_confirmed_total'
  | 'events_orphaned_total'
  | 'reorgs_applied_total'
  | 'backfills_total'
  | 'stale_writer_aborts_total'
  | 'scanner_halts_total'
  | 'outbox_published_total'
  | 'outbox_publish_failures_total'
  | 'outbox_requeued_total'
  | 'consumer_delivered_total'
  | 'consumer_duplicates_total'
  | 'consumer_suppressed_total'
  | 'consumer_errors_total';

export const COUNTER_HELP: Record<CounterName, string> = {
  rpc_retries_total: 'RPC calls retried after a transient error',
  rpc_exhausted_total: 'RPC operations that ran out of retries',
  scan_cycles_total: 'Scan cycles started',
  blocks_ingested_total: 'Blocks committed to the canonical chain',
  events_inserted_total: 'New events persisted',
  events_duplicate_total: 'Repeat sightings of an event that was already stored',
  events_reactivated_total: 'Orphaned events restored because their block became canonical again',
  events_confirmed_total: 'Events that reached the confirmation depth',
  events_orphaned_total: 'Events orphaned by a reorganization',
  reorgs_applied_total: 'Reorganizations detected and corrected',
  backfills_total: 'Scan cycles that had to ingest more than one block',
  stale_writer_aborts_total: 'Commits abandoned because another writer moved the checkpoint first',
  scanner_halts_total: 'Times the scanner halted and asked for manual intervention',
  outbox_published_total: 'Outbox rows published to Redis',
  outbox_publish_failures_total: 'Outbox publish attempts that failed',
  outbox_requeued_total: 'Published outbox rows put back to pending because no effect was recorded',
  consumer_delivered_total: 'Notifications delivered to the sink',
  consumer_duplicates_total: 'Messages received for a notification that was already settled',
  consumer_suppressed_total: 'Notifications deliberately not delivered',
  consumer_errors_total: 'Message handling attempts that failed and were left unacknowledged',
};

export class Metrics {
  private readonly counters = new Map<CounterName, number>();

  inc(name: CounterName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  get(name: CounterName): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): Record<CounterName, number> {
    const out = {} as Record<CounterName, number>;
    for (const name of Object.keys(COUNTER_HELP) as CounterName[]) out[name] = this.get(name);
    return out;
  }
}
