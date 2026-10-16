import { afterEach, describe, expect, it } from 'vitest';
import { InjectedCrash } from '../../src/observability/failpoints.js';
import { block, minePlan, transfer, tx } from '../../scenarios/builders.js';
import { Sandbox } from '../../scenarios/harness.js';

/**
 * Publisher and consumer logic against real PostgreSQL, with an in-process queue double (MemoryQueue)
 * so every failure below can be produced exactly. The Redis adapter itself is covered by
 * redis-streams.test.ts against a real Redis server.
 *
 * History (confirmation depth 3): high-value events in blocks 4 and 5 are confirmed at head 10.
 */
const HIGH_A = transfer('USDX', 'alice', 'bob', '20000');
const HIGH_B = transfer('GOLDX', 'alice', 'dave', '150');
const LOW = transfer('USDX', 'bob', 'carol', '10');

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});

async function confirmedSandbox(head = 10): Promise<Sandbox> {
  const sb = await Sandbox.create({ confirmationDepth: 3, batchSize: 5 });
  sandboxes.push(sb);
  minePlan(sb.chain, { 4: block(tx(HIGH_A)), 5: block(tx(HIGH_B)), 6: block(tx(LOW)) }, head);
  await sb.scanner.scanOnce('startup');
  return sb;
}

describe('transactional outbox -> queue -> consumer', () => {
  it('delivers each confirmed high-value event once, with an exact payload, and settles the outbox', async () => {
    const sb = await confirmedSandbox();
    expect((await sb.outbox()).map((o) => o.status)).toEqual(['pending', 'pending']);

    const queue = sb.memoryQueue();
    expect(await sb.publisher(queue).publishPending()).toMatchObject({ selected: 2, published: 2 });
    const report = await sb.consumer(queue).processBatch();

    expect(report).toMatchObject({ received: 2, delivered: 2, duplicates: 0, acked: 2, failed: 0 });
    expect((await sb.outbox()).map((o) => o.status)).toEqual(['processed', 'processed']);
    expect(await sb.sinkCount()).toBe(2);
    expect((await queue.pending()).count).toBe(0);

    const { rows } = await sb.db.query<{ payload: Record<string, unknown>; event_status_at_delivery: string }>(
      'SELECT payload, event_status_at_delivery FROM notification_sink ORDER BY delivered_at, notification_id',
    );
    const usdx = rows.map((r) => r.payload).find((p) => p.symbol === 'USDX');
    expect(usdx).toMatchObject({
      schema: 'cers.notification.v1',
      type: 'event_confirmed',
      amountUnits: '20000000000',
      amount: '20000',
      thresholdUnits: '10000000000',
      blockNumber: 4,
      confirmationEpoch: 1,
      confirmedAtCheckpoint: 9, // confirmed by the transaction that moved the checkpoint to 9 (batch size 5)
      confirmationDepth: 3,
    });
    expect(rows.every((r) => r.event_status_at_delivery === 'confirmed')).toBe(true);
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('never queues anything for an event that is still provisional', async () => {
    const sb = await confirmedSandbox(5); // head 5: events at 4 and 5 are provisional (depth 3)
    expect((await sb.events()).every((e) => e.status === 'provisional')).toBe(true);
    expect(await sb.outbox()).toEqual([]);
    const queue = sb.memoryQueue();
    expect(await sb.publisher(queue).publishPending()).toMatchObject({ selected: 0, published: 0 });
    expect(queue.size).toBe(0);
    expect(await sb.sinkCount()).toBe(0);
  });
});

describe('the database committed, the queue is unavailable', () => {
  it('leaves the rows pending with the error recorded, loses nothing, and delivers once the queue is back', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    queue.down = true;

    const publisher = sb.publisher(queue);
    const failed = await publisher.publishPending();
    expect(failed).toMatchObject({ selected: 2, published: 0 });
    expect(failed.error).toMatch(/queue unavailable/);
    const stuck = await sb.outbox();
    expect(stuck.map((o) => o.status)).toEqual(['pending', 'pending']); // the blocking state is explicit...
    expect(stuck[0]).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/queue unavailable/) as string });
    expect((await sb.events()).filter((e) => e.status === 'confirmed')).toHaveLength(3); // ...and chain state is unaffected
    expect((await sb.invariants()).ok).toBe(true);

    queue.down = false;
    expect(await publisher.publishPending()).toMatchObject({ published: 2 });
    await sb.consumer(queue).processBatch();
    expect(await sb.sinkCount()).toBe(2);
    expect((await sb.outbox()).every((o) => o.status === 'processed' && o.lastError === null)).toBe(true);
  });
});

