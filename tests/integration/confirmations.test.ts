import { afterEach, describe, expect, it } from 'vitest';
import type { BlockSpec } from '../../src/fixtures/chain.js';
import { block, minePlan, transfer, tx } from '../../scenarios/builders.js';
import { Sandbox } from '../../scenarios/harness.js';

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});
const create = async (opts: Parameters<typeof Sandbox.create>[0]): Promise<Sandbox> => {
  const sb = await Sandbox.create(opts);
  sandboxes.push(sb);
  return sb;
};

const HIGH = transfer('USDX', 'alice', 'bob', '20000'); // above the 10,000 USDX threshold
const LOW = transfer('USDX', 'bob', 'carol', '10');

describe('confirmation depth', () => {
  it('keeps an event provisional until exactly `depth` blocks sit on top of it, then confirms it and only then queues a notification', async () => {
    const sb = await create({ confirmationDepth: 4, batchSize: 3 });
    const plan: Record<number, BlockSpec> = { 5: block(tx(HIGH)), 6: block(tx(LOW)) };

    const trace: Array<{ head: number; high: string; low: string | undefined; queued: number }> = [];
    for (let head = 5; head <= 10; head++) {
      while (sb.chain.head.number < head) sb.chain.mineOne(plan[sb.chain.head.number + 1]);
      await sb.scanner.scanOnce('notification');
      const events = await sb.events();
      trace.push({
        head,
        high: events.find((e) => e.blockNumber === 5)!.status,
        low: events.find((e) => e.blockNumber === 6)?.status,
        queued: await sb.count('outbox'),
      });
    }

    expect(trace).toEqual([
      { head: 5, high: 'provisional', low: undefined, queued: 0 },
      { head: 6, high: 'provisional', low: 'provisional', queued: 0 },
      { head: 7, high: 'provisional', low: 'provisional', queued: 0 },
      { head: 8, high: 'provisional', low: 'provisional', queued: 0 }, // 3 blocks on top of block 5: not yet
      { head: 9, high: 'confirmed', low: 'provisional', queued: 1 }, // 4 on top of block 5: confirmed, notification queued
      { head: 10, high: 'confirmed', low: 'confirmed', queued: 1 }, // the low-value event is confirmed but never notifies
    ]);

    const { rows: audit } = await sb.db.query<{ action: string; details: { blocksOnTop: number; depth: number } }>(
      "SELECT action, details FROM event_audit WHERE action = 'confirmed' ORDER BY id",
    );
    expect(audit.map((a) => a.details.blocksOnTop)).toEqual([4, 4]);
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('never confirms on the passage of time: a stalled head leaves events provisional however often it is polled', async () => {
    const sb = await create({ confirmationDepth: 3 });
    minePlan(sb.chain, { 2: block(tx(HIGH)) }, 3);
    for (let i = 0; i < 10; i++) await sb.scanner.scanOnce('poll');
    expect((await sb.events()).map((e) => e.status)).toEqual(['provisional']);
    expect(await sb.count('outbox')).toBe(0);
  });

  it('measures depth from the durable checkpoint, not from the provider\'s head', async () => {
    const sb = await create({ confirmationDepth: 3, batchSize: 5 });
    minePlan(sb.chain, { 2: block(tx(HIGH)) }, 4);
    await sb.scanner.scanOnce('startup'); // checkpoint 4, event provisional (4 - 2 < 3)

    sb.chain.mine(20); // the provider's head races ahead...
    sb.provider.faults.add({ method: '*', action: 'timeout', times: 1000 }); // ...but every call to it fails
    const report = await sb.scanner.scanOnce('poll');
    expect(report.outcome).toBe('rpc_failed');
    expect((await sb.events())[0]?.status).toBe('provisional'); // 22 blocks "on top" at the provider, 2 at our checkpoint
    expect((await sb.checkpoint()).number).toBe(4);

    sb.provider.faults.clear();
    await sb.scanner.scanOnce('poll');
    expect((await sb.events())[0]?.status).toBe('confirmed');
  });

  it('issues a new notification identity when an event is confirmed again after being orphaned and restored', async () => {
    const sb = await create({ confirmationDepth: 2 });
    minePlan(sb.chain, { 3: block(tx(HIGH)) }, 5);
    const tipA = sb.chain.head;
    await sb.scanner.scanOnce('startup');
    expect((await sb.events())[0]).toMatchObject({ status: 'confirmed', confirmCount: 1 });

    sb.chain.reorg({ depth: 3, replacement: 3, branch: 'B' }); // blocks 3..5 replaced
    await sb.scanner.scanOnce('poll');
    expect((await sb.events())[0]?.status).toBe('orphaned');

    sb.chain.setCanonicalTip(tipA.hash); // the original branch wins again
    await sb.scanner.scanOnce('poll');
    expect((await sb.events())[0]).toMatchObject({ status: 'confirmed', confirmCount: 2 });

    const { rows } = await sb.db.query<{ notification_id: string; status: string }>('SELECT notification_id, status FROM outbox ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.notification_id.split('#').pop())).toEqual(['1', '2']);
    expect(rows.map((r) => r.status)).toEqual(['suppressed', 'pending']); // #1 was never delivered before the event vanished
    expect((await sb.invariants()).ok).toBe(true);
  });
});
