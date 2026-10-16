import { InjectedCrash } from '../src/observability/failpoints.js';
import { Sandbox } from './harness.js';
import { diffCanonical, EMPTY_DIFF } from './oracle.js';
import type { ScenarioDefinition } from './types.js';

export const s08: ScenarioDefinition = {
  id: 'S08',
  title: 'Restart and replay',
  summary:
    'The scanner process is killed in the middle of ingestion - once just before COMMIT, once just after - and restarted each time. It resumes from the checkpoint stored in PostgreSQL, loses nothing, repeats nothing, and ends in exactly the state of a control run that was never interrupted. A final replay of the whole range then finds nothing to do.',
  fixture:
    'seed "S08", seeded random traffic, 60 blocks, confirmation depth 3, batch size 4 (so 16 batches). A second, identical sandbox ingests the same chain without interruption as the control.',
  faults: [
    'Crash 1: the process dies inside the third batch transaction, immediately before COMMIT.',
    'Crash 2: after restart, the process dies immediately after the COMMIT of the second batch it ran.',
  ],
  expected: [
    'After crash 1 the database contains the first two batches and the checkpoint for them, and no trace of the third.',
    'After crash 2 the committed batch and its checkpoint are durable.',
    'Each restart logs and records the checkpoint it resumed from.',
    'The final state is identical to the uninterrupted control run: same events, statuses, totals, alerts, notifications and blocks.',
  ],
  acceptance: 'All canonical events are recovered with no gaps and no duplicate effects.',
  requires: ['postgres'],
  sandbox: { seed: 'S08', traffic: 'random', confirmationDepth: 3, batchSize: 4 },
  checks: [
    { id: 'crash-before-commit-leaves-no-partial-batch', description: 'After a crash before COMMIT the checkpoint is at the end of the last committed batch and no block or event beyond it is stored.' },
    { id: 'crash-after-commit-keeps-committed-batch', description: 'After a crash right after COMMIT the batch and its checkpoint are durable, and the stored events are exactly the fixture\'s up to that block.' },
    { id: 'resume-from-durable-checkpoint', description: 'Each restart resumed from the checkpoint stored in PostgreSQL (7, then 15) and recorded it.' },
    { id: 'final-state-equals-uninterrupted-run', description: 'The final logical state is byte-for-byte the same as a control run that was never interrupted.' },
    { id: 'no-gaps-no-duplicate-effects', description: 'Canonical blocks are contiguous 0-60, stored events equal the fixture\'s, and no event was ever written twice.' },
    { id: 'replay-after-restart-adds-nothing', description: 'Replaying blocks 0-60 after the restarts inserts nothing and changes nothing.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;

    ctx.stage('fixture', 'Deterministic fixture chain (seed "S08"): 60 blocks of seeded traffic.');
    sb.chain.mine(60);
    const expected = sb.chain.expectedEvents();
    ctx.note('events the fixture emitted', { events: expected.length, highValue: expected.filter((e) => e.highValue).length });

    ctx.stage('baseline', 'Control run: an identical sandbox ingests the same chain without interruption.');
    const control = await Sandbox.create(sb.options);
    let controlFingerprint: string;
    try {
      control.chain.mine(60);
      await control.scanner.scanOnce('startup');
      controlFingerprint = await control.fingerprint();
    } finally {
      await control.destroy();
    }

    ctx.stage('fault', 'Crash 1: the process dies inside the third batch transaction, just before COMMIT.');
    sb.crash.arm('scanner.before_commit', { afterHits: 2 });
    const first = await sb.scanner.scanOnce('startup').then(
      () => 'no crash',
      (err: unknown) => (err instanceof InjectedCrash ? err.point : String(err)),
    );
    const afterFirst = await sb.checkpoint();
    const storedAfterFirst = {
      crash: first,
      checkpoint: afterFirst.number,
      highestStoredBlock: Math.max(...(await sb.canonicalBlocks()).map((b) => b.number)),
      highestStoredEventBlock: Math.max(0, ...(await sb.events()).map((e) => e.blockNumber)),
    };

    ctx.stage('problem', 'What survived: the first two batches and their checkpoint; nothing of the third.');
    ctx.note('database after crash 1', storedAfterFirst);
    ctx.check(
      'crash-before-commit-leaves-no-partial-batch',
      { crash: storedAfterFirst.crash, checkpoint: storedAfterFirst.checkpoint, highestStoredBlock: storedAfterFirst.highestStoredBlock, noEventsBeyondCheckpoint: storedAfterFirst.highestStoredEventBlock <= afterFirst.number },
      { crash: 'scanner.before_commit', checkpoint: 7, highestStoredBlock: 7, noEventsBeyondCheckpoint: true },
    );

    ctx.stage('recovery', 'Restart 1: a new scanner resumes from the checkpoint, then crashes right after the COMMIT of its second batch.');
    sb.crash.arm('scanner.after_commit', { afterHits: 1 });
    const second = await sb.newScanner().scanOnce('startup').then(
      () => 'no crash',
      (err: unknown) => (err instanceof InjectedCrash ? err.point : String(err)),
    );
    const afterSecond = await sb.checkpoint();
    const upTo15 = [...Array(16).keys()].map((n) => sb.chain.blockAt(n)!);
    ctx.check(
      'crash-after-commit-keeps-committed-batch',
      {
        crash: second,
        checkpoint: afterSecond.number,
        highestStoredBlock: Math.max(...(await sb.canonicalBlocks()).map((b) => b.number)),
        eventsMatchFixtureUpToCheckpoint: diffCanonical(await sb.events(), sb.chain.expectedEvents(upTo15)),
      },
      { crash: 'scanner.after_commit', checkpoint: 15, highestStoredBlock: 15, eventsMatchFixtureUpToCheckpoint: EMPTY_DIFF },
    );

    ctx.stage('recovery', 'Restart 2: a third scanner resumes from the checkpoint and finishes.');
    const finish = await sb.newScanner().scanOnce('startup');
    ctx.note('final scan', { outcome: finish.outcome, blocksIngested: finish.blocksIngested });

    const { rows: resumes } = await sb.db.query<{ details: { checkpoint: { number: number } } }>(
      "SELECT details FROM recovery_log WHERE kind = 'resume' ORDER BY id",
    );
    ctx.table('Recovery log (resume entries)', resumes.map((r) => ({ resumedFromCheckpoint: r.details.checkpoint.number })));
    ctx.check(
      'resume-from-durable-checkpoint',
      { resumedFrom: resumes.map((r) => r.details.checkpoint.number), logLines: sb.logs.count('scanner.resume') },
      { resumedFrom: [7, 15], logLines: 2 },
    );

    ctx.stage('final', 'Comparing with the uninterrupted control run.');
    const finalFingerprint = await sb.fingerprint();
    ctx.check('final-state-equals-uninterrupted-run', finalFingerprint === controlFingerprint, true);

    const events = await sb.events();
    const blocks = (await sb.canonicalBlocks()).map((b) => b.number);
    ctx.check(
      'no-gaps-no-duplicate-effects',
      {
        contiguousBlocks: blocks.join(',') === [...Array(61).keys()].join(','),
        diff: diffCanonical(events, sb.chain.expectedEvents()),
        everyEventWrittenOnce: events.every((e) => e.seenCount === 1),
        duplicateAuditRows: await sb.count('event_audit', "action = 'duplicate_sighting'"),
      },
      { contiguousBlocks: true, diff: EMPTY_DIFF, everyEventWrittenOnce: true, duplicateAuditRows: 0 },
    );

    const replay = await sb.newScanner().replayRange(0, 60);
    ctx.check(
      'replay-after-restart-adds-nothing',
      { inserted: replay.eventsInserted, unchanged: (await sb.fingerprint()) === finalFingerprint },
      { inserted: 0, unchanged: true },
    );
    ctx.note('final state', await sb.snapshot());
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
  },
};
