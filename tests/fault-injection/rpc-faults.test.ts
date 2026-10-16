import { afterEach, describe, expect, it } from 'vitest';
import type { FaultRule } from '../../src/fixtures/faults.js';
import { mulberry32 } from '../../src/fixtures/prng.js';
import { block, minePlan, transfer, tx } from '../../scenarios/builders.js';
import { Sandbox } from '../../scenarios/harness.js';
import { diffCanonical, EMPTY_DIFF, expectedFlows } from '../../scenarios/oracle.js';

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});
const create = async (opts: Parameters<typeof Sandbox.create>[0]): Promise<Sandbox> => {
  const sb = await Sandbox.create(opts);
  sandboxes.push(sb);
  return sb;
};

describe('RPC timeouts and errors', () => {
  it('retries transient failures with bounded exponential backoff and skips no block', async () => {
    const sb = await create({ traffic: 'random', seed: 'rpc-1', batchSize: 5 });
    sb.chain.mine(20);
    sb.provider.faults
      .add({ method: 'getLogs', action: 'timeout', times: 3 }) // the first range fails three times, the fourth try succeeds
      .add({ method: 'getHeader', action: 'server_error', times: 2, skip: 22 }); // and, in the second batch, a header call fails twice

    const report = await sb.scanner.scanOnce('startup');

    expect(report.outcome).toBe('caught_up');
    expect(report.retries).toBe(5);
    expect(sb.logs.count('rpc.retry')).toBe(5);
    expect(sb.sleeps).toEqual([100, 200, 400, 100, 200]); // 100ms doubling, restarting per operation
    expect(sb.provider.faults.remaining()).toBe(0);
    expect((await sb.canonicalBlocks()).map((b) => b.number)).toEqual([...Array(21).keys()]);
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('gives up cleanly when the provider keeps failing: no partial writes, a degraded status, and recovery on the next cycle', async () => {
    const sb = await create({ traffic: 'random', seed: 'rpc-2', batchSize: 5 });
    sb.chain.mine(20);

    // First batch succeeds, then every getLogs fails for good.
    sb.provider.faults.add({ method: 'getLogs', action: 'server_error', times: 1000, skip: 1 });
    const failed = await sb.scanner.scanOnce('startup');
    expect(failed.outcome).toBe('rpc_failed');
    expect(failed.error).toMatch(/failed after 4 attempts/);
    expect(await sb.checkpoint()).toMatchObject({ number: 4, status: 'degraded' }); // exactly the committed batch, nothing beyond
    expect((await sb.canonicalBlocks()).map((b) => b.number)).toEqual([0, 1, 2, 3, 4]);
    expect(Math.max(0, ...(await sb.events()).map((e) => e.blockNumber))).toBeLessThanOrEqual(4);
    expect((await sb.invariants()).ok).toBe(true);
    expect(sb.logs.count('rpc.exhausted')).toBe(1);

    sb.provider.faults.clear();
    const recovered = await sb.scanner.scanOnce('poll');
    expect(recovered.outcome).toBe('caught_up');
    expect(await sb.checkpoint()).toMatchObject({ number: 20, status: 'ok' });
    expect(sb.logs.count('scanner.recovered')).toBe(1);
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
  });

  it('does not retry past a persistent failure forever: the number of provider calls is bounded', async () => {
    const sb = await create({ traffic: 'scripted', retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 } });
    sb.chain.mine(5);
    sb.provider.faults.add({ method: 'getHead', action: 'timeout', times: 1000 });
    const report = await sb.scanner.scanOnce('poll');
    expect(report.outcome).toBe('rpc_failed');
    expect(sb.provider.calls.getHead).toBe(3);
    expect(sb.sleeps).toEqual([10, 20]);
  });
});

describe('responses that do not match the chain', () => {
  it('rejects logs that belong to a branch the headers no longer describe, retries, and ingests nothing from the wrong branch', async () => {
    const sb = await create({ traffic: 'scripted', batchSize: 5 });
    const plan = { 3: block(tx(transfer('USDX', 'alice', 'bob', '20000'))), 4: block(tx(transfer('USDX', 'bob', 'carol', '15000'))) };
    minePlan(sb.chain, plan, 5);
    await sb.provider.getLogs({ fromBlock: 0, toBlock: 4, addresses: sb.watch.addresses }); // the scanner's first range, cached from branch A

    sb.chain.reorg({ depth: 5, replacement: 5, branch: 'B' }); // the same heights now belong to a different branch, with no events
    sb.provider.faults.add({ method: 'getLogs', action: 'stale', times: 1 }); // the log call returns the cached branch-A answer

    const report = await sb.scanner.scanOnce('startup');

    expect(report.outcome).toBe('caught_up');
    expect(report.retries).toBe(1);
    const retry = sb.logs.events('rpc.retry')[0];
    expect(retry).toMatchObject({ code: 'INCONSISTENT' });
    expect(String(retry?.error)).toMatch(/log claims block/);
    expect(await sb.events()).toEqual([]); // not even as orphaned rows: branch A never reached the database
    expect(await sb.count('event_audit')).toBe(0);
    expect((await sb.canonicalBlocks()).map((b) => b.hash)).toEqual([...Array(6).keys()].map((n) => sb.chain.blockAt(n)!.header.hash));
  });
});

describe('fault fuzzing: any schedule of transient faults ends in the same state', () => {
  const METHODS = ['getHead', 'getHeader', 'getLogs'] as const;
  const ACTIONS = ['timeout', 'server_error', 'stale', 'duplicate_logs', 'lagging'] as const;

  for (let seed = 1; seed <= 12; seed++) {
    it(`seed ${seed}: invariants hold after every cycle and the final state equals the fixture's`, async () => {
      const rng = mulberry32(seed * 7919);
      const sb = await create({ traffic: 'random', seed: `fuzz-${seed}`, batchSize: 1 + Math.floor(rng() * 6) });
      sb.chain.mine(30);

      const rules: FaultRule[] = [];
      for (let i = 0; i < 4 + Math.floor(rng() * 5); i++) {
        rules.push({
          method: METHODS[Math.floor(rng() * METHODS.length)]!,
          action: ACTIONS[Math.floor(rng() * ACTIONS.length)]!,
          times: 1 + Math.floor(rng() * 3),
          skip: Math.floor(rng() * 12),
          lagBlocks: 1 + Math.floor(rng() * 5),
        });
      }
      for (const rule of rules) sb.provider.faults.add(rule);

      let reorged = false;
      for (let cycle = 0; cycle < 60; cycle++) {
        await sb.scanner.scanOnce('poll');
        const report = await sb.invariants();
        expect(report.checks.filter((c) => c.violations > 0), `cycle ${cycle}, rules ${JSON.stringify(rules)}`).toEqual([]);
        if (!reorged && cycle === 2) {
          sb.chain.reorg({ depth: 2, replacement: 3, branch: 'F' });
          reorged = true;
        }
        const cp = await sb.checkpoint();
        if (cp.number === sb.chain.head.number && cp.hash === sb.chain.head.hash && sb.provider.faults.remaining() === 0) break;
      }

      expect(await sb.checkpoint()).toMatchObject({ number: sb.chain.head.number, hash: sb.chain.head.hash });
      expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
      expect(await sb.flows()).toEqual(expectedFlows(sb.chain.expectedEvents()));
      expect((await sb.canonicalBlocks()).length).toBe(sb.chain.head.number + 1);
    });
  }
});
