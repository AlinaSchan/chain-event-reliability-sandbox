import { parseUnits } from '../src/domain/units.js';
import { FIXTURE_WATCHLIST } from '../src/fixtures/accounts.js';
import type { BlockSpec, FixtureChain, ScriptedLog, ScriptedTx } from '../src/fixtures/chain.js';

/** Small helpers for scripting exactly which events appear in which block. */

const DECIMALS = new Map(FIXTURE_WATCHLIST.map((w) => [w.symbol, w.decimals]));

/** `amount('USDX', '20000')` -> base units, using the fixture token's decimals. */
export function amount(symbol: string, human: string): bigint {
  const decimals = DECIMALS.get(symbol);
  if (decimals === undefined) throw new Error(`unknown fixture token ${symbol}`);
  return parseUnits(human, decimals);
}

export function transfer(symbol: string, from: string, to: string, human: string): ScriptedLog {
  return { kind: 'erc20_transfer', token: symbol, from, to, value: amount(symbol, human) };
}

export function transferUnits(symbol: string, from: string, to: string, baseUnits: bigint): ScriptedLog {
  return { kind: 'erc20_transfer', token: symbol, from, to, value: baseUnits };
}

export function settlement(beneficiary: string, human: string, status = 1): ScriptedLog {
  return { kind: 'settlement_recorded', contract: 'SETTLE', beneficiary, amount: amount('SETTLE', human), status };
}

export function tx(logs: ScriptedLog[] | ScriptedLog, label?: string): ScriptedTx {
  const list = Array.isArray(logs) ? logs : [logs];
  return label === undefined ? { logs: list } : { label, logs: list };
}

export function block(...txs: ScriptedTx[]): BlockSpec {
  return { txs };
}

/**
 * Mines blocks 1..max(plan) on the chain; `plan[n]` scripts block n, unlisted blocks are empty.
 * Returns the chain for chaining.
 */
export function minePlan(chain: FixtureChain, plan: Record<number, BlockSpec>, through?: number): FixtureChain {
  const last = through ?? Math.max(...Object.keys(plan).map(Number));
  const specs: Array<BlockSpec | undefined> = [];
  for (let n = chain.head.number + 1; n <= last; n++) specs.push(plan[n]);
  chain.mine(last - chain.head.number, specs);
  return chain;
}
