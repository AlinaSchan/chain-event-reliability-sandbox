import { InjectedCrash } from '../src/observability/failpoints.js';
import { block, minePlan, transfer, tx } from './builders.js';
import type { ScenarioDefinition } from './types.js';

const PLAN = {
  3: block(tx(transfer('USDX', 'alice', 'bob', '20000'))),
  4: block(tx(transfer('GOLDX', 'alice', 'dave', '150'))),
  10: block(tx(transfer('USDX', 'erin', 'alice', '12000'))),
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const s03: ScenarioDefinition = {
  id: 'S03',
  title: 'Crash after database commit, before Redis ACK',
  summary:
    'A consumer commits a notification\'s effect to PostgreSQL and dies before sending XACK. Redis still lists the message as pending, so it comes back - to the restarted consumer, or to another one after the idle time. The outbox row is already settled, so the redelivery is recognised and only acknowledged: the notification is delivered exactly once in effect.',
  fixture:
    'seed "S03", scripted traffic, real Redis Streams. USDX 20,000 (block 3) and GOLDX 150 (block 4) are confirmed by head 9; USDX 12,000 (block 10) by head 15. Confirmation depth 2.',
  faults: [
    'Phase 1: consumer "worker-1" crashes after committing the first effect and before XACK (it had also received the second message).',
    'Phase 2: consumer "worker-1" crashes the same way for a later notification and never comes back; "worker-2" must take it over.',
  ],
  expected: [
    'After the crash the sink has the first delivery and Redis shows both messages unacknowledged.',
    'A restarted worker-1 sees its own pending messages first: the committed one is acknowledged as a duplicate, the other is delivered.',
    'After the idle time worker-2 claims the abandoned message (XAUTOCLAIM), recognises it and acknowledges it.',
    'Nothing is delivered twice; nothing is left pending.',
  ],
  acceptance: 'A restart does not double the processing.',
  requires: ['postgres', 'redis'],
  sandbox: { seed: 'S03', traffic: 'scripted', confirmationDepth: 2, batchSize: 5 },
  checks: [
    { id: 'effect-committed-before-crash', description: 'At the moment of the crash the first effect is durable in PostgreSQL while Redis still holds both messages as unacknowledged.' },
    { id: 'restart-does-not-double-process', description: 'The restarted consumer delivers the second notification once, only acknowledges the first, and the sink has exactly two rows.' },
    { id: 'duplicate-recognised-from-the-database', description: 'The redelivered message was recognised as a duplicate from the outbox row, and nothing remains pending in Redis.' },
    { id: 'takeover-by-another-consumer-after-idle', description: 'A different consumer claims the abandoned message only after the idle time and settles it as a duplicate.' },
    { id: 'exactly-one-delivery-per-notification', description: 'Every notification has exactly one sink row and one processed outbox row.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;
    const queue = sb.redisQueue();
    const publisher = sb.publisher(queue);

    ctx.stage('fixture', 'Deterministic fixture chain (seed "S03") and a real Redis Streams queue under a private key prefix.');
    minePlan(sb.chain, PLAN, 9);
    await sb.scanner.scanOnce('startup');

    ctx.stage('baseline', 'Two high-value events are confirmed, so two outbox rows exist; the publisher moves them into the Redis stream.');
    const published = await publisher.publishPending();
    ctx.note('publisher', published);
    ctx.note('state', await sb.snapshot());

    ctx.stage('fault', 'Consumer "worker-1" handles the first message: the sink row is committed, then the process dies before XACK.');
    sb.crash.arm('consumer.after_effect_before_ack');
    let crashed = false;
    try {
      await sb.consumer(queue, 'worker-1').processBatch();
    } catch (err) {
      crashed = err instanceof InjectedCrash;
    }

    ctx.stage('problem', 'Redis believes nothing was processed; PostgreSQL knows one delivery happened.');
    const atCrash = { crashed, sinkRows: await sb.sinkCount(), unacknowledged: (await queue.pending()).count };
    ctx.note('state at the moment of the crash', atCrash);
    ctx.check('effect-committed-before-crash', atCrash, { crashed: true, sinkRows: 1, unacknowledged: 2 });

    ctx.stage('recovery', 'worker-1 restarts under the same name; its own pending messages come first.');
    const restarted = await sb.consumer(queue, 'worker-1').processBatch();
    ctx.note('restarted consumer', restarted);
    ctx.check(
      'restart-does-not-double-process',
      { sinkRows: await sb.sinkCount(), delivered: restarted.delivered, duplicates: restarted.duplicates, acked: restarted.acked },
      { sinkRows: 2, delivered: 1, duplicates: 1, acked: 2 },
    );
    ctx.check(
      'duplicate-recognised-from-the-database',
      { duplicateDeliveriesRecorded: (await sb.outbox()).reduce((n, o) => n + o.duplicates, 0), stillPendingInRedis: (await queue.pending()).count },
      { duplicateDeliveriesRecorded: 1, stillPendingInRedis: 0 },
    );

    ctx.stage('fault', 'A later notification arrives. worker-1 crashes the same way and is gone for good.');
    minePlan(sb.chain, PLAN, 15);
    await sb.scanner.scanOnce('poll');
    await publisher.publishPending();
    sb.crash.arm('consumer.after_effect_before_ack');
    await sb.consumer(queue, 'worker-1', { claimIdleMs: 400 }).processBatch().catch(() => undefined);
    const abandoned = (await queue.pending()).count;
    ctx.note('abandoned message(s) in worker-1\'s pending list', abandoned);

    ctx.stage('recovery', 'worker-2 starts. It must not steal a fresh message, but takes it over once it has been idle long enough.');
    const tooSoon = await sb.consumer(queue, 'worker-2', { claimIdleMs: 400 }).processBatch();
    await sleep(600);
    const takeover = await sb.consumer(queue, 'worker-2', { claimIdleMs: 400 }).processBatch();
    ctx.note('worker-2 before the idle time', tooSoon);
    ctx.note('worker-2 after the idle time', takeover);
    ctx.check(
      'takeover-by-another-consumer-after-idle',
      { abandoned, receivedTooSoon: tooSoon.received, receivedAfterIdle: takeover.received, duplicates: takeover.duplicates, acked: takeover.acked, pendingAfter: (await queue.pending()).count },
      { abandoned: 1, receivedTooSoon: 0, receivedAfterIdle: 1, duplicates: 1, acked: 1, pendingAfter: 0 },
    );

    ctx.stage('final', 'Three notifications, three deliveries, nothing pending.');
    const outbox = await sb.outbox();
    ctx.table('Outbox', outbox.map((o) => ({ notification: `${o.notificationId.split('#')[0]?.slice(2, 12)}…#${o.notificationId.split('#').pop()}`, status: o.status, duplicateDeliveries: o.duplicates })));
    const { rows: sink } = await sb.db.query<{ n: number }>('SELECT count(*)::int AS n FROM notification_sink GROUP BY notification_id');
    ctx.check(
      'exactly-one-delivery-per-notification',
      { notifications: outbox.length, allProcessed: outbox.every((o) => o.status === 'processed'), sinkRowsPerNotification: sink.map((r) => r.n) },
      { notifications: 3, allProcessed: true, sinkRowsPerNotification: [1, 1, 1] },
    );
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
  },
};