describe('the publisher crashes after the queue accepted a message and before the row was marked', () => {
  it('re-publishes on restart; the duplicate in the stream causes no second effect', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();

    sb.crash.arm('publisher.after_publish_before_mark');
    await expect(sb.publisher(queue).publishPending()).rejects.toBeInstanceOf(InjectedCrash);
    expect(queue.size).toBe(1); // one message is already in the stream...
    expect((await sb.outbox()).map((o) => o.status)).toEqual(['pending', 'pending']); // ...but the database does not know

    expect(await sb.publisher(queue).publishPending()).toMatchObject({ published: 2 });
    expect(queue.size).toBe(3); // 2 notifications, 3 messages: at-least-once, honestly

    const report = await sb.consumer(queue).processBatch();
    expect(report).toMatchObject({ received: 3, delivered: 2, duplicates: 1, acked: 3 });
    expect(await sb.sinkCount()).toBe(2);
    expect((await sb.outbox()).reduce((n, o) => n + o.duplicates, 0)).toBe(1);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

describe('the consumer commits its effect and crashes before acknowledging', () => {
  it('another consumer takes over the abandoned message after the idle time and only acknowledges it', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    await sb.publisher(queue).publishPending();

    sb.crash.arm('consumer.after_effect_before_ack');
    await expect(sb.consumer(queue, 'consumer-A').processBatch()).rejects.toBeInstanceOf(InjectedCrash);
    expect(await sb.sinkCount()).toBe(1); // the first effect is durable
    expect((await queue.pending()).count).toBe(2); // and still unacknowledged (the second was delivered to A, never handled)

    // Too soon: B must not steal a message A may still be working on.
    expect(await sb.consumer(queue, 'consumer-B').processBatch()).toMatchObject({ received: 0 });

    sb.clock.now += 5_000; // A is presumed dead
    const report = await sb.consumer(queue, 'consumer-B').processBatch();
    expect(report).toMatchObject({ received: 2, delivered: 1, duplicates: 1, acked: 2 });
    expect(await sb.sinkCount()).toBe(2);
    expect((await queue.pending()).count).toBe(0);
    expect((await sb.outbox()).reduce((n, o) => n + o.duplicates, 0)).toBe(1);
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('a restarted consumer with the same name sees its own unacknowledged messages first', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    await sb.publisher(queue).publishPending();

    sb.crash.arm('consumer.after_effect_before_ack');
    await expect(sb.consumer(queue, 'worker').processBatch()).rejects.toBeInstanceOf(InjectedCrash);

    const report = await sb.consumer(queue, 'worker').processBatch(); // no clock advance needed
    expect(report).toMatchObject({ delivered: 1, duplicates: 1, acked: 2 });
    expect(await sb.sinkCount()).toBe(2);
  });

  it('an acknowledgement that fails after the effect leaves the message to be redelivered and recognised', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    await sb.publisher(queue).publishPending();
    const realAck = queue.ack.bind(queue);
    queue.ack = () => Promise.reject(new Error('connection reset'));

    const first = await sb.consumer(queue, 'worker').processBatch();
    expect(first).toMatchObject({ delivered: 2, acked: 0, ackFailed: 2 });
    expect(await sb.sinkCount()).toBe(2);

    queue.ack = realAck;
    const second = await sb.consumer(queue, 'worker').processBatch();
    expect(second).toMatchObject({ delivered: 0, duplicates: 2, acked: 2 });
    expect(await sb.sinkCount()).toBe(2); // still two
    expect((await queue.pending()).count).toBe(0);
  });
});

describe('duplicate and lost messages', () => {
  it('the same notification delivered several times has one effect', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    await sb.publisher(queue).publishPending();
    const { rows } = await sb.db.query<{ id: number; notification_id: string; notification_type: string; payload: unknown }>(
      'SELECT id, notification_id, notification_type, payload FROM outbox ORDER BY id',
    );
    for (let i = 0; i < 3; i++) {
      await queue.publish({ notificationId: rows[0]!.notification_id, type: rows[0]!.notification_type, outboxId: rows[0]!.id, payload: JSON.stringify(rows[0]!.payload) });
    }

    const report = await sb.consumer(queue).processBatch();
    expect(report).toMatchObject({ received: 5, delivered: 2, duplicates: 3 });
    expect(await sb.sinkCount()).toBe(2);
  });

  it('a broker that loses its data is repaired from the outbox: stale published rows are re-queued and delivered', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    const publisher = sb.publisher(queue);
    await publisher.publishPending();
    queue.flush(); // restart without persistence: messages and consumer group are gone
    expect(queue.size).toBe(0);

    expect(await sb.consumer(queue).processBatch()).toMatchObject({ received: 0 });
    expect((await sb.outbox()).map((o) => o.status)).toEqual(['published', 'published']); // the blocking state is visible

    expect(await publisher.requeueStale()).toBe(2);
    expect(await sb.count('recovery_log', "kind = 'outbox_requeue'")).toBe(1);
    await publisher.publishPending();
    await sb.consumer(queue).processBatch();

    expect(await sb.sinkCount()).toBe(2);
    const outbox = await sb.outbox();
    expect(outbox.every((o) => o.status === 'processed' && o.republished === 1)).toBe(true);
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('requeueStale leaves settled rows and rows younger than the threshold alone', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    const publisher = sb.publisher(queue, { republishAfterMs: 60_000 });
    await publisher.publishPending();
    expect(await publisher.requeueStale()).toBe(0); // published a moment ago: not stale
    await sb.consumer(queue).processBatch();
    expect(await sb.publisher(queue, { republishAfterMs: 0 }).requeueStale()).toBe(0); // processed: never re-queued
  });

  it('does not wait for, or take, a stale-looking row that another transaction is handling at that moment', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    await sb.publisher(queue).publishPending(); // both rows are `published`
    const requeuer = sb.publisher(queue, { republishAfterMs: 0 });

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const lockHeld = new Promise<void>((resolve) => (acquired = resolve));
    const holder = sb.db.tx(async (tx) => {
      await tx.query("SELECT id FROM outbox WHERE status = 'published' ORDER BY id LIMIT 1 FOR UPDATE");
      acquired();
      await released; // the row stays locked until the test lets go
    });
    await lockHeld;

    expect(await requeuer.requeueStale()).toBe(1); // the free row only; the locked one is neither waited for nor touched
    release();
    await holder;
    expect(await requeuer.requeueStale()).toBe(1); // picked up on the next pass, once nobody holds it
    expect((await sb.outbox()).map((o) => [o.status, o.republished])).toEqual([['pending', 1], ['pending', 1]]);
  });
});

