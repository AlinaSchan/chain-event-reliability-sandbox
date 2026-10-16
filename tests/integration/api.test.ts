import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiContext } from '../../src/api/context.js';
import { buildServer } from '../../src/api/server.js';
import { silentLogger } from '../../src/observability/logger.js';
import { Db } from '../../src/storage/db.js';
import { block, minePlan, settlement, transfer, tx } from '../../scenarios/builders.js';
import { Sandbox } from '../../scenarios/harness.js';
import { SCENARIOS, persistResult, runScenario, toCatalog } from '../../scenarios/index.js';

/** Same history as the reorg tests: confirmation depth 3, head 14. */
const HISTORY = {
  4: block(tx(transfer('USDX', 'alice', 'bob', '20000'))),
  9: block(tx(transfer('USDX', 'bob', 'carol', '15000'))),
  11: block(tx(transfer('WRAPX', 'alice', 'bob', '6'))),
  12: block(tx(transfer('USDX', 'carol', 'dave', '12000'), 'D')),
  13: block(tx(transfer('GOLDX', 'alice', 'dave', '150'))),
  14: block(tx(transfer('USDX', 'dave', 'erin', '100'))),
};

function contextFor(sb: Sandbox, over: Partial<ApiContext> = {}): ApiContext {
  return {
    db: sb.db,
    chainId: sb.chainId,
    confirmationDepth: 3,
    maxReorgDepth: 10,
    watch: sb.watch,
    logger: silentLogger(),
    metrics: sb.metrics,
    provider: sb.provider,
    worker: null,
    pipeline: null,
    queue: null,
    scenarios: SCENARIOS.map(toCatalog),
    host: '127.0.0.1',
    admin: { enabled: false, token: null, controls: null },
    ...over,
  };
}

