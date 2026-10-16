import type { ExpectedEvent } from '../src/fixtures/chain.js';
import type { EventView } from './harness.js';

/**
 * The independent side of every comparison. It is computed from what the fixture chain itself recorded
 * (`ExpectedEvent`), never from the scanner, the decoder or the database, so a bug in those cannot
 * make the expected value drift along with the actual one.
 */

export interface Flow {
  token: string;
  account: string;
  inbound: bigint;
  outbound: bigint;
}

export function expectedFlows(events: readonly ExpectedEvent[]): Flow[] {
  const map = new Map<string, Flow>();
  const bump = (token: string, account: string, inbound: bigint, outbound: bigint) => {
    const key = `${token}|${account}`;
    const flow = map.get(key) ?? { token, account, inbound: 0n, outbound: 0n };
    flow.inbound += inbound;
    flow.outbound += outbound;
    map.set(key, flow);
  };
  for (const e of events) {
    if (e.meta.kind !== 'erc20_transfer') continue;
    bump(e.contract, e.meta.from, 0n, e.meta.value);
    bump(e.contract, e.meta.to, e.meta.value, 0n);
  }
  return [...map.values()]
    .filter((f) => f.inbound !== 0n || f.outbound !== 0n)
    .sort((a, b) => (a.token + a.account).localeCompare(b.token + b.account));
}

export interface EventDiff {
  missing: string[];
  unexpected: string[];
  mismatched: string[];
}

/** Compares the non-orphaned stored events with the fixture's canonical events. All three lists empty = identical. */
export function diffCanonical(stored: readonly EventView[], expected: readonly ExpectedEvent[]): EventDiff {
  const canonical = stored.filter((e) => e.status !== 'orphaned');
  const want = new Map(expected.map((e) => [e.eventId, e]));
  const have = new Map(canonical.map((e) => [e.eventId, e]));
  const missing = [...want.keys()].filter((id) => !have.has(id));
  const unexpected = [...have.keys()].filter((id) => !want.has(id));
  const mismatched = canonical
    .filter((e) => {
      const truth = want.get(e.eventId);
      return truth !== undefined && (truth.amount !== e.amount || truth.kind !== e.kind || truth.blockNumber !== e.blockNumber);
    })
    .map((e) => e.eventId);
  return { missing, unexpected, mismatched };
}

export const EMPTY_DIFF: EventDiff = { missing: [], unexpected: [], mismatched: [] };

export function highValueCount(expected: readonly ExpectedEvent[]): number {
  return expected.filter((e) => e.highValue).length;
}