describe('notifications follow the event, not just the message', () => {
  it('suppresses a notification whose event was orphaned before delivery', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    await sb.publisher(queue).publishPending(); // both messages are in the stream

    sb.chain.reorg({ depth: 7, replacement: 8, branch: 'B' }); // blocks 4..10 replaced: both confirmed events vanish
    await sb.scanner.scanOnce('poll');
    expect((await sb.outbox()).map((o) => o.status)).toEqual(['suppressed', 'suppressed']);

    const report = await sb.consumer(queue).processBatch();
    expect(report).toMatchObject({ received: 2, delivered: 0, duplicates: 2, acked: 2 });
    expect(await sb.sinkCount()).toBe(0); // nothing leaked out for events that no longer exist
    expect(await sb.count('incidents', "kind = 'confirmed_event_orphaned' AND requires_manual_review")).toBe(1);
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('as defence in depth, refuses to deliver if the row says "published" but the event is no longer confirmed', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    await sb.publisher(queue).publishPending();
    sb.chain.reorg({ depth: 7, replacement: 8, branch: 'B' });
    await sb.scanner.scanOnce('poll');
    await sb.db.query("UPDATE outbox SET status = 'published', status_reason = NULL, processed_at = NULL"); // as if the suppression never happened

    const report = await sb.consumer(queue).processBatch();
    expect(report).toMatchObject({ suppressed: 2, delivered: 0 });
    expect(await sb.sinkCount()).toBe(0);
  });

  it('delivers a retraction for a confirmation that already went out, end to end', async () => {
    const sb = await confirmedSandbox();
    const queue = sb.memoryQueue();
    const publisher = sb.publisher(queue);
    await publisher.publishPending();
    await sb.consumer(queue).processBatch();
    expect(await sb.sinkCount()).toBe(2); // both confirmations delivered

    sb.chain.reorg({ depth: 7, replacement: 8, branch: 'B' }); // the chain abandons them afterwards
    await sb.scanner.scanOnce('poll');
    const queued = (await sb.outbox()).filter((o) => o.type === 'event_retracted');
    expect(queued).toHaveLength(2);
    expect(queued.every((o) => o.status === 'pending')).toBe(true);
    expect((await sb.invariants()).ok).toBe(true); // I10: a delivered-then-orphaned event always has a retraction queued

    await publisher.publishPending();
    await sb.consumer(queue).processBatch();
    const { rows } = await sb.db.query<{ notification_type: string; event_status_at_delivery: string; payload: { retractionReason: string } }>(
      "SELECT notification_type, event_status_at_delivery, payload FROM notification_sink WHERE notification_type = 'event_retracted'",
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.event_status_at_delivery === 'orphaned' && /no longer on the provider's canonical chain/.test(r.payload.retractionReason))).toBe(true);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

describe('a retraction answers the confirmation that was actually delivered', () => {
  /** "event_confirmed#2: suppressed" - the epoch is the part of the notification id after the last "#". */
  const ledger = async (sb: Sandbox): Promise<string[]> =>
    (await sb.outbox()).map((o) => `${o.type}#${o.notificationId.split('#').pop()}: ${o.status}`);

  it('a chain that flip-flops retracts each delivered epoch once, and never a confirmation that was not delivered', async () => {
    const sb = await Sandbox.create({ confirmationDepth: 2, batchSize: 10 });
    sandboxes.push(sb);
    minePlan(sb.chain, { 3: block(tx(HIGH_A)) }, 5);
    const tipA = sb.chain.head;
    const queue = sb.memoryQueue();
    const publisher = sb.publisher(queue);
    const consumer = sb.consumer(queue);
    const deliver = async () => {
      await publisher.publishPending();
      await consumer.processBatch();
    };

    await sb.scanner.scanOnce('startup'); // the event is confirmed (epoch 1) ...
    await deliver(); //                      ... and the confirmation goes out
    sb.chain.reorg({ depth: 3, replacement: 3, branch: 'B' });
    await sb.scanner.scanOnce('poll'); //    the chain abandons it: retraction of epoch 1 is queued
    await deliver();

    sb.chain.setCanonicalTip(tipA.hash);
    await sb.scanner.scanOnce('poll'); //    it comes back and is confirmed again (epoch 2); nothing is delivered yet
    sb.chain.reorg({ depth: 3, replacement: 3, branch: 'C' });
    await sb.scanner.scanOnce('poll'); //    ... and is abandoned again before epoch 2 ever went out
    await deliver();

    // Downstream was told about epoch 1 and then that epoch 1 was wrong. It was never told about epoch 2, so it
    // must not be told that epoch 2 was wrong: a counting consumer would end at -1.
    expect(await ledger(sb)).toEqual(['event_confirmed#1: processed', 'event_retracted#1: processed', 'event_confirmed#2: suppressed']);
    expect((await sb.invariants()).ok).toBe(true);

    sb.chain.setCanonicalTip(tipA.hash);
    await sb.scanner.scanOnce('poll'); //    epoch 3 is confirmed and, this time, delivered
    await deliver();
    sb.chain.reorg({ depth: 3, replacement: 3, branch: 'D' });
    await sb.scanner.scanOnce('poll'); //    and it is abandoned once more: now a retraction is owed, for epoch 3
    await deliver();

    expect(await ledger(sb)).toEqual([
      'event_confirmed#1: processed',
      'event_retracted#1: processed',
      'event_confirmed#2: suppressed',
      'event_confirmed#3: processed',
      'event_retracted#3: processed',
    ]);
    expect(await sb.sinkCount()).toBe(4); // +1 -1 +1 -1: downstream ends with nothing, which is the truth
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('still delivers the retraction of an earlier epoch after the event has come back and been confirmed again', async () => {
    const sb = await Sandbox.create({ confirmationDepth: 2, batchSize: 10 });
    sandboxes.push(sb);
    minePlan(sb.chain, { 3: block(tx(HIGH_A)) }, 5);
    const tipA = sb.chain.head;
    const queue = sb.memoryQueue();
    const deliver = async () => {
      await sb.publisher(queue).publishPending();
      await sb.consumer(queue).processBatch();
    };

    await sb.scanner.scanOnce('startup');
    await deliver(); // epoch 1 delivered
    sb.chain.reorg({ depth: 3, replacement: 3, branch: 'B' });
    await sb.scanner.scanOnce('poll'); // retraction of epoch 1 queued, not delivered yet
    sb.chain.setCanonicalTip(tipA.hash);
    await sb.scanner.scanOnce('poll'); // back again before anything else was delivered: epoch 2 queued
    await deliver();

    // Delivered in this order downstream sees +1 (epoch 1), -1 (its retraction), +1 (epoch 2): the event is live.
    expect(await ledger(sb)).toEqual(['event_confirmed#1: processed', 'event_retracted#1: processed', 'event_confirmed#2: processed']);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

describe('a consumer and a reorganization racing on the same event', () => {
  it('a reorg that starts while the consumer holds its locks waits for it, and then queues the retraction (deterministic interleaving)', async () => {
    const sb = await Sandbox.create({ confirmationDepth: 2, batchSize: 10 });
    sandboxes.push(sb);
    minePlan(sb.chain, { 3: block(tx(HIGH_A)) }, 6);
    await sb.scanner.scanOnce('startup');
    const queue = sb.memoryQueue();
    await sb.publisher(queue).publishPending();

    // The consumer has decided to deliver and has written its effect, but has not committed. Start the reorg now.
    sb.chain.reorg({ depth: 4, replacement: 5, branch: 'R' });
    let reorg: Promise<unknown> = Promise.resolve();
    sb.crash.gate('consumer.before_effect_commit', async () => {
      reorg = sb.newScanner().scanOnce('poll');
      await new Promise((resolve) => setTimeout(resolve, 400)); // long enough for the reorg to reach (and, if unlocked, pass) its checks
    });
    await sb.consumer(queue).processBatch();
    await reorg;

    // The confirmation went out first, so the later orphaning must have produced a retraction.
    expect(await sb.count('notification_sink', "notification_type = 'event_confirmed'")).toBe(1);
    expect(await sb.count('outbox', "notification_type = 'event_retracted' AND status = 'pending'")).toBe(1);
    expect((await sb.invariants()).checks.filter((c) => c.violations > 0)).toEqual([]);
  });

  it('never leaves a delivered confirmation for an orphaned event without a retraction (lock-order check)', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 10; round++) {
      const sb = await Sandbox.create({ confirmationDepth: 2, batchSize: 10 });
      sandboxes.push(sb);
      minePlan(sb.chain, { 3: block(tx(HIGH_A)) }, 6);
      await sb.scanner.scanOnce('startup');
      const queue = sb.memoryQueue();
      await sb.publisher(queue).publishPending();

      sb.chain.reorg({ depth: 4, replacement: 5, branch: `R${round}` });
      await Promise.all([sb.consumer(queue).processBatch(), sb.newScanner().scanOnce('poll')]);
      await sb.publisher(queue).publishPending(); // a retraction, if one was queued
      await sb.consumer(queue).processBatch();

      const report = await sb.invariants();
      expect(report.checks.filter((c) => c.violations > 0), `round ${round}`).toEqual([]);
      const delivered = await sb.count('notification_sink', "notification_type = 'event_confirmed'");
      const retracted = await sb.count('notification_sink', "notification_type = 'event_retracted'");
      outcomes.add(delivered === 0 ? 'suppressed' : retracted === 1 ? 'delivered-then-retracted' : `BAD(${delivered},${retracted})`);
    }
    expect([...outcomes].every((o) => o === 'suppressed' || o === 'delivered-then-retracted')).toBe(true);
  });
});
