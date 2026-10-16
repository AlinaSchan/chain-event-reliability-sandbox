import { MAX_UINT256, formatUnits } from '../src/domain/units.js';
import { buildWatchIndex, WatchlistError } from '../src/domain/watchlist.js';
import type { BlockSpec, ScriptedLog } from '../src/fixtures/chain.js';
import { block, transferUnits, tx } from './builders.js';
import { expectedFlows } from './oracle.js';
import type { ScenarioDefinition } from './types.js';

interface Case {
  token: 'USDX' | 'WRAPX' | 'GOLDX' | 'SETTLE';
  label: string;
  units: bigint;
  alert: boolean;
}

// Written out by hand from the thresholds in the watchlist, not computed by the code under test.
//   USDX   6 decimals  threshold 10,000        = 10_000_000_000 units
//   WRAPX 18 decimals  threshold 5             = 5_000_000_000_000_000_000 units
//   GOLDX  0 decimals  threshold 100           = 100 units
//   SETTLE 2 decimals  threshold 250,000.50    = 25_000_050 units
const CASES: Case[] = [
  { token: 'USDX', label: 'threshold - 1 unit', units: 9_999_999_999n, alert: false },
  { token: 'USDX', label: 'exactly the threshold', units: 10_000_000_000n, alert: true },
  { token: 'USDX', label: 'threshold + 1 unit', units: 10_000_000_001n, alert: true },
  { token: 'USDX', label: 'zero-value transfer', units: 0n, alert: false },
  { token: 'WRAPX', label: 'threshold - 1 wei', units: 4_999_999_999_999_999_999n, alert: false },
  { token: 'WRAPX', label: 'exactly the threshold', units: 5_000_000_000_000_000_000n, alert: true },
  { token: 'WRAPX', label: 'threshold + 1 wei', units: 5_000_000_000_000_000_001n, alert: true },
  { token: 'WRAPX', label: 'one wei', units: 1n, alert: false },
  { token: 'GOLDX', label: '99 (0 decimals)', units: 99n, alert: false },
  { token: 'GOLDX', label: '100', units: 100n, alert: true },
  { token: 'GOLDX', label: '101', units: 101n, alert: true },
  { token: 'GOLDX', label: '2^53 + 1', units: 9_007_199_254_740_993n, alert: true },
  { token: 'GOLDX', label: 'largest uint256', units: MAX_UINT256, alert: true },
  { token: 'SETTLE', label: '250000.49', units: 25_000_049n, alert: false },
  { token: 'SETTLE', label: '250000.50', units: 25_000_050n, alert: true },
  { token: 'SETTLE', label: '250000.51', units: 25_000_051n, alert: true },
];

const logFor = (c: Case): ScriptedLog =>
  c.token === 'SETTLE'
    ? { kind: 'settlement_recorded', contract: 'SETTLE', beneficiary: 'erin', amount: c.units, status: 1 }
    : transferUnits(c.token, 'alice', 'bob', c.units);

