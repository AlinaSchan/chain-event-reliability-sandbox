import { InjectedCrash } from '../src/observability/failpoints.js';
import { block, minePlan, transfer, tx } from './builders.js';
import type { ScenarioDefinition } from './types.js';

const PLAN = {
  3: block(tx(transfer('USDX', 'alice', 'bob', '20000'))),
  4: block(tx(transfer('GOLDX', 'alice', 'dave', '150'))),
  10: block(tx(transfer('USDX', 'erin', 'alice', '30000'))),
  16: block(tx(transfer('WRAPX', 'bob', 'carol', '9'))),
};

export const s07: ScenarioDefinition = {
  id: 'S07',
  title: 'Outbox delivery failure',
  summary:
    'Redis is unreachable when the database has already committed; the consumer is not running while messages pile up; the publisher dies after Redis accepted a message but before the row was marked; and Redis loses the stream outright. In every case the transactional outbox in PostgreSQL either completes the delivery or shows exactly what is blocked, and no notification takes effect twice.',
  fixture:
    'seed "S07", scripted traffic, real Redis Streams. High-value events: USDX 20,000 (block 3), GOLDX 150 (4), USDX 30,000 (10), WRAPX 9 (16). Confirmation depth 2, scanned in four waves.',
  faults: [
    'Redis unreachable (connection refused) when the first two notifications are published.',
    'Consumer not running while the first two messages wait in the stream.',
    'Publisher crashes after XADD succeeded and before the outbox row was marked published.',
    'The stream and its consumer group are deleted from Redis after the fourth notification was published (restart without persistence).',
  ],
  expected: [
    'Unreachable Redis leaves rows pending with the error recorded - a visible blocking state - and chain state is untouched.',
    'Messages wait in the stream; once a consumer starts it drains them.',
    'The crashed publisher\'s row is published again; the duplicate in the stream has no second effect.',
    'Rows that were published but produced no effect are re-queued from PostgreSQL and delivered.',
  ],
  acceptance: 'Durable records restore delivery without repeating a logical effect.',
  evidence: [
    'outbox.status, last_error, publish_attempts, republish_count, duplicate_deliveries (GET /events/:id -> notifications)',
    'recovery_log row kind=outbox_requeue; log events outbox.publish_failed, outbox.requeued',
    'Redis stream length versus notification_sink row count',
  ],
  requires: ['postgres', 'redis'],
  sandbox: { seed: 'S07', traffic: 'scripted', confirmationDepth: 2, batchSize: 5 },
  checks: [
    { id: 'redis-down-leaves-outbox-pending-with-error', description: 'With Redis unreachable the rows stay pending, the error is recorded on them, and the confirmed events are unaffected.' },
    { id: 'consumer-down-messages-wait-then-drain', description: 'With no consumer the messages wait in Redis and nothing is delivered; once a consumer runs, every waiting message is delivered once.' },
    { id: 'publisher-crash-duplicate-has-no-second-effect', description: 'After a publisher crash between XADD and marking, the stream holds a duplicate but the sink has one delivery for the notification.' },
    { id: 'redis-data-loss-repaired-from-outbox', description: 'After Redis loses the stream, published-but-unprocessed rows are visible, get re-queued from PostgreSQL, and are delivered.' },
    { id: 'every-notification-delivered-exactly-once', description: 'Four notifications, four processed outbox rows, four sink rows, each notification once.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;
    const queue = sb.redisQueue();
    // republishAfterMs 0: any row still `published` without an effect when the reconciler runs counts as stale.
    const publisher = sb.publisher(queue, { republishAfterMs: 0 });

    ctx.stage('fixture', 'Deterministic fixture chain (seed "S07") and a real Redis Streams queue under a private key prefix.');
    minePlan(sb.chain, PLAN, 9);
    await sb.scanner.scanOnce('startup');
    ctx.note('two confirmed high-value events, two outbox rows', (await sb.outbox()).map((o) => o.status));

    ctx.stage('fault', 'Redis is unreachable at the moment the publisher tries to deliver. PostgreSQL has already committed the events and the outbox rows.');
    const unreachable = sb.publisher(sb.unreachableRedisQueue());
    const failed = await unreachable.publishPending();

    ctx.stage('problem', 'Nothing was lost and nothing was delivered; the blocking state is explicit.');
    const stuck = await sb.outbox();
    ctx.table('Outbox while Redis is unreachable', stuck.map((o) => ({ status: o.status, attempts: o.attempts, lastError: (o.lastError ?? '').slice(0, 70) })));
    ctx.check(
      'redis-down-leaves-outbox-pending-with-error',
      {
        statuses: stuck.map((o) => o.status),
        errorRecorded: stuck.some((o) => (o.lastError ?? '').includes('Redis not ready')),
        publishReportedError: failed.error !== undefined,
        confirmedEvents: (await sb.counts()).confirmed,
      },
      { statuses: ['pending', 'pending'], errorRecorded: true, publishReportedError: true, confirmedEvents: 2 },
    );

    ctx.stage('recovery', 'Redis is reachable again. The publisher delivers both rows; the consumer is still down, so the messages wait.');
    await publisher.publishPending();
    const waiting = { streamLength: await queue.length(), sinkRows: await sb.sinkCount(), outbox: (await sb.outbox()).map((o) => o.status) };
    ctx.note('with no consumer running', waiting);
    const drained = await sb.consumer(queue, 'worker-1').processBatch();
    ctx.check(
      'consumer-down-messages-wait-then-drain',
      { waiting, delivered: drained.delivered, sinkRowsAfter: await sb.sinkCount(), pendingAfter: (await queue.pending()).count },
      { waiting: { streamLength: 2, sinkRows: 0, outbox: ['published', 'published'] }, delivered: 2, sinkRowsAfter: 2, pendingAfter: 0 },
    );

    ctx.stage('fault', 'A third notification is ready. The publisher dies after Redis accepted the message and before the row was marked.');
    minePlan(sb.chain, PLAN, 15);
    await sb.scanner.scanOnce('poll');
    sb.crash.arm('publisher.after_publish_before_mark');
    let publisherCrashed = false;
    try {
      await publisher.publishPending();
    } catch (err) {
      publisherCrashed = err instanceof InjectedCrash;
    }
    const afterCrash = { publisherCrashed, streamLength: await queue.length(), rowStatus: (await sb.outbox()).at(-1)?.status };
    ctx.note('after the publisher crash', afterCrash);

    ctx.stage('recovery', 'A restarted publisher sees the row still pending and publishes it again. The stream now holds a duplicate.');
    await publisher.publishPending();
    const duplicated = await queue.length();
    const settled = await sb.consumer(queue, 'worker-1').processBatch();
    ctx.check(
      'publisher-crash-duplicate-has-no-second-effect',
      {
        afterCrash,
        streamLengthAfterRepublish: duplicated,
        received: settled.received,
        delivered: settled.delivered,
        duplicates: settled.duplicates,
        sinkRows: await sb.sinkCount(),
      },
      {
        afterCrash: { publisherCrashed: true, streamLength: 3, rowStatus: 'pending' },
        streamLengthAfterRepublish: 4,
        received: 2,
        delivered: 1,
        duplicates: 1,
        sinkRows: 3,
      },
    );

    ctx.stage('fault', 'A fourth notification is published; then Redis loses the stream and its consumer group before any consumer saw it.');
    minePlan(sb.chain, PLAN, 21);
    await sb.scanner.scanOnce('poll');
    await publisher.publishPending();
    await sb.deleteRedisStream();
    const lost = await sb.consumer(queue, 'worker-1').processBatch();

    ctx.stage('problem', 'The consumer finds nothing. The outbox shows the row as published with no effect - Redis\'s memory is not the source of truth.');
    const limbo = (await sb.outbox()).at(-1);
    ctx.note('after Redis lost the stream', { consumerReceived: lost.received, rowStatus: limbo?.status, sinkRows: await sb.sinkCount() });

    ctx.stage('recovery', 'The reconciler re-queues rows that were published but never produced an effect; the publisher and consumer finish the job.');
    const requeued = await publisher.requeueStale();
    await publisher.publishPending();
    const repaired = await sb.consumer(queue, 'worker-1').processBatch();
    ctx.check(
      'redis-data-loss-repaired-from-outbox',
      {
        consumerReceivedAfterLoss: lost.received,
        rowStatusAfterLoss: limbo?.status,
        requeued,
        deliveredAfterRepair: repaired.delivered,
        recoveryLogEntries: await sb.count('recovery_log', "kind = 'outbox_requeue'"),
      },
      { consumerReceivedAfterLoss: 0, rowStatusAfterLoss: 'published', requeued: 1, deliveredAfterRepair: 1, recoveryLogEntries: 1 },
    );

    ctx.stage('final', 'Four notifications, each delivered once.');
    const outbox = await sb.outbox();
    ctx.table('Outbox', outbox.map((o) => ({ status: o.status, attempts: o.attempts, republished: o.republished, duplicateDeliveries: o.duplicates })));
    const { rows: sink } = await sb.db.query<{ n: number }>('SELECT count(*)::int AS n FROM notification_sink GROUP BY notification_id');
    ctx.check(
      'every-notification-delivered-exactly-once',
      { notifications: outbox.length, allProcessed: outbox.every((o) => o.status === 'processed'), sinkRowsPerNotification: sink.map((r) => r.n) },
      { notifications: 4, allProcessed: true, sinkRowsPerNotification: [1, 1, 1, 1] },
    );
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
  },
};
