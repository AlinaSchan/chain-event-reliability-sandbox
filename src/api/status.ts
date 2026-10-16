import { checkInvariants, type InvariantReport } from '../recovery/invariants.js';
import type { ApiContext } from './context.js';

export interface StatusResponse {
  chainId: number;
  /** The provider's current head. `error` is set instead when the provider cannot be reached. */
  fixtureChainHead: { number: number; hash: string } | { error: string };
  /** The durable scanner cursor in PostgreSQL. */
  checkpoint: {
    lastBlockNumber: number;
    lastBlockHash: string | null;
    scanStatus: 'ok' | 'degraded' | 'halted';
    statusDetail: Record<string, unknown> | null;
    version: number;
    updatedAt: string;
  } | null;
  /** Provider head minus checkpoint, when both are known. */
  lagBlocks: number | null;
  confirmationPolicy: { depth: number; basis: string; maxAutomaticReorgDepth: number };
  events: { canonical: number; provisional: number; confirmed: number; orphaned: number };
  outbox: { pending: number; published: number; processed: number; suppressed: number; oldestUnsettledAgeSeconds: number | null };
  worker: { scanner: unknown; pipeline: unknown; queue: { reachable: boolean; streamLength?: number; unacknowledged?: number; error?: string } | null };
  lastRecoveryAction: { kind: string; summary: string; fromBlock: number | null; toBlock: number | null; at: string } | null;
  openIncidents: { count: number; requireManualReview: number; latest: Array<{ id: number; kind: string; severity: string; summary: string; at: string }> };
  invariants?: InvariantReport;
}

export async function buildStatus(ctx: ApiContext, opts: { verify: boolean }): Promise<StatusResponse> {
  const { db, chainId } = ctx;

  const head = await ctx.provider
    .getHead()
    .then((h) => ({ number: h.number, hash: h.hash }))
    .catch((err: unknown) => ({ error: (err as Error).message }));

  const { rows: cpRows } = await db.query<{
    last_block_number: number;
    last_block_hash: string | null;
    scan_status: 'ok' | 'degraded' | 'halted';
    status_detail: Record<string, unknown> | null;
    version: number;
    updated_at: Date;
  }>('SELECT last_block_number, last_block_hash, scan_status, status_detail, version, updated_at FROM scanner_checkpoints WHERE chain_id = $1', [chainId]);
  const cp = cpRows[0];

  const { rows: eventRows } = await db.query<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM chain_events WHERE chain_id = $1 GROUP BY status',
    [chainId],
  );
  const e = new Map(eventRows.map((r) => [r.status, r.n]));
  const provisional = e.get('provisional') ?? 0;
  const confirmed = e.get('confirmed') ?? 0;

  const { rows: outboxRows } = await db.query<{ status: string; n: number; oldest: number | null }>(
    `SELECT status, count(*)::int AS n,
            extract(epoch FROM now() - min(created_at))::float8 AS oldest
       FROM outbox WHERE chain_id = $1 GROUP BY status`,
    [chainId],
  );
  const o = new Map(outboxRows.map((r) => [r.status, r]));
  const unsettledAges = ['pending', 'published'].map((s) => o.get(s)?.oldest).filter((v): v is number => typeof v === 'number');

  const { rows: recovery } = await db.query<{ kind: string; summary: string; from_block: number | null; to_block: number | null; created_at: Date }>(
    'SELECT kind, summary, from_block, to_block, created_at FROM recovery_log WHERE chain_id = $1 ORDER BY id DESC LIMIT 1',
    [chainId],
  );
  const { rows: incidentCount } = await db.query<{ n: number; manual: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE requires_manual_review)::int AS manual
       FROM incidents WHERE chain_id = $1 AND status = 'open'`,
    [chainId],
  );
  const { rows: incidents } = await db.query<{ id: number; kind: string; severity: string; summary: string; created_at: Date }>(
    `SELECT id, kind, severity, summary, created_at FROM incidents WHERE chain_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 5`,
    [chainId],
  );

  let queue: StatusResponse['worker']['queue'] = null;
  if (ctx.queue) {
    try {
      const [pending, length] = await Promise.all([ctx.queue.pending(), ctx.queue.length()]);
      queue = { reachable: true, streamLength: length, unacknowledged: pending.count };
    } catch (err) {
      queue = { reachable: false, error: (err as Error).message };
    }
  }

  const response: StatusResponse = {
    chainId,
    fixtureChainHead: head,
    checkpoint: cp
      ? {
          lastBlockNumber: cp.last_block_number,
          lastBlockHash: cp.last_block_hash,
          scanStatus: cp.scan_status,
          statusDetail: cp.status_detail,
          version: cp.version,
          updatedAt: cp.updated_at.toISOString(),
        }
      : null,
    lagBlocks: cp && 'number' in head ? head.number - cp.last_block_number : null,
    confirmationPolicy: {
      depth: ctx.confirmationDepth,
      basis: 'An event is confirmed when the durable checkpoint is at least `depth` blocks above its block. Measured from stored state, not from the provider head or the clock.',
      maxAutomaticReorgDepth: ctx.maxReorgDepth,
    },
    events: { canonical: provisional + confirmed, provisional, confirmed, orphaned: e.get('orphaned') ?? 0 },
    outbox: {
      pending: o.get('pending')?.n ?? 0,
      published: o.get('published')?.n ?? 0,
      processed: o.get('processed')?.n ?? 0,
      suppressed: o.get('suppressed')?.n ?? 0,
      oldestUnsettledAgeSeconds: unsettledAges.length > 0 ? Math.round(Math.max(...unsettledAges)) : null,
    },
    worker: { scanner: ctx.worker?.status() ?? null, pipeline: ctx.pipeline?.status() ?? null, queue },
    lastRecoveryAction: recovery[0]
      ? { kind: recovery[0].kind, summary: recovery[0].summary, fromBlock: recovery[0].from_block, toBlock: recovery[0].to_block, at: recovery[0].created_at.toISOString() }
      : null,
    openIncidents: {
      count: incidentCount[0]?.n ?? 0,
      requireManualReview: incidentCount[0]?.manual ?? 0,
      latest: incidents.map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, summary: i.summary, at: i.created_at.toISOString() })),
    },
  };
  if (opts.verify) {
    response.invariants = await checkInvariants(db, { chainId, confirmationDepth: ctx.confirmationDepth, watch: ctx.watch });
  }
  return response;
}
