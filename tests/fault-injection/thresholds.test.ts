import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_UINT256 } from '../../src/domain/units.js';
import { block, settlement, transferUnits, tx } from '../../scenarios/builders.js';
import { Sandbox } from '../../scenarios/harness.js';
import { expectedFlows } from '../../scenarios/oracle.js';
import type { BlockSpec, ScriptedLog } from '../../src/fixtures/chain.js';
import { amount } from '../../scenarios/builders.js';

/**
 * Thresholds are written in whole token units and compared in base units as integers. Every case below
 * sits on, or one base unit either side of, a threshold for a token with different decimals. Expected
 * values are written out by hand, not computed with the code under test.
 */

interface Case {
  label: string;
  log: ScriptedLog;
  alert: boolean;
}

const usdx = (units: bigint) => transferUnits('USDX', 'alice', 'bob', units); // 6 decimals, threshold 10,000 = 10_000_000_000
const wrapx = (units: bigint) => transferUnits('WRAPX', 'alice', 'bob', units); // 18 decimals, threshold 5 = 5e18
const goldx = (units: bigint) => transferUnits('GOLDX', 'alice', 'bob', units); // 0 decimals, threshold 100
const settle = (units: bigint): ScriptedLog => ({ kind: 'settlement_recorded', contract: 'SETTLE', beneficiary: 'erin', amount: units, status: 1 }); // 2 decimals, threshold 250000.50 = 25_000_050

const CASES: Case[] = [
  { label: 'USDX threshold - 1 unit', log: usdx(9_999_999_999n), alert: false },
  { label: 'USDX exactly the threshold', log: usdx(10_000_000_000n), alert: true },
  { label: 'USDX threshold + 1 unit', log: usdx(10_000_000_001n), alert: true },
  { label: 'USDX zero-value transfer', log: usdx(0n), alert: false },
  { label: 'USDX one base unit', log: usdx(1n), alert: false },
  { label: 'USDX 10,000 expressed through the helper', log: { kind: 'erc20_transfer', token: 'USDX', from: 'alice', to: 'bob', value: amount('USDX', '10000') }, alert: true },
  // 5e18 is far beyond 2^53: a Number comparison cannot tell these three apart.
  { label: 'WRAPX threshold - 1 wei', log: wrapx(4_999_999_999_999_999_999n), alert: false },
  { label: 'WRAPX exactly the threshold', log: wrapx(5_000_000_000_000_000_000n), alert: true },
  { label: 'WRAPX threshold + 1 wei', log: wrapx(5_000_000_000_000_000_001n), alert: true },
  { label: 'WRAPX 0.000000000000000001', log: wrapx(1n), alert: false },
  { label: 'GOLDX 99 (0 decimals)', log: goldx(99n), alert: false },
  { label: 'GOLDX 100', log: goldx(100n), alert: true },
  { label: 'GOLDX 101', log: goldx(101n), alert: true },
  { label: 'GOLDX 2^53 + 1 (not representable as a double)', log: goldx(9_007_199_254_740_993n), alert: true },
  { label: 'GOLDX largest uint256', log: goldx(MAX_UINT256), alert: true },
  { label: 'SETTLE threshold - 1 unit (250000.49)', log: settle(25_000_049n), alert: false },
  { label: 'SETTLE exactly 250000.50', log: settle(25_000_050n), alert: true },
  { label: 'SETTLE threshold + 1 unit (250000.51)', log: settle(25_000_051n), alert: true },
  { label: 'SETTLE through the helper', log: settlement('erin', '250000.50'), alert: true },
  { label: 'SETTLE through the helper, one cent below', log: settlement('erin', '250000.49'), alert: false },
];

describe('high-value threshold boundaries with different token decimals', () => {
  let sb: Sandbox;
  beforeAll(async () => {
    sb = await Sandbox.create({ confirmationDepth: 2, batchSize: 7 });
    const specs: BlockSpec[] = CASES.map((c) => block(tx(c.log)));
    sb.chain.mine(CASES.length, specs); // case i lives in block i + 1
    sb.chain.mine(3);
    await sb.scanner.scanOnce('startup');
  });
  afterAll(async () => sb.destroy());

  it('ingests every boundary case', async () => {
    expect((await sb.events()).length).toBe(CASES.length);
  });

  it.each(CASES.map((c, i) => [c.label, i, c.alert] as const))('%s -> alert: %s', async (_label, index, expected) => {
    const event = (await sb.events()).find((e) => e.blockNumber === index + 1)!;
    const { rows } = await sb.db.query<{ status: string }>('SELECT status FROM alerts WHERE event_id = $1', [event.eventId]);
    expect(rows.map((r) => r.status)).toEqual(expected ? ['open'] : []);
  });

  it('stores the threshold each alert was judged against, in base units of that token', async () => {
    const { rows } = await sb.db.query<{ contract_address: string; threshold_units: string }>(
      'SELECT DISTINCT contract_address, threshold_units::text AS threshold_units FROM alerts ORDER BY threshold_units',
    );
    expect(rows.map((r) => r.threshold_units).sort()).toEqual(['100', '10000000000', '25000050', '5000000000000000000'].sort());
  });

  it('keeps totals exact even where a sum exceeds uint256 or 2^53', async () => {
    const expected = expectedFlows(sb.chain.expectedEvents());
    expect(await sb.flows()).toEqual(expected);
    const goldxBob = expected.find((f) => f.account.length === 42 && f.inbound > MAX_UINT256);
    expect(goldxBob?.inbound).toBe(MAX_UINT256 + 9_007_199_254_740_993n + 99n + 100n + 101n); // all GOLDX transfers into bob
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('shows why integers are required: the WRAPX boundary is invisible to floating point', () => {
    const below = 4_999_999_999_999_999_999n;
    const threshold = 5_000_000_000_000_000_000n;
    expect(Number(below) >= Number(threshold)).toBe(true); // the float comparison gets this wrong
    expect(below >= threshold).toBe(false); // the bigint comparison does not
  });
});
