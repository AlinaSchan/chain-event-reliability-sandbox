import { ScannerWorker } from '../src/ingestion/worker.js';
import { block, minePlan, transfer, tx } from './builders.js';
import { diffCanonical, EMPTY_DIFF, expectedFlows, highValueCount } from './oracle.js';
import type { ScenarioDefinition } from './types.js';

const PLAN = {
  2: block(tx(transfer('USDX', 'alice', 'bob', '20000'))),
  // Two logs from ONE transaction: two distinct events that must both survive deduplication.
  3: block(tx([transfer('USDX', 'bob', 'carol', '15000'), transfer('GOLDX', 'alice', 'dave', '150')])),
  4: block(tx(transfer('WRAPX', 'carol', 'erin', '7'))),
};

export const s02: ScenarioDefinition = {
  id: 'S02',
  title: 'Duplicate delivery',
  summary:
    'The same events reach the system many times over: the provider returns every log twice, the notifier repeats each head, an already-processed range is replayed, and two scanners race on the same blocks. Event identity (chain, block hash, transaction hash, log index) and a unique constraint make all of it collapse into one logical effect, with the repeats on the audit trail.',
  fixture:
    'seed "S02", scripted traffic, 8 blocks. USDX 20,000 (block 2); USDX 15,000 and GOLDX 150 from one transaction (block 3); WRAPX 7 (block 4). All four are high-value. Confirmation depth 2.',
  faults: [
    'getLogs returns every log twice for the whole run.',
    'The notifier delivers each head notification several times.',
    'Two scanners ingest the same blocks at the same time.',
    'The processed range 0-8 is replayed three times.',
  ],
  expected: [
    'Four events, one row each; the two logs of the shared transaction stay two events.',
    'Derived totals equal the fold over those four events, not twice that.',
    'One alert and one confirmed-notification outbox row per event.',
    'Every repeat sighting is recorded; replays change no logical effect.',
  ],
  acceptance: 'One logical effect and a correct audit trail.',
  requires: ['postgres'],
  sandbox: { seed: 'S02', traffic: 'scripted', confirmationDepth: 2, batchSize: 3 },
  checks: [
    { id: 'one-row-per-event-identity', description: 'Stored events equal the fixture\'s four events exactly; the shared-transaction logs are two events; no identity appears twice.' },
    { id: 'derived-totals-not-doubled', description: 'account_flows equals an independent fold over the four events.' },
    { id: 'one-alert-and-one-notification-each', description: 'Open alerts and confirmation outbox rows equal the number of high-value events.' },
    { id: 'repeat-sightings-are-audited', description: 'Each event was seen more than once, and the repeats are recorded as duplicate_sighting audit rows.' },
    { id: 'concurrent-writers-apply-each-block-once', description: 'Two scanners racing on one database ingested every block exactly once between them.' },
    { id: 'replay-adds-nothing', description: 'Three replays of the processed range insert nothing and leave the logical state byte-for-byte unchanged.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;
    ctx.stage('fixture', 'Deterministic fixture chain created (seed "S02"): 8 blocks, four high-value events.');
    minePlan(sb.chain, PLAN, 8);
    const expected = sb.chain.expectedEvents();

    ctx.stage('fault', 'Duplicate deliveries are switched on: duplicated logs from the provider, two scanners racing, repeated head notifications.');
    sb.provider.faults.add({ method: 'getLogs', action: 'duplicate_logs', times: 10_000 });

    ctx.stage('baseline', 'Two scanners ingest the chain at the same time while every log arrives twice.');
    const reports = await Promise.all([sb.newScanner().scanOnce('startup'), sb.newScanner().scanOnce('startup')]);
    ctx.check(
      'concurrent-writers-apply-each-block-once',
      reports.reduce((sum, r) => sum + r.blocksIngested, 0),
      sb.chain.head.number + 1,
    );

    // Then the notifier repeats itself while new blocks arrive.
    const worker = new ScannerWorker({ scanner: sb.scanner, notifier: sb.notifier, logger: sb.logs.logger() }, { pollIntervalMs: 0, errorBackoffMs: 0 });
    worker.start();
    await worker.idle();
    sb.notifier.duplicateNext(3);
    sb.chain.mine(3);
    await worker.idle();
    await worker.stop();
    ctx.record('headNotificationsDelivered', sb.notifier.stats.delivered);
    ctx.record('headNotificationsDuplicated', sb.notifier.stats.duplicated);

    ctx.stage('problem', 'What the database now holds, after every kind of repeat.');
    ctx.table('Canonical events', await ctx.eventRows());
    const events = await sb.events();
    const { rows: dupAudit } = await sb.db.query<{ n: number }>("SELECT count(*)::int AS n FROM event_audit WHERE action = 'duplicate_sighting'");
    ctx.table(
      'Sightings per event',
      events.map((e) => ({ event: `block ${e.blockNumber} log ${e.logIndex}`, seenCount: e.seenCount, status: e.status })),
    );

    const finalExpected = sb.chain.expectedEvents();
    ctx.check('one-row-per-event-identity', { diff: diffCanonical(events, finalExpected), rows: events.length, expectedRows: expected.length }, { diff: EMPTY_DIFF, rows: 4, expectedRows: 4 });
    ctx.check('derived-totals-not-doubled', await sb.flows(), expectedFlows(finalExpected));
    ctx.check(
      'one-alert-and-one-notification-each',
      { openAlerts: (await sb.alerts()).open, confirmationNotifications: await sb.count('outbox', "notification_type = 'event_confirmed'") },
      { openAlerts: highValueCount(finalExpected), confirmationNotifications: highValueCount(finalExpected) },
    );
    ctx.check(
      'repeat-sightings-are-audited',
      { everyEventSeenAgain: events.every((e) => e.seenCount >= 2), duplicateAuditRows: (dupAudit[0]?.n ?? 0) >= events.length },
      { everyEventSeenAgain: true, duplicateAuditRows: true },
    );

    ctx.stage('recovery', 'The already-processed range 0-11 is replayed three times by fresh scanners.');
    const settled = await sb.fingerprint();
    const replays = [];
    for (let i = 0; i < 3; i++) replays.push(await sb.newScanner().replayRange(0, sb.chain.head.number));
    ctx.check(
      'replay-adds-nothing',
      { inserted: replays.map((r) => r.eventsInserted), unchanged: (await sb.fingerprint()) === settled },
      { inserted: [0, 0, 0], unchanged: true },
    );

    ctx.stage('final', 'Final state: one logical effect per event.');
    ctx.note('final state', await sb.snapshot());
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
  },
};