describe('read API', () => {
  let sb: Sandbox;
  let app: FastifyInstance;
  beforeAll(async () => {
    sb = await Sandbox.create({ confirmationDepth: 3, batchSize: 5 });
    minePlan(sb.chain, HISTORY, 14);
    await sb.scanner.scanOnce('startup');
    app = await buildServer(contextFor(sb));
  });
  afterAll(async () => {
    await app.close();
    await sb.destroy();
  });

  const get = async (url: string) => app.inject({ method: 'GET', url });
  const json = async <T = Record<string, unknown>>(url: string): Promise<T> => (await get(url)).json<T>();

  describe('GET /healthz', () => {
    it('reports ok with the queue disabled', async () => {
      const res = await get('/healthz');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', postgres: 'up', redis: 'disabled' });
    });

    it('returns 503 when PostgreSQL cannot be reached', async () => {
      const broken = new Db({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', max: 1 });
      const down = await buildServer(contextFor(sb, { db: broken }));
      try {
        const res = await down.inject({ method: 'GET', url: '/healthz' });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ status: 'down', postgres: 'down' });
      } finally {
        await down.close();
        await broken.close();
      }
    });

    it('reports a degraded queue without failing the process', async () => {
      const queue = sb.memoryQueue();
      queue.down = true;
      const degraded = await buildServer(contextFor(sb, { queue }));
      try {
        const res = await degraded.inject({ method: 'GET', url: '/healthz' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'degraded', postgres: 'up', redis: 'down' });
      } finally {
        await degraded.close();
      }
    });
  });

  describe('GET /status', () => {
    it('shows head, durable checkpoint, policy, counts and outbox', async () => {
      const status = await json<{
        chainId: number;
        fixtureChainHead: { number: number; hash: string };
        checkpoint: { lastBlockNumber: number; lastBlockHash: string; scanStatus: string };
        lagBlocks: number;
        confirmationPolicy: { depth: number; maxAutomaticReorgDepth: number };
        events: Record<string, number>;
        outbox: Record<string, number | null>;
        lastRecoveryAction: unknown;
        openIncidents: { count: number };
        invariants?: unknown;
      }>('/status');
      expect(status.chainId).toBe(31337);
      expect(status.fixtureChainHead).toEqual({ number: 14, hash: sb.chain.head.hash });
      expect(status.checkpoint).toMatchObject({ lastBlockNumber: 14, lastBlockHash: sb.chain.head.hash, scanStatus: 'ok' });
      expect(status.lagBlocks).toBe(0);
      expect(status.confirmationPolicy).toMatchObject({ depth: 3, maxAutomaticReorgDepth: 10 });
      expect(status.events).toEqual({ canonical: 6, provisional: 3, confirmed: 3, orphaned: 0 });
      expect(status.outbox).toMatchObject({ pending: 3, published: 0, processed: 0, suppressed: 0 });
      expect(status.outbox.oldestUnsettledAgeSeconds).toBeGreaterThanOrEqual(0);
      expect(status.openIncidents.count).toBe(0);
      expect(status.invariants).toBeUndefined();
    });

    it('re-derives the stored-state invariants on request', async () => {
      const status = await json<{ invariants: { ok: boolean; checks: Array<{ id: string; violations: number }> } }>('/status?verify=true');
      expect(status.invariants.ok).toBe(true);
      expect(status.invariants.checks.length).toBeGreaterThanOrEqual(10);
    });

    it('rejects unknown query parameters instead of ignoring them', async () => {
      expect((await get('/status?verfy=true')).statusCode).toBe(400);
    });
  });

  describe('GET /events and /alerts', () => {
    it('lists events newest first with exact amounts, and filters', async () => {
      const all = await json<{ items: Array<{ blockNumber: number; status: string; amountUnits: string; amount: string; symbol: string }>; nextCursor: string | null }>('/events');
      expect(all.items.map((e) => e.blockNumber)).toEqual([14, 13, 12, 11, 9, 4]);
      const usdx = all.items.find((e) => e.blockNumber === 4);
      expect(usdx).toMatchObject({ symbol: 'USDX', amountUnits: '20000000000', amount: '20000', status: 'confirmed' });
      expect(all.nextCursor).toBeNull();

      const confirmed = await json<{ items: unknown[] }>('/events?status=confirmed');
      expect(confirmed.items).toHaveLength(3);
      const erc20 = await json<{ items: unknown[] }>('/events?kind=erc20_transfer&fromBlock=9&toBlock=12');
      expect(erc20.items).toHaveLength(3);
    });

    it('paginates by keyset without gaps or repeats', async () => {
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res: { items: Array<{ blockNumber: number }>; nextCursor: string | null } = await json(`/events?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...res.items.map((e) => e.blockNumber));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([14, 13, 12, 11, 9, 4]);
    });

    it('validates requests', async () => {
      expect((await get('/events?limit=0')).statusCode).toBe(400);
      expect((await get('/events?limit=501')).statusCode).toBe(400);
      expect((await get('/events?status=nope')).statusCode).toBe(400);
      expect((await get('/events?cursor=%%%')).statusCode).toBe(400);
      expect((await get(`/events?cursor=${Buffer.from('{"not":"a key"}').toString('base64url')}`)).statusCode).toBe(400);
      expect((await get('/events/not-an-id')).statusCode).toBe(400);
      expect((await get(`/events/31337:0x${'ab'.repeat(32)}:0x${'cd'.repeat(32)}:0`)).statusCode).toBe(404);
    });

    it('serves one event with its audit trail, notification and block', async () => {
      const { items } = await json<{ items: Array<{ eventId: string; blockNumber: number }> }>('/events?kind=erc20_transfer&fromBlock=4&toBlock=4');
      const id = items[0]!.eventId;
      const event = await json<{
        status: string;
        audit: Array<{ action: string; from: string; to: string }>;
        notifications: Array<{ type: string; status: string }>;
        block: { canonical: boolean; number: number };
        alertStatus: string;
      }>(`/events/${encodeURIComponent(id)}`);
      expect(event.status).toBe('confirmed');
      expect(event.audit.map((a) => `${a.from}>${a.to}`)).toEqual(['observed>provisional', 'provisional>confirmed']);
      expect(event.notifications).toMatchObject([{ type: 'event_confirmed', status: 'pending' }]);
      expect(event.block).toMatchObject({ canonical: true, number: 4 });
      expect(event.alertStatus).toBe('open');
    });

    it('lists alerts with the state of their notification; provisional events have none', async () => {
      const { items } = await json<{ items: Array<{ blockNumber: number; status: string; notification: string | null; threshold: string; symbol: string }> }>('/alerts?status=open');
      expect(items.map((a) => a.blockNumber)).toEqual([13, 12, 11, 9, 4]);
      expect(items.find((a) => a.blockNumber === 12)).toMatchObject({ notification: null, symbol: 'USDX', threshold: '10000' });
      expect(items.find((a) => a.blockNumber === 4)).toMatchObject({ notification: 'pending' });
    });
  });

  describe('GET /metrics', () => {
    it('exposes state gauges and process counters, and invents no uptime or throughput figure', async () => {
      const res = await get('/metrics');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.body).toContain('cers_checkpoint_block{chain_id="31337"} 14');
      expect(res.body).toContain('cers_events{chain_id="31337",status="confirmed"} 3');
      expect(res.body).toContain('cers_outbox_rows{chain_id="31337",status="pending"} 3');
      expect(res.body).toMatch(/cers_blocks_ingested_total \d+/);
      expect(res.body).not.toMatch(/uptime|throughput|per_second/i);
    });
  });

  describe('scenarios', () => {
    it('lists all nine, none passed before they have been run', async () => {
      const { items } = await json<{ items: Array<{ id: string; lastRun: unknown }> }>('/scenarios');
      expect(items.map((s) => s.id)).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09']);
      expect(items.every((s) => s.lastRun === null)).toBe(true);
    });

    it('serves a scenario\'s definition and, once recorded, the checks and evidence of its last run', async () => {
      const before = await json<{ lastRun: unknown; note: string; faults: string[]; checks: unknown[] }>('/scenarios/S06');
      expect(before.lastRun).toBeNull();
      expect(before.note).toMatch(/npm run scenarios/);
      expect(before.faults.length).toBeGreaterThan(0);

      const def = SCENARIOS.find((s) => s.id === 'S06')!;
      await persistResult(sb.db, await runScenario(def));
      const after = await json<{ lastRun: { status: string; checks: Array<{ id: string; passed: boolean }>; evidence: Record<string, unknown> } }>('/scenarios/S06');
      expect(after.lastRun.status).toBe('passed');
      expect(after.lastRun.checks.every((c) => c.passed)).toBe(true);
      expect(after.lastRun.checks).toHaveLength(def.checks.length);
      expect(after.lastRun.evidence).toHaveProperty('finalState');
    });

    it('rejects ids that are not scenarios', async () => {
      expect((await get('/scenarios/S10')).statusCode).toBe(400);
      expect((await get('/scenarios/S00')).statusCode).toBe(400);
    });
  });

  describe('GET /openapi.json', () => {
    it('documents every public endpoint and none of the admin routes while they are disabled', async () => {
      const doc = await json<{ openapi: string; paths: Record<string, unknown> }>('/openapi.json');
      expect(doc.openapi).toBe('3.1.0');
      expect(Object.keys(doc.paths).sort()).toEqual(['/alerts', '/events', '/events/{id}', '/healthz', '/metrics', '/scenarios', '/scenarios/{id}', '/status']);
    });
  });
});

describe('a reorganization is visible through the API', () => {
  it('shows orphaned events with their audit trail, withdrawn alerts, the last recovery action and the incident', async () => {
    const sb = await Sandbox.create({ confirmationDepth: 3, batchSize: 5 });
    const app = await buildServer(contextFor(sb));
    try {
      minePlan(sb.chain, HISTORY, 14);
      await sb.scanner.scanOnce('startup');
      sb.chain.reorg({ depth: 6, replacement: 7, branch: 'B', specs: [undefined, undefined, undefined, undefined, undefined, undefined, block(tx(settlement('erin', '300000')))] });
      await sb.scanner.scanOnce('poll'); // blocks 9..14 replaced: confirmed events at 9 and 11 are orphaned

      const status = (await app.inject({ method: 'GET', url: '/status?verify=true' })).json<{
        events: Record<string, number>;
        lastRecoveryAction: { kind: string; summary: string };
        openIncidents: { count: number; requireManualReview: number; latest: Array<{ kind: string; severity: string }> };
        invariants: { ok: boolean };
      }>();
      expect(status.events.orphaned).toBe(5);
      expect(status.lastRecoveryAction).toMatchObject({ kind: 'reorg' });
      expect(status.lastRecoveryAction.summary).toMatch(/depth 6/);
      expect(status.openIncidents).toMatchObject({ count: 1, requireManualReview: 1 });
      expect(status.openIncidents.latest[0]).toMatchObject({ kind: 'confirmed_event_orphaned', severity: 'critical' });
      expect(status.invariants.ok).toBe(true);

      const { items } = (await app.inject({ method: 'GET', url: '/events?status=orphaned&fromBlock=9&toBlock=9' })).json<{ items: Array<{ eventId: string }> }>();
      const event = (await app.inject({ method: 'GET', url: `/events/${encodeURIComponent(items[0]!.eventId)}` })).json<{
        status: string;
        audit: Array<{ action: string; to: string }>;
        block: { canonical: boolean; orphanReason: string };
        notifications: Array<{ status: string }>;
      }>();
      expect(event.status).toBe('orphaned');
      expect(event.audit.map((a) => a.action)).toEqual(['ingested', 'confirmed', 'orphaned']);
      expect(event.block.canonical).toBe(false);
      expect(event.block.orphanReason).toMatch(/no longer on the provider's canonical chain/);
      expect(event.notifications).toMatchObject([{ status: 'suppressed' }]);

      const alerts = (await app.inject({ method: 'GET', url: '/alerts?status=withdrawn' })).json<{ items: unknown[] }>();
      expect(alerts.items.length).toBeGreaterThanOrEqual(4);
    } finally {
      await app.close();
      await sb.destroy();
    }
  });
});

describe('admin and fault-injection routes', () => {
  it('do not exist unless explicitly enabled', async () => {
    const sb = await Sandbox.create();
    const app = await buildServer(contextFor(sb));
    try {
      expect((await app.inject({ method: 'POST', url: '/admin/fixture/mine', payload: { blocks: 1 } })).statusCode).toBe(404);
    } finally {
      await app.close();
      await sb.destroy();
    }
  });

  it('refuse to start when enabled on a non-loopback address, without a token, or without a fixture to control', async () => {
    const sb = await Sandbox.create();
    try {
      const controls = { chain: sb.chain, provider: sb.provider, notifier: sb.notifier, scanner: sb.scanner };
      const token = 'a-long-enough-token-1234';
      await expect(buildServer(contextFor(sb, { host: '0.0.0.0', admin: { enabled: true, token, controls } }))).rejects.toThrow(/loopback/);
      await expect(buildServer(contextFor(sb, { admin: { enabled: true, token: null, controls } }))).rejects.toThrow(/ADMIN_TOKEN/);
      await expect(buildServer(contextFor(sb, { admin: { enabled: true, token: 'short', controls } }))).rejects.toThrow(/ADMIN_TOKEN/);
      await expect(buildServer(contextFor(sb, { admin: { enabled: true, token, controls: null } }))).rejects.toThrow(/fixture/);
    } finally {
      await sb.destroy();
    }
  });

  it('require the bearer token, validate input, and act on the fixture', async () => {
    const sb = await Sandbox.create({ confirmationDepth: 2 });
    const token = 'a-long-enough-token-1234';
    const controls = { chain: sb.chain, provider: sb.provider, notifier: sb.notifier, scanner: sb.scanner };
    const app = await buildServer(contextFor(sb, { admin: { enabled: true, token, controls } }));
    const auth = { authorization: `Bearer ${token}` };
    try {
      expect((await app.inject({ method: 'POST', url: '/admin/fixture/mine', payload: { blocks: 3 } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/admin/fixture/mine', payload: { blocks: 3 }, headers: { authorization: 'Bearer wrong-token-wrong-token' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/admin/fixture/mine', payload: { blocks: 0 }, headers: auth })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/admin/fixture/mine', payload: { blocks: 3, extra: true }, headers: auth })).statusCode).toBe(400);

      const mined = await app.inject({ method: 'POST', url: '/admin/fixture/mine', payload: { blocks: 3 }, headers: auth });
      expect(mined.statusCode).toBe(200);
      expect(mined.json()).toMatchObject({ mined: 3, head: { number: 3 } });

      const scan = await app.inject({ method: 'POST', url: '/admin/scanner/scan', headers: auth });
      expect(scan.json()).toMatchObject({ outcome: 'caught_up', blocksIngested: 4 });

      const reorg = await app.inject({ method: 'POST', url: '/admin/fixture/reorg', payload: { depth: 2, replacement: 2, branch: 'X' }, headers: auth });
      expect(reorg.json()).toMatchObject({ removed: 2, added: 2 });
      expect((await app.inject({ method: 'POST', url: '/admin/fixture/reorg', payload: { depth: 99, replacement: 1, branch: 'X' }, headers: auth })).statusCode).toBe(400);

      await app.inject({ method: 'POST', url: '/admin/fixture/faults', payload: { method: 'getHead', action: 'timeout', times: 1 }, headers: auth });
      expect(sb.provider.faults.remaining()).toBe(1);
      await app.inject({ method: 'DELETE', url: '/admin/fixture/faults', headers: auth });
      expect(sb.provider.faults.remaining()).toBe(0);

      const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{ paths: Record<string, unknown> }>();
      expect(Object.keys(doc.paths)).toContain('/admin/fixture/reorg');
    } finally {
      await app.close();
      await sb.destroy();
    }
  });
});

