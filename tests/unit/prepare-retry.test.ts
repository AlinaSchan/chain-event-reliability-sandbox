import { describe, expect, it } from 'vitest';
import { RpcError, RpcExhaustedError } from '../../src/domain/errors.js';
import type { Hex, RpcLog } from '../../src/domain/types.js';
import { buildWatchIndex } from '../../src/domain/watchlist.js';
import { FIXTURE_WATCHLIST } from '../../src/fixtures/accounts.js';
import { FixtureChain } from '../../src/fixtures/chain.js';
import { prepareBlocks } from '../../src/ingestion/prepare.js';
import { withRetry } from '../../src/ingestion/retry.js';
import { CrashPoints, InjectedCrash } from '../../src/observability/failpoints.js';
import { TRANSFER_TOPIC } from '../../src/domain/abi.js';

const watch = buildWatchIndex(FIXTURE_WATCHLIST);

function chainWithEvents() {
  const chain = new FixtureChain({ chainId: 31337, seed: 'prep', watch, traffic: 'scripted' });
  const usdx = (value: bigint) => ({ kind: 'erc20_transfer' as const, token: 'USDX', from: 'alice', to: 'bob', value });
  chain.mineOne({ txs: [{ logs: [usdx(1n), usdx(2n)] }] }); // block 1: two logs in ONE transaction
  chain.mineOne({ txs: [{ logs: [usdx(3n)] }] }); // block 2
  const headers = [chain.getHeaderByNumber(1)!, chain.getHeaderByNumber(2)!];
  const logs = chain.logsInRange(1, 2, watch.addresses);
  return { chain, headers, logs };
}

describe('prepareBlocks', () => {
  it('keeps two logs of one transaction as two events', () => {
    const { headers, logs } = chainWithEvents();
    const blocks = prepareBlocks(31337, headers, logs, watch);
    expect(blocks[0]!.events.map((e) => e.amount)).toEqual([1n, 2n]);
    expect(blocks[0]!.events[0]!.transactionHash).toBe(blocks[0]!.events[1]!.transactionHash);
    expect(new Set(blocks[0]!.events.map((e) => e.eventId)).size).toBe(2);
  });

  it('collapses a log delivered twice into one event and counts the copies', () => {
    const { headers, logs } = chainWithEvents();
    const blocks = prepareBlocks(31337, headers, [...logs, ...logs], watch);
    expect(blocks[0]!.events).toHaveLength(2);
    expect([...blocks[0]!.copies.values()]).toEqual([2, 2]);
    expect(blocks[1]!.events).toHaveLength(1);
  });

  it('refuses logs whose block hash differs from the header held for that height (response straddled a reorg)', () => {
    const { headers, logs } = chainWithEvents();
    const foreign = logs.map((l, i) => (i === 0 ? { ...l, blockHash: ('0x' + 'ee'.repeat(32)) as Hex } : l));
    expect(() => prepareBlocks(31337, headers, foreign, watch)).toThrowError(RpcError);
    try {
      prepareBlocks(31337, headers, foreign, watch);
    } catch (err) {
      expect((err as RpcError).code).toBe('INCONSISTENT');
      expect((err as RpcError).retryable).toBe(true);
    }
  });

  it('refuses a log whose transaction is not in the block', () => {
    const { headers, logs } = chainWithEvents();
    const wrongTx = logs.map((l, i) => (i === 0 ? { ...l, transactionHash: ('0x' + 'dd'.repeat(32)) as Hex } : l));
    expect(() => prepareBlocks(31337, headers, wrongTx, watch)).toThrow(/not in block/);
  });

  it('refuses headers that do not form a chain', () => {
    const { headers, logs } = chainWithEvents();
    const broken = [headers[0]!, { ...headers[1]!, parentHash: ('0x' + 'cc'.repeat(32)) as Hex }];
    expect(() => prepareBlocks(31337, broken, logs, watch)).toThrow(/do not form a chain/);
  });

  it('refuses two different payloads under one identity', () => {
    const { headers, logs } = chainWithEvents();
    const tampered: RpcLog = { ...logs[0]!, data: ('0x' + '00'.repeat(31) + '09') as Hex };
    expect(() => prepareBlocks(31337, headers, [logs[0]!, tampered, ...logs.slice(1)], watch)).toThrow(/different payloads/);
  });

  it('quarantines an undecodable log from a watched contract instead of dropping it', () => {
    const { headers, logs } = chainWithEvents();
    const usdx = watch.entries.find((w) => w.symbol === 'USDX')!;
    const header = headers[0]!;
    const bad: RpcLog = {
      address: usdx.address,
      topics: [TRANSFER_TOPIC, ('0x' + '01'.repeat(32)) as Hex, ('0x' + '02'.repeat(32)) as Hex, ('0x' + '63'.repeat(32)) as Hex],
      data: '0x',
      blockHash: header.hash,
      blockNumber: header.number,
      transactionHash: header.transactionHashes[0]!,
      transactionIndex: 0,
      logIndex: 99,
    };
    const blocks = prepareBlocks(31337, headers, [...logs, bad], watch);
    expect(blocks[0]!.quarantined).toHaveLength(1);
    expect(blocks[0]!.events).toHaveLength(2); // the good ones are unaffected
  });

  it('ignores logs from unwatched contracts', () => {
    const { headers, logs } = chainWithEvents();
    const other: RpcLog = { ...logs[0]!, address: ('0x' + 'ab'.repeat(20)) as Hex, logIndex: 50 };
    const blocks = prepareBlocks(31337, headers, [...logs, other], watch);
    expect(blocks[0]!.ignoredLogs).toBe(1);
    expect(blocks[0]!.events).toHaveLength(2);
  });
});