export const s09: ScenarioDefinition = {
  id: 'S09',
  title: 'Value thresholds and token decimals',
  summary:
    'High-value detection compares integers in base units. Thresholds are written in whole token units and converted with each token\'s own decimals; amounts and sums above 2^53 (and up to uint256) stay exact. The boundary of every threshold - one unit below, exactly on, one unit above - is classified correctly, and a threshold that would need rounding is rejected at configuration time.',
  fixture:
    'seed "S09", scripted traffic. 16 events across four tokens with 0, 2, 6 and 18 decimals, each placed one base unit below, on, or above its threshold, plus zero-value, 2^53+1 and uint256-max amounts. No USD values: there is no price oracle.',
  faults: [
    'Amounts that a floating-point comparison cannot tell apart (WRAPX threshold +/- 1 wei, GOLDX 2^53+1).',
    'Thresholds in the configuration that cannot be represented exactly.',
  ],
  expected: [
    'Every case is classified exactly: inclusive at the threshold, off by one unit either side.',
    'Alerts store the threshold in base units of their own token.',
    'Totals stay exact beyond 2^53 and beyond uint256.',
    'Inexact or malformed thresholds are rejected before anything runs.',
  ],
  acceptance: 'Exact integer comparisons, no floating-point errors.',
  requires: ['postgres'],
  sandbox: { seed: 'S09', traffic: 'scripted', confirmationDepth: 2, batchSize: 8 },
  checks: [
    { id: 'every-boundary-case-classified-exactly', description: 'Each of the 16 cases has an open alert exactly when its amount is at or above its token\'s threshold.' },
    { id: 'thresholds-stored-in-base-units-per-token', description: 'The alerts carry 100, 10000000000, 25000050 and 5000000000000000000 as thresholds - one per token, in that token\'s base units.' },
    { id: 'totals-exact-above-2^53-and-uint256', description: 'Account totals equal an independent bigint fold, including a sum that exceeds uint256.' },
    { id: 'float-comparison-would-misclassify', description: 'The WRAPX threshold - 1 wei case is misclassified by a Number comparison and classified correctly by the integer one.' },
    { id: 'config-rejects-inexact-thresholds', description: 'Thresholds with too many fractional digits, exponents, signs or zero value are rejected with an explanation; nothing is rounded.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;

    ctx.stage('fixture', 'Deterministic fixture chain (seed "S09"): one boundary case per block.');
    const specs: BlockSpec[] = CASES.map((c) => block(tx(logFor(c))));
    sb.chain.mine(CASES.length, specs);
    sb.chain.mine(3);
    ctx.table(
      'Watchlist thresholds',
      sb.watch.entries.map((w) => ({ token: w.symbol, decimals: w.decimals, threshold: w.highValueThreshold, thresholdUnits: w.thresholdUnits })),
    );

    ctx.stage('baseline', 'The scanner ingests all 16 cases.');
    await sb.scanner.scanOnce('startup');

    ctx.stage('problem', 'Comparing what the pipeline decided with what was written down in advance.');
    const events = await sb.events();
    const { rows: alertRows } = await sb.db.query<{ event_id: string; status: string; threshold_units: string }>(
      'SELECT event_id, status, threshold_units::text AS threshold_units FROM alerts',
    );
    const alertByEvent = new Map(alertRows.map((a) => [a.event_id, a]));
    const table = CASES.map((c, i) => {
      const event = events.find((e) => e.blockNumber === i + 1);
      const alert = event ? alertByEvent.get(event.eventId) : undefined;
      const actual = alert?.status === 'open';
      const watch = sb.watch.entries.find((w) => w.symbol === c.token);
      return {
        token: c.token,
        case: c.label,
        amount: watch ? formatUnits(c.units, watch.decimals) : c.units.toString(),
        amountUnits: c.units.toString(),
        expectedAlert: c.alert,
        actualAlert: actual,
        ok: actual === c.alert,
      };
    });
    ctx.table('Boundary cases', table);
    ctx.check(
      'every-boundary-case-classified-exactly',
      { stored: events.length, wrong: table.filter((r) => !r.ok).map((r) => `${r.token} ${r.case}`) },
      { stored: CASES.length, wrong: [] },
    );
    ctx.check(
      'thresholds-stored-in-base-units-per-token',
      [...new Set(alertRows.map((a) => a.threshold_units))].sort(),
      ['100', '10000000000', '25000050', '5000000000000000000'],
    );
    ctx.check('totals-exact-above-2^53-and-uint256', await sb.flows(), expectedFlows(sb.chain.expectedEvents()));

    ctx.stage('recovery', 'Why integers: the same comparison in floating point.');
    const below = 4_999_999_999_999_999_999n;
    const threshold = 5_000_000_000_000_000_000n;
    const demo = { numberComparisonSaysAtOrAbove: Number(below) >= Number(threshold), integerComparisonSaysAtOrAbove: below >= threshold };
    ctx.note('WRAPX threshold - 1 wei', demo);
    ctx.check('float-comparison-would-misclassify', demo, { numberComparisonSaysAtOrAbove: true, integerComparisonSaysAtOrAbove: false });

    ctx.stage('final', 'Configuration is validated before it can influence a comparison.');
    const bad = [
      { label: 'USDX threshold with 7 fractional digits', threshold: '10000.0000001', decimals: 6 },
      { label: 'exponent notation', threshold: '1e4', decimals: 6 },
      { label: 'negative', threshold: '-5', decimals: 6 },
      { label: 'zero', threshold: '0', decimals: 6 },
      { label: 'fraction on a 0-decimal token', threshold: '0.5', decimals: 0 },
      { label: 'leading zeros', threshold: '007', decimals: 0 },
    ];
    const outcomes = bad.map((b) => {
      try {
        buildWatchIndex([{ address: `0x${'1'.repeat(40)}`, kind: 'erc20_transfer', symbol: 'BAD', decimals: b.decimals, highValueThreshold: b.threshold }]);
        return { case: b.label, rejected: false, because: '' };
      } catch (err) {
        return { case: b.label, rejected: err instanceof WatchlistError, because: err instanceof WatchlistError ? (err.problems[0] ?? '').replace(/^entry 0 \(BAD\): /, '') : String(err) };
      }
    });
    ctx.table('Rejected configurations', outcomes);
    ctx.check('config-rejects-inexact-thresholds', outcomes.map((o) => o.rejected), bad.map(() => true));
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
  },
};
