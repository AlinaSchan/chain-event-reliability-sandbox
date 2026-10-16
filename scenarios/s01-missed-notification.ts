import { ScannerWorker } from '../src/ingestion/worker.js';
import { block, minePlan, settlement, transfer, tx } from './builders.js';
import { diffCanonical, EMPTY_DIFF } from './oracle.js';
import type { ScenarioDefinition } from './types.js';

const PLAN = {
  3: block(tx(transfer('USDX', 'alice', 'bob', '20000'))),
  12: block(tx(settlement('erin', '300000'))),
  17: block(tx(transfer('GOLDX', 'alice', 'dave', '150'))),
  25: block(tx(transfer('WRAPX', 'carol', 'erin', '6'))),
  26: block(tx(transfer('USDX', 'bob', 'carol', '10'))),
  28: block(tx(transfer('USDX', 'dave', 'erin', '50000'))),
  31: block(tx(transfer('GOLDX', 'bob', 'alice', '99'))),
};

export const s01: ScenarioDefinition = {
  id: 'S01',
  title: 'Missed notification',
  summary:
    'The head-notification stream drops while blocks keep arriving. The notification is only a hint, so when the connection returns the scanner compares the provider head with its durable checkpoint and backfills the whole gap from stored state. A second outage with no reconnect is caught by the safety-net poll.',
  fixture:
    'seed "S01", scripted traffic, 32 blocks. Events: USDX 20,000 (block 3), SETTLE 300,000 (12), GOLDX 150 (17), WRAPX 6 (25), USDX 10 (26), USDX 50,000 (28), GOLDX 99 (31). Confirmation depth 3, batch size 5.',
  faults: [
    'The notifier disconnects after block 9. Blocks 10-29 are mined while it is down; their notifications are lost (not buffered, not replayed).',
    'A second outage with no reconnect: blocks 30-32 arrive and nothing tells the worker.',
  ],
  expected: [
    'While disconnected the checkpoint stays at 9 and the stored events are a strict subset of the canonical ones - the gap is real and observable.',
    'On reconnect the worker triggers a scan, finds head 29 vs checkpoint 9, and backfills 10-29 from the provider by block range.',
    'The backfill is recorded in recovery_log and in the structured log.',
    'With no reconnect at all, the periodic poll alone brings the checkpoint to the head.',
  ],
  acceptance: 'Range backfill recovers all canonical events in the test range.',
  requires: ['postgres'],
  sandbox: { seed: 'S01', traffic: 'scripted', confirmationDepth: 3, batchSize: 5 },
  checks: [
    { id: 'gap-opens-while-disconnected', description: 'With notifications lost, the checkpoint stays behind the provider head and canonical events are missing from the database.' },
    { id: 'reconnect-triggers-reconciliation', description: 'The scan that closed the gap was triggered by the reconnect, not by a notification carrying data.' },
    { id: 'all-canonical-events-recovered', description: 'After backfill the stored canonical events equal the fixture\'s: none missing, none extra, amounts and blocks identical.' },
    { id: 'checkpoint-equals-provider-head', description: 'The checkpoint is at the provider head with the head\'s hash.' },
    { id: 'backfill-recorded-as-evidence', description: 'recovery_log has a backfill entry for blocks 10-29 and the log has a backfill.range line.' },
    { id: 'poll-recovers-without-any-notification', description: 'With the notifier down and no reconnect, a poll alone ingests the remaining blocks and their events.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;
    const worker = new ScannerWorker(
      { scanner: sb.scanner, notifier: sb.notifier, logger: sb.logs.logger() },
      { pollIntervalMs: 0, errorBackoffMs: 0 },
    );

    ctx.stage('fixture', 'Deterministic fixture chain created (seed "S01"); worker subscribed to the fixture notifier.');
    worker.start();

    ctx.stage('baseline', 'Notifier connected. Blocks 1-9 are mined; each head notification triggers a scan.');
    minePlan(sb.chain, PLAN, 9);
    await worker.idle();
    ctx.table('Canonical events stored after baseline', await ctx.eventRows());
    ctx.note('baseline state', await sb.snapshot());

    ctx.stage('fault', 'The notifier connection drops. Blocks 10-29 are mined; none of their notifications arrive.');
    sb.notifier.disconnect();
    minePlan(sb.chain, PLAN, 29);
    await worker.idle();
    ctx.record('notificationsDroppedByTheFixture', sb.notifier.stats.dropped);

    ctx.stage('problem', 'The database is behind and nothing has told the worker.');
    const during = await sb.checkpoint();
    const missing = diffCanonical(await sb.events(), sb.chain.expectedEvents()).missing;
    ctx.note(`checkpoint ${during.number}, provider head ${sb.chain.head.number}, ${missing.length} canonical event(s) not in the database`);
    ctx.check(
      'gap-opens-while-disconnected',
      { checkpoint: during.number, providerHead: sb.chain.head.number, canonicalEventsMissing: missing.length > 0 },
      { checkpoint: 9, providerHead: 29, canonicalEventsMissing: true },
    );

    ctx.stage('recovery', 'The notifier reconnects. The worker reconciles against stored state and backfills the range by block number.');
    sb.notifier.reconnect();
    await worker.idle();
    ctx.check('reconnect-triggers-reconciliation', worker.status().lastCycle?.trigger, 'reconnect');

    const after = await sb.checkpoint();
    ctx.check('checkpoint-equals-provider-head', { number: after.number, hash: after.hash }, { number: sb.chain.head.number, hash: sb.chain.head.hash });
    ctx.check('all-canonical-events-recovered', diffCanonical(await sb.events(), sb.chain.expectedEvents()), EMPTY_DIFF);
    const { rows: backfills } = await sb.db.query<{ from_block: number; to_block: number }>(
      "SELECT from_block, to_block FROM recovery_log WHERE kind = 'backfill' ORDER BY id",
    );
    ctx.check(
      'backfill-recorded-as-evidence',
      { recoveryLog: backfills.at(-1), logLines: sb.logs.events('backfill.range').length > 0 },
      { recoveryLog: { from_block: 10, to_block: 29 }, logLines: true },
    );
    ctx.table('Recovery log', backfills);
    ctx.table('Canonical events stored after backfill', await ctx.eventRows());

    ctx.stage('final', 'A second outage with no reconnect: blocks 30-32 are mined and only the poll can notice.');
    sb.notifier.disconnect();
    minePlan(sb.chain, PLAN, 32);
    await worker.idle();
    const stuck = (await sb.checkpoint()).number;
    worker.trigger('poll');
    await worker.idle();
    const polled = await sb.checkpoint();
    ctx.record('checkpointBeforePoll', stuck);
    ctx.check(
      'poll-recovers-without-any-notification',
      { before: stuck, after: polled.number, eventsComplete: diffCanonical(await sb.events(), sb.chain.expectedEvents()) },
      { before: 29, after: 32, eventsComplete: EMPTY_DIFF },
    );
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
    await worker.stop();
  },
};
