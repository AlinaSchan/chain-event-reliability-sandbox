import { describe, expect, it } from 'vitest';
import {
  decodeWatchedLog,
  encodeSettlementLog,
  encodeTransferLog,
  SETTLEMENT_TOPIC,
  TRANSFER_TOPIC,
  type Erc20TransferArgs,
  type SettlementArgs,
} from '../../src/domain/abi.js';
import type { Hex, RpcLog } from '../../src/domain/types.js';
import { MAX_UINT256 } from '../../src/domain/units.js';
import { buildWatchIndex } from '../../src/domain/watchlist.js';
import { FIXTURE_WATCHLIST, syntheticAddress } from '../../src/fixtures/accounts.js';

const watch = buildWatchIndex(FIXTURE_WATCHLIST);
const usdx = watch.entries.find((w) => w.symbol === 'USDX')!;
const settle = watch.entries.find((w) => w.symbol === 'SETTLE')!;
const alice = syntheticAddress('account:alice');
const bob = syntheticAddress('account:bob');
const H = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

function logOf(address: Hex, parts: { topics: Hex[]; data: Hex }): RpcLog {
  return { address, ...parts, blockHash: H(0xb0), blockNumber: 7, transactionHash: H(0x7a), transactionIndex: 0, logIndex: 2 };
}

describe('event selectors', () => {
  it('matches the canonical ERC-20 Transfer topic (known-answer test)', () => {
    expect(TRANSFER_TOPIC).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  });

  it('gives the custom event its own selector', () => {
    expect(SETTLEMENT_TOPIC).not.toBe(TRANSFER_TOPIC);
    expect(SETTLEMENT_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('decodeWatchedLog', () => {
  it('reads back what the encoder wrote, including the largest uint256', () => {
    for (const value of [0n, 1n, 10_000_000_000n, MAX_UINT256]) {
      const out = decodeWatchedLog(logOf(usdx.address, encodeTransferLog(alice, bob, value)), 31337, usdx);
      expect(out.type).toBe('event');
      if (out.type !== 'event') return;
      const args = out.event.args as Erc20TransferArgs;
      expect(args).toEqual({ from: alice, to: bob, value });
      expect(out.event.amount).toBe(value);
      expect(out.event.kind).toBe('erc20_transfer');
      expect(out.event.eventId).toBe(`31337:${H(0xb0)}:${H(0x7a)}:2`);
    }
  });

  it('decodes the custom SettlementRecorded event', () => {
    const settlementId = H(0x5e);
    const out = decodeWatchedLog(logOf(settle.address, encodeSettlementLog(settlementId, bob, 25_000_050n, 2)), 31337, settle);
    expect(out.type).toBe('event');
    if (out.type !== 'event') return;
    expect(out.event.args as SettlementArgs).toEqual({ settlementId, beneficiary: bob, amount: 25_000_050n, status: 2 });
    expect(out.event.amount).toBe(25_000_050n);
  });

  it('ignores other events from a watched contract (e.g. Approval) instead of guessing', () => {
    const approval = logOf(usdx.address, { topics: [H(0xa9), H(1), H(2)], data: H(5) });
    expect(decodeWatchedLog(approval, 31337, usdx).type).toBe('ignored');
    expect(decodeWatchedLog(logOf(usdx.address, { topics: [], data: '0x' }), 31337, usdx).type).toBe('ignored');
  });

  it('flags an ERC-721-shaped Transfer (same selector, 4 topics, no data) as undecodable rather than inventing a value', () => {
    const nft = logOf(usdx.address, { topics: [TRANSFER_TOPIC, H(1), H(2), H(99)], data: '0x' });
    const out = decodeWatchedLog(nft, 31337, usdx);
    expect(out.type).toBe('undecodable');
  });

  it('flags truncated data as undecodable', () => {
    const bad = logOf(usdx.address, { topics: encodeTransferLog(alice, bob, 1n).topics, data: '0x1234' });
    expect(decodeWatchedLog(bad, 31337, usdx).type).toBe('undecodable');
  });

  it('gives identical payload hashes to identical logs and different hashes to different ones', () => {
    const a = decodeWatchedLog(logOf(usdx.address, encodeTransferLog(alice, bob, 5n)), 31337, usdx);
    const b = decodeWatchedLog(logOf(usdx.address, encodeTransferLog(alice, bob, 5n)), 31337, usdx);
    const c = decodeWatchedLog(logOf(usdx.address, encodeTransferLog(alice, bob, 6n)), 31337, usdx);
    if (a.type !== 'event' || b.type !== 'event' || c.type !== 'event') throw new Error('expected events');
    expect(a.event.payloadHash).toBe(b.event.payloadHash);
    expect(a.event.payloadHash).not.toBe(c.event.payloadHash);
  });
});
