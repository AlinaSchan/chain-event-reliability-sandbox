import { describe, expect, it } from 'vitest';
import { decodeWatchedLog } from '../../src/domain/abi.js';
import type { Hex } from '../../src/domain/types.js';
import { buildWatchIndex } from '../../src/domain/watchlist.js';
import { FIXTURE_WATCHLIST } from '../../src/fixtures/accounts.js';
import { FixtureChain } from '../../src/fixtures/chain.js';
import { FixtureNotifier } from '../../src/fixtures/notifier.js';
import { FixtureProvider } from '../../src/fixtures/provider.js';

const watch = buildWatchIndex(FIXTURE_WATCHLIST);
const make = (seed = 'unit', traffic: 'random' | 'scripted' = 'random') =>
  new FixtureChain({ chainId: 31337, seed, watch, traffic });

describe('FixtureChain determinism', () => {
  it('produces identical blocks for identical seeds and operations', () => {
    const a = make();
    const b = make();
    a.mine(25);
    b.mine(25);
    expect(a.head).toEqual(b.head);
    for (let n = 0; n <= 25; n++) expect(a.blockAt(n)?.header).toEqual(b.blockAt(n)?.header);
  });

  it('produces different chains for different seeds', () => {
    const a = make('one');
    const b = make('two');
    a.mine(25);
    b.mine(25);
    expect(a.head.hash).not.toBe(b.head.hash);
  });

  it('actually generates watched events under random traffic, including high-value ones', () => {
    const chain = make();
    chain.mine(60);
    const expected = chain.expectedEvents();
    expect(expected.length).toBeGreaterThan(20);
    expect(expected.some((e) => e.highValue)).toBe(true);
    expect(expected.some((e) => !e.highValue)).toBe(true);
    expect(new Set(expected.map((e) => e.kind))).toEqual(new Set(['erc20_transfer', 'settlement_recorded']));
  });

  it('links every block to its parent and numbers log indexes per block', () => {
    const chain = make();
    chain.mine(30);
    for (let n = 1; n <= 30; n++) {
      const block = chain.blockAt(n)!;
      expect(block.header.parentHash).toBe(chain.blockAt(n - 1)!.header.hash);
      expect(block.logs.map((l) => l.logIndex)).toEqual(block.logs.map((_, i) => i));
      for (const log of block.logs) expect(log.blockHash).toBe(block.header.hash);
    }
  });

  it('the decoder agrees with the fixture\'s own record of what each log means (independent oracle)', () => {
    const chain = make();
    chain.mine(60);
    const oracle = new Map(chain.expectedEvents().map((e) => [e.eventId, e]));
    let decoded = 0;
    for (let n = 0; n <= 60; n++) {
      for (const log of chain.blockAt(n)!.logs) {
        const entry = watch.byAddress.get(log.address)!;
        const out = decodeWatchedLog(log, 31337, entry);
        if (out.type !== 'event') continue;
        const truth = oracle.get(out.event.eventId);
        expect(truth, out.event.eventId).toBeDefined();
        expect(out.event.amount).toBe(truth!.amount);
        expect(out.event.kind).toBe(truth!.kind);
        decoded += 1;
      }
    }
    expect(decoded).toBe(oracle.size);
  });
});

