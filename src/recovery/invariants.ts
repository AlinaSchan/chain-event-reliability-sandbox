import type { WatchIndex } from '../domain/watchlist.js';
import type { Queryable } from '../storage/db.js';

export interface InvariantCheck {
  id: string;
  description: string;
  violations: number;
}

export interface InvariantReport {
  ok: boolean;
  checkedAt: string;
  checks: InvariantCheck[];
}

interface Spec {
  id: string;
  description: string;
  sql: string;
  params: (ctx: Ctx) => unknown[];
}

interface Ctx {
  chainId: number;
  confirmationDepth: number;
  thresholdAddresses: string[];
  thresholdUnits: string[];
}

const SPECS: Spec[] = [
  {
    id: 'I1.checkpoint-is-canonical-tip',
    description: 'The checkpoint points at the canonical block at its height, and no canonical block exists above it.',
    params: (c) => [c.chainId],
    sql: `SELECT (
        (SELECT count(*) FROM scanner_checkpoints cp
          WHERE cp.chain_id = $1 AND cp.last_block_hash IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM chain_blocks b
                             WHERE b.chain_id = cp.chain_id AND b.canonical
                               AND b.block_number = cp.last_block_number AND b.block_hash = cp.last_block_hash))
      + (SELECT count(*) FROM chain_blocks b JOIN scanner_checkpoints cp ON cp.chain_id = b.chain_id
          WHERE b.chain_id = $1 AND b.canonical AND b.block_number > cp.last_block_number)
      )::int AS n`,
  },
  {
    id: 'I2.canonical-chain-linked-without-gaps',
    description: 'Every canonical block (after the first) has the canonical block at height-1 as its parent.',
    params: (c) => [c.chainId],
    sql: `SELECT count(*)::int AS n FROM chain_blocks b
           WHERE b.chain_id = $1 AND b.canonical
             AND b.block_number > (SELECT min(block_number) FROM chain_blocks WHERE chain_id = $1 AND canonical)
             AND NOT EXISTS (SELECT 1 FROM chain_blocks p
                              WHERE p.chain_id = b.chain_id AND p.canonical
                                AND p.block_number = b.block_number - 1 AND p.block_hash = b.parent_hash)`,
  },
  {
    id: 'I3.event-status-follows-block',
    description: 'Events in canonical blocks are provisional or confirmed; events in non-canonical blocks are orphaned.',
    params: (c) => [c.chainId],
    sql: `SELECT count(*)::int AS n FROM chain_events e
            JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_hash = e.block_hash
           WHERE e.chain_id = $1
             AND ((b.canonical AND e.status = 'orphaned') OR (NOT b.canonical AND e.status <> 'orphaned'))`,
  },
  {
    id: 'I4.no-confirmable-event-left-provisional',
    description: 'No canonical provisional event sits at or below checkpoint - confirmation depth.',
    params: (c) => [c.chainId, c.confirmationDepth],
    sql: `SELECT count(*)::int AS n FROM chain_events e
            JOIN scanner_checkpoints cp ON cp.chain_id = e.chain_id
            JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_hash = e.block_hash
           WHERE e.chain_id = $1 AND e.status = 'provisional' AND b.canonical
             AND e.block_number <= cp.last_block_number - $2::int`,
  },
  {
    id: 'I5.flows-equal-fold-over-non-orphaned-events',
    description: 'account_flows equals a recomputation from the non-orphaned ERC-20 events.',
    params: (c) => [c.chainId],
    sql: `WITH expected AS (
            SELECT e.contract_address AS token, x.account, sum(x.inbound) AS inbound, sum(x.outbound) AS outbound
              FROM chain_events e,
                   LATERAL (VALUES (e.decoded->>'from', 0::numeric, e.amount),
                                   (e.decoded->>'to', e.amount, 0::numeric)) AS x(account, inbound, outbound)
             WHERE e.chain_id = $1 AND e.kind = 'erc20_transfer' AND e.status <> 'orphaned'
             GROUP BY 1, 2
          )
          SELECT count(*)::int AS n
            FROM expected ex
            FULL OUTER JOIN (SELECT token_address, account, inbound, outbound FROM account_flows WHERE chain_id = $1) f
              ON f.token_address = ex.token AND f.account = ex.account
           WHERE coalesce(ex.inbound, 0) <> coalesce(f.inbound, 0) OR coalesce(ex.outbound, 0) <> coalesce(f.outbound, 0)`,
  },
  {
    id: 'I6.alerts-follow-events',
    description: 'Open alerts exist exactly for non-orphaned events; high-value non-orphaned events all have an open alert.',
    params: (c) => [c.chainId, c.thresholdAddresses, c.thresholdUnits],
    sql: `SELECT (
        (SELECT count(*) FROM alerts a JOIN chain_events e ON e.event_id = a.event_id
          WHERE a.chain_id = $1 AND ((a.status = 'open' AND e.status = 'orphaned') OR (a.status = 'withdrawn' AND e.status <> 'orphaned')))
      + (SELECT count(*) FROM chain_events e
           JOIN unnest($2::text[], $3::numeric[]) AS t(address, threshold) ON t.address = e.contract_address
          WHERE e.chain_id = $1 AND e.status <> 'orphaned' AND e.amount >= t.threshold
            AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.event_id = e.event_id AND a.status = 'open'))
      )::int AS n`,
  },
  {
    id: 'I7.no-notification-queued-before-confirmation',
    description: 'No confirmation notification exists for an event that never reached confirmed.',
    params: (c) => [c.chainId],
    sql: `SELECT count(*)::int AS n FROM outbox o JOIN chain_events e ON e.event_id = o.event_id
           WHERE o.chain_id = $1 AND o.notification_type = 'event_confirmed' AND e.confirm_count < 1`,
  },
  {
    id: 'I8.sink-matches-outbox',
    description: 'Every processed outbox row has exactly one sink delivery, and every sink delivery belongs to a processed row.',
    params: (c) => [c.chainId],
    sql: `SELECT (
        (SELECT count(*) FROM outbox o
          WHERE o.chain_id = $1 AND o.status = 'processed'
            AND NOT EXISTS (SELECT 1 FROM notification_sink s WHERE s.notification_id = o.notification_id))
      + (SELECT count(*) FROM notification_sink s JOIN outbox o ON o.notification_id = s.notification_id
          WHERE s.chain_id = $1 AND o.status <> 'processed')
      )::int AS n`,
  },
  {
    id: 'I9.audit-trail-ends-in-current-status',
    description: "Each event's latest audit row ends in the status the event currently has.",
    params: (c) => [c.chainId],
    sql: `SELECT count(*)::int AS n FROM chain_events e
           WHERE e.chain_id = $1
             AND (SELECT a.to_state FROM event_audit a WHERE a.event_id = e.event_id ORDER BY a.id DESC LIMIT 1)
                 IS DISTINCT FROM e.status`,
  },
  {
    id: 'I10.delivered-then-orphaned-has-retraction',
    description: 'A confirmation that was delivered for an event that is now orphaned has a retraction queued.',
    params: (c) => [c.chainId],
    sql: `SELECT count(*)::int AS n FROM notification_sink s JOIN chain_events e ON e.event_id = s.event_id
           WHERE s.chain_id = $1 AND s.notification_type = 'event_confirmed' AND e.status = 'orphaned'
             AND NOT EXISTS (SELECT 1 FROM outbox r WHERE r.event_id = s.event_id AND r.notification_type = 'event_retracted')`,
  },
  {
    id: 'I11.halt-has-open-incident',
    description: 'A halted scanner always has an open incident explaining why.',
    params: (c) => [c.chainId],
    sql: `SELECT count(*)::int AS n FROM scanner_checkpoints cp
           WHERE cp.chain_id = $1 AND cp.scan_status = 'halted'
             AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.chain_id = cp.chain_id AND i.kind = 'scanner_halted' AND i.status = 'open')`,
  },
];

/** The ids of every stored-state invariant, for documentation checks. */
export const INVARIANT_IDS: readonly string[] = SPECS.map((s) => s.id);

/**
 * Re-derives what the stored state must satisfy from the stored state itself, and reports every
 * violation. It reads only PostgreSQL. Tests run it after every scenario; GET /status can run it on demand.
 */
export async function checkInvariants(
  db: Queryable,
  opts: { chainId: number; confirmationDepth: number; watch: WatchIndex },
): Promise<InvariantReport> {
  const ctx: Ctx = {
    chainId: opts.chainId,
    confirmationDepth: opts.confirmationDepth,
    thresholdAddresses: opts.watch.entries.map((w) => w.address),
    thresholdUnits: opts.watch.entries.map((w) => w.thresholdUnits.toString()),
  };
  const checks: InvariantCheck[] = [];
  for (const spec of SPECS) {
    const { rows } = await db.query<{ n: number }>(spec.sql, spec.params(ctx));
    checks.push({ id: spec.id, description: spec.description, violations: Number(rows[0]?.n ?? 0) });
  }
  return { ok: checks.every((c) => c.violations === 0), checkedAt: new Date().toISOString(), checks };
}
