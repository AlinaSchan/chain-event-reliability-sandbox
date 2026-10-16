import { block, transfer, tx } from './builders.js';
import { diffCanonical, EMPTY_DIFF } from './oracle.js';
import type { ScenarioDefinition } from './types.js';

export const s05: ScenarioDefinition = {
  id: 'S05',
  title: 'RPC timeouts and bad responses',
  summary:
    'The provider times out, errors for good, answers from a stale cache, lags behind the checkpoint, and returns logs that belong to a branch its own headers no longer describe. Retries are bounded; nothing is skipped; the checkpoint only ever moves together with committed data; a response that does not fit the chain is refused rather than written.',
  fixture:
    'seed "S05", seeded random traffic (about one event per block), 20 blocks first, then waves of 12, 2 and 5 more. Confirmation depth 3, batch size 5, up to 4 attempts per operation starting at 100 ms and doubling.',
  faults: [
    'getLogs times out three times in a row on the first range; a getHeader call fails twice in the second batch.',
    'getLogs starts failing permanently after the first batch of a wave (retries run out).',
    'getHead answers with a cached older response once, and lags three blocks behind once.',
    'getLogs answers from a cache that predates a reorganization of the requested range.',
  ],
  expected: [
    'Transient errors are retried with doubling delays and then succeed; no block is skipped.',
    'When retries run out the cycle ends without writing beyond the last committed batch, the status becomes degraded, and the next healthy cycle recovers.',
    'A stale or lagging head neither moves the checkpoint backwards nor looks like a reorganization.',
    'Logs that do not belong to the headers\' blocks are rejected (INCONSISTENT) and fetched again; nothing from the wrong branch is stored.',
  ],
  acceptance: 'Retry does not skip blocks or leave an incorrect checkpoint.',
  requires: ['postgres'],
  sandbox: { seed: 'S05', traffic: 'random', confirmationDepth: 3, batchSize: 5, retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 2_000 } },
  checks: [
    { id: 'transient-errors-retried-with-bounded-backoff', description: 'Five injected transient errors cost exactly five retries with delays 100, 200, 400 ms and 100, 200 ms, and the scan completes.' },
    { id: 'no-block-skipped-and-no-gap', description: 'Canonical blocks are contiguous from genesis to the head and the stored events equal the fixture\'s.' },
    { id: 'checkpoint-never-ahead-of-committed-data', description: 'When retries run out, the checkpoint stops at the last fully committed batch, nothing beyond it is stored, and the status is degraded.' },
    { id: 'degraded-then-recovered', description: 'Once the provider answers again the same checkpoint continues to the head and the status returns to ok.' },
    { id: 'stale-and-lagging-heads-ignored', description: 'A stale head and a lagging head leave the checkpoint where it was and report no reorganization.' },
    { id: 'inconsistent-response-rejected-then-retried', description: 'Logs from the pre-reorg cache are rejected as INCONSISTENT, retried, and nothing from the old branch is stored - not even as orphaned.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;

    ctx.stage('fixture', 'Deterministic fixture chain (seed "S05"), 20 blocks of seeded traffic.');
    sb.chain.mine(20);

    ctx.stage('fault', 'The first range fails three times with a timeout; a header call in the second batch fails twice with a 503.');
    sb.provider.faults
      .add({ method: 'getLogs', action: 'timeout', times: 3 })
      .add({ method: 'getHeader', action: 'server_error', times: 2, skip: 22 });

    ctx.stage('recovery', 'The scanner retries with bounded exponential back-off.');
    const first = await sb.scanner.scanOnce('startup');
    ctx.record('retryDelaysMs', sb.sleeps);
    ctx.note('retry delays (ms)', sb.sleeps);
    ctx.check(
      'transient-errors-retried-with-bounded-backoff',
      { outcome: first.outcome, retries: first.retries, delaysMs: [...sb.sleeps], faultsFired: sb.provider.faults.fired.length },
      { outcome: 'caught_up', retries: 5, delaysMs: [100, 200, 400, 100, 200], faultsFired: 5 },
    );
    const blocks = (await sb.canonicalBlocks()).map((b) => b.number);
    ctx.check(
      'no-block-skipped-and-no-gap',
      { contiguous: blocks.join(',') === [...Array(21).keys()].join(','), diff: diffCanonical(await sb.events(), sb.chain.expectedEvents()) },
      { contiguous: true, diff: EMPTY_DIFF },
    );
    ctx.table('Canonical events', (await ctx.eventRows()).slice(0, 12));

    ctx.stage('fault', 'Twelve more blocks arrive; after the first batch every getLogs call fails and the retries run out.');
    sb.chain.mine(12);
    sb.provider.faults.add({ method: 'getLogs', action: 'server_error', times: 100_000, skip: 1 });
    const failed = await sb.scanner.scanOnce('poll');

    ctx.stage('problem', 'The cycle gave up. The checkpoint must not have moved past committed data.');
    const cp = await sb.checkpoint();
    const stored = await sb.events();
    ctx.note('after retries ran out', { outcome: failed.outcome, error: failed.error, checkpoint: cp.number, status: cp.status });
    ctx.check(
      'checkpoint-never-ahead-of-committed-data',
      {
        outcome: failed.outcome,
        checkpoint: cp.number,
        status: cp.status,
        eventsBeyondCheckpoint: stored.filter((e) => e.blockNumber > cp.number).length,
        blocksBeyondCheckpoint: (await sb.canonicalBlocks()).filter((b) => b.number > cp.number).length,
      },
      { outcome: 'rpc_failed', checkpoint: 25, status: 'degraded', eventsBeyondCheckpoint: 0, blocksBeyondCheckpoint: 0 },
    );

    ctx.stage('recovery', 'The provider recovers. The next cycle resumes from the stored checkpoint.');
    sb.provider.faults.clear();
    const recovered = await sb.scanner.scanOnce('poll');
    const after = await sb.checkpoint();
    ctx.check(
      'degraded-then-recovered',
      { outcome: recovered.outcome, checkpoint: after.number, status: after.status, diff: diffCanonical(await sb.events(), sb.chain.expectedEvents()), recoveredLogged: sb.logs.count('scanner.recovered') },
      { outcome: 'caught_up', checkpoint: 32, status: 'ok', diff: EMPTY_DIFF, recoveredLogged: 1 },
    );

    ctx.stage('fault', 'Two blocks arrive. The provider answers getHead with an old cached response once, then with a head three blocks behind.');
    sb.chain.mine(2);
    sb.provider.faults.add({ method: 'getHead', action: 'stale', times: 1 });
    const stale = await sb.scanner.scanOnce('poll');
    sb.provider.faults.add({ method: 'getHead', action: 'lagging', times: 1, lagBlocks: 3 });
    const lagging = await sb.scanner.scanOnce('poll');
    ctx.check(
      'stale-and-lagging-heads-ignored',
      {
        staleOutcome: stale.outcome,
        laggingOutcome: lagging.outcome,
        reorgs: stale.reorgs + lagging.reorgs,
        checkpointAfter: (await sb.checkpoint()).number,
      },
      { staleOutcome: 'caught_up', laggingOutcome: 'provider_behind', reorgs: 0, checkpointAfter: 32 },
    );
    await sb.scanner.scanOnce('poll'); // healthy: picks the two blocks up

    ctx.stage('fault', 'Five more blocks arrive and get cached by the provider; then the chain reorganizes and getLogs answers from the stale cache.');
    sb.chain.mine(5, [block(tx(transfer('USDX', 'alice', 'bob', '20000')))]); // an event in the first block guarantees the cached answer is not empty
    await sb.provider.getLogs({ fromBlock: 35, toBlock: 39, addresses: sb.watch.addresses }); // the scanner's next range, cached from branch A
    sb.chain.reorg({ depth: 5, replacement: 5, branch: 'B' });
    sb.provider.faults.add({ method: 'getLogs', action: 'stale', times: 1 });
    const inconsistent = await sb.scanner.scanOnce('notification');
    const retry = sb.logs.events('rpc.retry').find((l) => l.code === 'INCONSISTENT');
    ctx.note('refused response', { code: retry?.code, error: retry?.error });
    ctx.check(
      'inconsistent-response-rejected-then-retried',
      {
        outcome: inconsistent.outcome,
        rejectedAsInconsistent: retry !== undefined,
        orphanedRows: (await sb.events()).filter((e) => e.status === 'orphaned').length,
        diff: diffCanonical(await sb.events(), sb.chain.expectedEvents()),
      },
      { outcome: 'caught_up', rejectedAsInconsistent: true, orphanedRows: 0, diff: EMPTY_DIFF },
    );

    ctx.stage('final', 'Provider-error totals and final state.');
    ctx.note('final state', await sb.snapshot());
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
  },
};