describe('FixtureChain reorganizations', () => {
  it('replaces the tip with a competing branch that keeps the shared prefix', () => {
    const chain = make('reorg', 'scripted');
    chain.mine(10);
    const before = [...Array(11).keys()].map((n) => chain.blockAt(n)!.header.hash);
    const { ancestor, removed, added } = chain.reorg({ depth: 3, replacement: 4, branch: 'B' });

    expect(ancestor.number).toBe(7);
    expect(removed.map((b) => b.header.number)).toEqual([8, 9, 10]);
    expect(added.map((b) => b.header.number)).toEqual([8, 9, 10, 11]);
    expect(chain.head.number).toBe(11);
    for (let n = 0; n <= 7; n++) expect(chain.blockAt(n)!.header.hash).toBe(before[n]);
    for (let n = 8; n <= 10; n++) expect(chain.blockAt(n)!.header.hash).not.toBe(before[n]);
    expect(chain.blockAt(8)!.header.parentHash).toBe(before[7]);
  });

  it('keeps abandoned blocks addressable and can switch back to them', () => {
    const chain = make('flip', 'scripted');
    chain.mine(10);
    const oldTip = chain.head;
    chain.reorg({ depth: 2, replacement: 3, branch: 'B' });
    expect(chain.head.hash).not.toBe(oldTip.hash);
    expect(chain.blockByHash(oldTip.hash)).toBeDefined();
    chain.setCanonicalTip(oldTip.hash);
    expect(chain.head).toEqual(oldTip);
  });

  it('gives a labeled transaction the same hash on every branch (re-inclusion) but a new block hash', () => {
    const chain = make('reinclude', 'scripted');
    const tx = { label: 'T1', logs: [{ kind: 'erc20_transfer' as const, token: 'USDX', from: 'alice', to: 'bob', value: 5n }] };
    chain.mine(5);
    chain.mineOne({ txs: [tx] }); // block 6
    chain.mine(2);
    const first = chain.expectedEvents().find((e) => e.blockNumber === 6)!;
    chain.reorg({ depth: 3, replacement: 3, branch: 'B', specs: [{ txs: [tx] }] }); // T1 lands in the new block 6 too
    const second = chain.expectedEvents().find((e) => e.blockNumber === 6)!;

    expect(second.transactionHash).toBe(first.transactionHash);
    expect(second.blockHash).not.toBe(first.blockHash);
    expect(second.eventId).not.toBe(first.eventId);
  });

  it('rejects a reorg deeper than the chain', () => {
    const chain = make('deep', 'scripted');
    chain.mine(3);
    expect(() => chain.reorg({ depth: 10, replacement: 1, branch: 'B' })).toThrow(/out of range/);
  });
});

describe('FixtureProvider faults', () => {
  const setup = () => {
    const chain = make('faults', 'scripted');
    chain.mine(8);
    return { chain, provider: new FixtureProvider(chain) };
  };

  it('fires faults by call count: skip first, then fail `times` calls', async () => {
    const { provider } = setup();
    provider.faults.add({ method: 'getHead', action: 'timeout', times: 2, skip: 1 });
    await expect(provider.getHead()).resolves.toBeDefined(); // skipped
    await expect(provider.getHead()).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(provider.getHead()).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(provider.getHead()).resolves.toBeDefined(); // exhausted
    expect(provider.faults.fired).toHaveLength(2);
    expect(provider.faults.remaining()).toBe(0);
  });

  it('returns the previous response for a "stale" fault, even though the chain has moved', async () => {
    const { chain, provider } = setup();
    const before = await provider.getHead();
    chain.mine(3);
    provider.faults.add({ method: 'getHead', action: 'stale', times: 1 });
    expect(await provider.getHead()).toEqual(before);
    expect(await provider.getHead()).toEqual(chain.head);
  });

  it('duplicates every log for a "duplicate_logs" fault', async () => {
    const chain = make('dup', 'scripted');
    chain.mineOne({ txs: [{ logs: [{ kind: 'erc20_transfer', token: 'USDX', from: 'alice', to: 'bob', value: 1n }] }] });
    const provider = new FixtureProvider(chain);
    const range = { fromBlock: 0, toBlock: 1, addresses: watch.addresses };
    provider.faults.add({ method: 'getLogs', action: 'duplicate_logs', times: 1 });
    expect(await provider.getLogs(range)).toHaveLength(2);
    expect(await provider.getLogs(range)).toHaveLength(1);
  });
});

describe('FixtureNotifier', () => {
  it('drops heads while disconnected and never replays them', () => {
    const chain = make('ws', 'scripted');
    const notifier = new FixtureNotifier(chain);
    const heads: Hex[] = [];
    let connects = 0;
    notifier.subscribe({ onHead: (h) => heads.push(h.hash), onConnect: () => connects++, onDisconnect: () => undefined });

    chain.mine(2);
    notifier.disconnect();
    chain.mine(3); // lost
    notifier.reconnect();
    chain.mine(1);

    expect(heads).toHaveLength(3);
    expect(notifier.stats.dropped).toBe(3);
    expect(connects).toBe(1);
  });

  it('can duplicate and silently drop notifications while connected', () => {
    const chain = make('ws2', 'scripted');
    const notifier = new FixtureNotifier(chain);
    let seen = 0;
    notifier.subscribe({ onHead: () => seen++, onConnect: () => undefined, onDisconnect: () => undefined });
    notifier.duplicateNext(1);
    chain.mine(1);
    expect(seen).toBe(2);
    notifier.dropNext(1);
    chain.mine(1);
    expect(seen).toBe(2);
  });
});
