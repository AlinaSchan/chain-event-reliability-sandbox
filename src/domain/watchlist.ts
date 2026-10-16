import type { EventKind, Hex } from './types.js';
import { parseUnits } from './units.js';

/** One watched contract, as written in configuration. Thresholds are in whole token units. */
export interface WatchEntry {
  address: string;
  kind: EventKind;
  symbol: string;
  decimals: number;
  /** Decimal string in whole token units, e.g. "10000" or "0.5". No oracle, no fiat value. */
  highValueThreshold: string;
}

export interface ResolvedWatch {
  address: Hex;
  kind: EventKind;
  symbol: string;
  decimals: number;
  highValueThreshold: string;
  /** `highValueThreshold` converted to base units with integer arithmetic. */
  thresholdUnits: bigint;
}

export interface WatchIndex {
  entries: readonly ResolvedWatch[];
  byAddress: ReadonlyMap<Hex, ResolvedWatch>;
  addresses: Hex[];
}

export class WatchlistError extends Error {
  override readonly name = 'WatchlistError';
  constructor(readonly problems: string[]) {
    super(`invalid watchlist:\n - ${problems.join('\n - ')}`);
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const KINDS: readonly EventKind[] = ['erc20_transfer', 'settlement_recorded'];

/** Validates every entry and reports all problems at once. Nothing is silently rounded or defaulted. */
export function buildWatchIndex(entries: readonly WatchEntry[]): WatchIndex {
  const problems: string[] = [];
  const resolved: ResolvedWatch[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, i) => {
    const where = `entry ${i} (${entry.symbol || 'no symbol'})`;
    if (!ADDRESS_RE.test(entry.address)) {
      problems.push(`${where}: address must be 0x + 40 hex characters`);
      return;
    }
    const address = entry.address.toLowerCase() as Hex;
    if (seen.has(address)) problems.push(`${where}: duplicate address ${address}`);
    seen.add(address);
    if (!KINDS.includes(entry.kind)) problems.push(`${where}: unknown kind ${JSON.stringify(entry.kind)}`);
    if (entry.symbol.length === 0 || entry.symbol.length > 16) problems.push(`${where}: symbol must be 1..16 characters`);

    let thresholdUnits: bigint | undefined;
    try {
      thresholdUnits = parseUnits(entry.highValueThreshold, entry.decimals);
      if (thresholdUnits <= 0n) problems.push(`${where}: highValueThreshold must be greater than zero`);
    } catch (err) {
      problems.push(`${where}: ${(err as Error).message}`);
    }
    if (thresholdUnits !== undefined && thresholdUnits > 0n) {
      resolved.push({ ...entry, address, thresholdUnits });
    }
  });

  if (problems.length > 0) throw new WatchlistError(problems);
  return {
    entries: resolved,
    byAddress: new Map(resolved.map((w) => [w.address, w])),
    addresses: resolved.map((w) => w.address),
  };
}
