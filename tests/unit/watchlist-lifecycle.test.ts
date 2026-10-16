import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, highestConfirmableBlock, isConfirmable } from '../../src/domain/lifecycle.js';
import type { EventStatus, LifecycleState } from '../../src/domain/types.js';
import { buildWatchIndex, WatchlistError, type WatchEntry } from '../../src/domain/watchlist.js';
import { FIXTURE_WATCHLIST } from '../../src/fixtures/accounts.js';

const entry = (over: Partial<WatchEntry> = {}): WatchEntry => ({
  address: '0x' + '1'.repeat(40),
  kind: 'erc20_transfer',
  symbol: 'TST',
  decimals: 6,
  highValueThreshold: '1000',
  ...over,
});

describe('buildWatchIndex', () => {
  it('converts thresholds to base units with each token\'s own decimals', () => {
    const index = buildWatchIndex(FIXTURE_WATCHLIST);
    const by = Object.fromEntries(index.entries.map((e) => [e.symbol, e.thresholdUnits]));
    expect(by).toEqual({
      USDX: 10_000_000_000n, // 10000 * 10^6
      WRAPX: 5_000_000_000_000_000_000n, // 5 * 10^18
      GOLDX: 100n, // 0 decimals
      SETTLE: 25_000_050n, // 250000.50 * 10^2
    });
  });

  it('lowercases addresses and indexes them', () => {
    const index = buildWatchIndex([entry({ address: '0x' + 'AB'.repeat(20) })]);
    expect(index.addresses).toEqual(['0x' + 'ab'.repeat(20)]);
    expect(index.byAddress.get(('0x' + 'ab'.repeat(20)) as `0x${string}`)?.symbol).toBe('TST');
  });

  it('reports every problem at once instead of stopping at the first', () => {
    let error: unknown;
    try {
      buildWatchIndex([
        entry({ address: 'nope' }),
        entry({ symbol: '' }),
        entry({ highValueThreshold: '1.0000001' }), // 7 fractional digits, 6 decimals
        entry({ highValueThreshold: '0' }),
        entry({ decimals: 99 }),
      ]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WatchlistError);
    expect((error as WatchlistError).problems.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects duplicate addresses', () => {
    expect(() => buildWatchIndex([entry(), entry({ symbol: 'TWO' })])).toThrow(/duplicate address/);
  });
});

describe('lifecycle', () => {
  const STATES: LifecycleState[] = ['observed', 'provisional', 'confirmed', 'orphaned'];
  const TARGETS: EventStatus[] = ['provisional', 'confirmed', 'orphaned'];

  it('allows exactly the documented transitions', () => {
    const allowed = new Set([
      'observed>provisional',
      'provisional>confirmed',
      'provisional>orphaned',
      'confirmed>orphaned',
      'orphaned>provisional', // the block came back
    ]);
    for (const from of STATES) {
      for (const to of TARGETS) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('throws on an illegal transition', () => {
    expect(() => assertTransition('confirmed', 'provisional')).toThrow(/illegal/);
    expect(() => assertTransition('orphaned', 'confirmed')).toThrow(/illegal/);
  });

  it('confirms an event only when `depth` blocks sit on top of its block', () => {
    // event in block 10, depth 3: confirmed from checkpoint 13, not at 12
    expect(isConfirmable(10, 12, 3)).toBe(false);
    expect(isConfirmable(10, 13, 3)).toBe(true);
    expect(isConfirmable(10, 14, 3)).toBe(true);
    expect(highestConfirmableBlock(13, 3)).toBe(10);
  });
});