describe('withRetry', () => {
  const policy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 350 };
  const hooks = () => {
    const delays: number[] = [];
    return { delays, hooks: { sleep: (ms: number) => { delays.push(ms); return Promise.resolve(); } } };
  };

  it('retries transient errors with capped exponential backoff and returns the eventual result', async () => {
    const h = hooks();
    let calls = 0;
    const result = await withRetry('op', () => {
      calls++;
      return calls < 4 ? Promise.reject(new RpcError('TIMEOUT', 'x')) : Promise.resolve('ok');
    }, policy, h.hooks);
    expect(result).toBe('ok');
    expect(calls).toBe(4);
    expect(h.delays).toEqual([100, 200, 350]); // 400 capped at 350
  });

  it('gives up after maxAttempts with an exhausted error that names the operation', async () => {
    const h = hooks();
    let calls = 0;
    await expect(
      withRetry('getLogs', () => { calls++; return Promise.reject(new RpcError('SERVER_ERROR', '503')); }, policy, h.hooks),
    ).rejects.toBeInstanceOf(RpcExhaustedError);
    expect(calls).toBe(4);
    expect(h.delays).toHaveLength(3);
  });

  it('does not retry errors that are not retryable RPC errors', async () => {
    const h = hooks();
    let calls = 0;
    await expect(withRetry('op', () => { calls++; return Promise.reject(new Error('bug')); }, policy, h.hooks)).rejects.toThrow('bug');
    await expect(
      withRetry('op', () => { calls++; return Promise.reject(new RpcError('INCONSISTENT', 'no', false)); }, policy, h.hooks),
    ).rejects.toThrow('no');
    expect(calls).toBe(2);
    expect(h.delays).toEqual([]);
  });
});

describe('CrashPoints', () => {
  it('throws once, on the requested hit, and never again', () => {
    const crash = new CrashPoints().arm('scanner.after_commit', { afterHits: 2 });
    crash.hit('scanner.after_commit');
    crash.hit('scanner.after_commit');
    expect(() => crash.hit('scanner.after_commit')).toThrow(InjectedCrash);
    expect(() => crash.hit('scanner.after_commit')).not.toThrow();
    expect(crash.triggered).toEqual(['scanner.after_commit']);
  });

  it('ignores points that are not armed', () => {
    const crash = new CrashPoints().arm('scanner.before_commit');
    expect(() => crash.hit('scanner.after_commit')).not.toThrow();
  });
});
