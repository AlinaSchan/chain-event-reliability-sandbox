import type { BlockSpec } from '../src/fixtures/chain.js';
import { block, transfer, tx } from './builders.js';
import type { ScenarioDefinition } from './types.js';

const HIGH = transfer('USDX', 'alice', 'bob', '20000');
const LOW = transfer('USDX', 'bob', 'carol', '10');
const PLAN: Record<number, BlockSpec> = { 5: block(tx(HIGH)), 6: block(tx(LOW)) };

export const s06: ScenarioDefinition = {
  id: 'S06',
  title: 'Delayed confirmations',
  summary:
    'New events are provisional. They become confirmed only when the configured number of blocks sits on top of them, measured against the durable checkpoint - not against the provider\'s head and not against the clock. A high-value event queues its downstream notification at that moment and not one block earlier.',
  fixture:
    'seed "S06", scripted traffic. USDX 20,000 (high-value) in block 5, USDX 10 (low-value) in block 6. Confirmation depth 4. The head advances one block at a time.',
  faults: [
    'The head advances slowly, one block per scan, so every depth is observed.',
    'The head stalls: the scanner is polled ten times with nothing new.',
    'The provider races ahead by 20 blocks but every call to it fails.',
  ],
  expected: [
    'Both events stay provisional until exactly four blocks sit on top of their block.',
    'The notification for the high-value event is queued at that block and not before; the low-value event never queues one.',
    'Polling a stalled head never confirms anything.',
    'A provider that is ahead but unreachable does not confirm anything either.',
  ],
  acceptance: 'The status changes only when the configured depth is reached.',
  requires: ['postgres'],
  sandbox: { seed: 'S06', traffic: 'scripted', confirmationDepth: 4, batchSize: 3 },
  checks: [
    { id: 'provisional-until-depth', description: 'At heads 5-8 the high-value event is provisional and no notification exists.' },
    { id: 'confirmed-at-exact-depth', description: 'At head 9 (four blocks on top of block 5) the high-value event is confirmed and exactly one notification is queued; the low-value event is confirmed at head 10 and queues none.' },
    { id: 'no-time-based-confirmation', description: 'Ten polls of a stalled head change no event status.' },
    { id: 'depth-from-checkpoint-not-provider-head', description: 'With the provider 20 blocks ahead but unreachable, events stay provisional until the checkpoint itself reaches the depth.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;
    ctx.stage('fixture', 'Deterministic fixture chain (seed "S06"). Confirmation depth 4: an event is confirmed when 4 blocks sit on top of its block.');

    ctx.stage('baseline', 'The head advances one block at a time; the scanner runs after each block.');
    const trace: Array<{ head: number; highValue: string; lowValue: string; notificationsQueued: number }> = [];
    for (let head = 5; head <= 10; head++) {
      while (sb.chain.head.number < head) sb.chain.mineOne(PLAN[sb.chain.head.number + 1]);
      await sb.scanner.scanOnce('notification');
      const events = await sb.events();
      trace.push({
        head,
        highValue: events.find((e) => e.blockNumber === 5)?.status ?? '-',
        lowValue: events.find((e) => e.blockNumber === 6)?.status ?? '-',
        notificationsQueued: await sb.count('outbox'),
      });
    }
    ctx.table('Event status as the head advances (high-value event is in block 5, low-value in block 6)', trace);

    ctx.stage('problem', 'Before the depth is reached the events are provisional and must not be announced.');
    ctx.check(
      'provisional-until-depth',
      trace.filter((t) => t.head <= 8).map((t) => ({ head: t.head, highValue: t.highValue, queued: t.notificationsQueued })),
      [5, 6, 7, 8].map((head) => ({ head, highValue: 'provisional', queued: 0 })),
    );

    ctx.stage('recovery', 'At head 9 the depth is reached for block 5; at head 10 for block 6.');
    ctx.check(
      'confirmed-at-exact-depth',
      trace.filter((t) => t.head >= 9).map((t) => ({ head: t.head, highValue: t.highValue, lowValue: t.lowValue, queued: t.notificationsQueued })),
      [
        { head: 9, highValue: 'confirmed', lowValue: 'provisional', queued: 1 },
        { head: 10, highValue: 'confirmed', lowValue: 'confirmed', queued: 1 },
      ],
    );

    ctx.stage('fault', 'A stalled head: the scanner is polled ten times and nothing changes on the chain.');
    sb.chain.mine(1, [block(tx(transfer('GOLDX', 'erin', 'alice', '150')))]); // block 11: a new high-value event
    await sb.scanner.scanOnce('notification');
    const before = await sb.fingerprint();
    for (let i = 0; i < 10; i++) await sb.scanner.scanOnce('poll');
    ctx.check(
      'no-time-based-confirmation',
      { unchanged: (await sb.fingerprint()) === before, newEventStatus: (await sb.events()).find((e) => e.blockNumber === 11)?.status },
      { unchanged: true, newEventStatus: 'provisional' },
    );

    ctx.stage('fault', 'The provider races 20 blocks ahead, but every call to it fails.');
    sb.chain.mine(20);
    sb.provider.faults.add({ method: '*', action: 'timeout', times: 100_000 });
    const outage = await sb.scanner.scanOnce('poll');
    ctx.note('during the outage', { outcome: outage.outcome, checkpoint: (await sb.checkpoint()).number, providerHead: sb.chain.head.number });
    const during = (await sb.events()).find((e) => e.blockNumber === 11)?.status;
    sb.provider.faults.clear();
    await sb.scanner.scanOnce('poll');
    const after = (await sb.events()).find((e) => e.blockNumber === 11)?.status;
    ctx.check(
      'depth-from-checkpoint-not-provider-head',
      { outcome: outage.outcome, statusDuringOutage: during, statusAfterCheckpointCaughtUp: after },
      { outcome: 'rpc_failed', statusDuringOutage: 'provisional', statusAfterCheckpointCaughtUp: 'confirmed' },
    );

    ctx.stage('final', 'Final state.');
    ctx.note('final state', await sb.snapshot());
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
  },
};
