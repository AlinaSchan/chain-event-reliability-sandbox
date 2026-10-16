import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueError, type PublishInput, type StreamQueue } from '../../src/queue/queue.js';
import { MemoryQueue } from '../../src/queue/memory-queue.js';
import { RedisStreamQueue } from '../../src/queue/redis-streams.js';
import { redisUrl } from '../../scenarios/harness.js';

/**
 * One behavioral contract, run against both implementations of StreamQueue: the in-process double used
 * by fast tests, and the real Redis Streams adapter. If the double ever disagrees with Redis on one of
 * these points, this file fails on the Redis side.
 *
 * The Redis half needs REDIS_URL (docker compose up -d --wait). Without it those tests are reported as
 * SKIPPED - never as passed - and CI fails the build if anything is skipped.
 */

interface Harness {
  queue: StreamQueue;
  /** A second client of the same stream and group (another consumer process). */
  another(): StreamQueue;
  /** The broker loses the stream and its consumer group. */
  loseAllData(): Promise<void>;
  /** A queue that cannot reach its broker at all. */
  unreachable(): StreamQueue;
  cleanup(): Promise<void>;
}

const msg = (n: number): PublishInput => ({ notificationId: `n-${n}`, type: 'event_confirmed', outboxId: n, payload: JSON.stringify({ n }) });

function memoryHarness(): Harness {
  const queue = new MemoryQueue();
  return {
    queue,
    another: () => queue, // one broker, shared state
    loseAllData: () => Promise.resolve(queue.flush()),
    unreachable: () => {
      const q = new MemoryQueue();
      q.down = true;
      return q;
    },
    cleanup: () => Promise.resolve(),
  };
}

function redisHarness(): Harness {
  const url = redisUrl() ?? '';
  const prefix = `cers-test:contract:${Math.random().toString(36).slice(2)}`;
  const make = (name: string, opts: { url?: string; readyTimeoutMs?: number } = {}) =>
    new RedisStreamQueue({ url: opts.url ?? url, streamKey: `${prefix}:s`, group: 'g', connectionName: name, readyTimeoutMs: opts.readyTimeoutMs });
  const opened: StreamQueue[] = [];
  const track = <T extends StreamQueue>(q: T): T => {
    opened.push(q);
    return q;
  };
  const queue = track(make('contract-main'));
  return {
    queue,
    another: () => track(make('contract-other')),
    // Deleting the stream key removes the stream and its consumer groups, which is what a restart without
    // persistence does to this application. (FLUSHALL would also wipe other test files sharing this Redis.)
    loseAllData: async () => {
      const admin = new Redis(url, { maxRetriesPerRequest: 1 });
      try {
        await admin.del(`${prefix}:s`);
      } finally {
        admin.disconnect();
      }
    },
    unreachable: () => track(make('contract-down', { url: 'redis://127.0.0.1:1', readyTimeoutMs: 400 })),
    cleanup: async () => {
      await Promise.all(opened.map((q) => q.close().catch(() => undefined)));
      const admin = new Redis(url, { maxRetriesPerRequest: 1 });
      try {
        const keys = await admin.keys(`${prefix}:*`);
        if (keys.length > 0) await admin.del(...keys);
      } finally {
        admin.disconnect();
      }
    },
  };
}

const IMPLEMENTATIONS: Array<{ name: string; enabled: boolean; make: () => Harness }> = [
  { name: 'MemoryQueue (test double)', enabled: true, make: memoryHarness },
  { name: 'RedisStreamQueue (real Redis)', enabled: redisUrl() !== undefined, make: redisHarness },
];

if (redisUrl() === undefined) {
  console.warn('[queue-contract] REDIS_URL is not set: the RedisStreamQueue tests below are SKIPPED, not passed.');
}

describe.each(IMPLEMENTATIONS)('StreamQueue contract - $name', ({ enabled, make }) => {
  const d = describe.skipIf(!enabled);
  d('behavior', () => {
    let h: Harness;
    beforeEach(async () => {
      if (h) await h.cleanup();
      h = make();
    });
    afterAll(async () => {
      if (h) await h.cleanup();
    });

    it('delivers each published message once, in publish order, with its fields intact', async () => {
      await h.queue.ensureGroup();
      const ids = [await h.queue.publish(msg(1)), await h.queue.publish(msg(2)), await h.queue.publish(msg(3))];
      expect(new Set(ids).size).toBe(3);

      const read = await h.queue.readNew('c1', 10);
      expect(read.map((m) => m.fields.notificationId)).toEqual(['n-1', 'n-2', 'n-3']);
      expect(read[0]?.fields).toEqual({ notificationId: 'n-1', type: 'event_confirmed', outboxId: '1', payload: '{"n":1}' });
      expect(await h.queue.readNew('c1', 10)).toEqual([]); // nothing is delivered twice by readNew
    });

    it('delivers messages published before the group existed (the group starts at the beginning of the stream)', async () => {
      await h.queue.publish(msg(1));
      await h.queue.ensureGroup();
      expect((await h.queue.readNew('c1', 10)).map((m) => m.fields.notificationId)).toEqual(['n-1']);
    });

    it('creating the group repeatedly is harmless', async () => {
      await h.queue.ensureGroup();
      await h.queue.ensureGroup();
      await h.queue.publish(msg(1));
      await h.queue.ensureGroup();
      expect(await h.queue.readNew('c1', 10)).toHaveLength(1);
    });

    it('hands a message to only one consumer of the group', async () => {
      await h.queue.ensureGroup();
      for (let i = 1; i <= 6; i++) await h.queue.publish(msg(i));
      const other = h.another();
      const a = await h.queue.readNew('A', 3);
      const b = await other.readNew('B', 10);
      const all = [...a, ...b].map((m) => m.fields.notificationId).sort();
      expect(all).toEqual(['n-1', 'n-2', 'n-3', 'n-4', 'n-5', 'n-6']); // no duplicates, no gaps
    });

    it('keeps an unacknowledged message pending for its consumer until it is acknowledged', async () => {
      await h.queue.ensureGroup();
      await h.queue.publish(msg(1));
      const [first] = await h.queue.readNew('A', 10);
      expect((await h.queue.pending()).count).toBe(1);
      expect((await h.queue.readPending('A', 10)).map((m) => m.id)).toEqual([first?.id]); // A gets it again
      expect(await h.queue.readPending('B', 10)).toEqual([]); // B does not

      await h.queue.ack(first!.id);
      expect(await h.queue.readPending('A', 10)).toEqual([]);
      expect((await h.queue.pending()).count).toBe(0);
    });

    it('acknowledging an unknown or already-acknowledged id is not an error', async () => {
      await h.queue.ensureGroup();
      await h.queue.publish(msg(1));
      const [first] = await h.queue.readNew('A', 1);
      await h.queue.ack(first!.id);
      await expect(h.queue.ack(first!.id)).resolves.toBeUndefined();
      await expect(h.queue.ack('999999-0')).resolves.toBeUndefined();
    });

    it('lets another consumer take over a message only after it has been idle long enough', async () => {
      await h.queue.ensureGroup();
      await h.queue.publish(msg(1));
      await h.queue.readNew('A', 10); // delivered to A, never acknowledged

      expect(await h.another().claimStale('B', { minIdleMs: 60_000, count: 10 })).toEqual([]); // still fresh
      const claimed = await h.another().claimStale('B', { minIdleMs: 0, count: 10 });
      expect(claimed.map((m) => m.fields.notificationId)).toEqual(['n-1']);
      expect(await h.queue.readPending('A', 10)).toEqual([]); // no longer A's
      expect((await h.another().readPending('B', 10)).map((m) => m.fields.notificationId)).toEqual(['n-1']);
    });

    it('survives the broker losing all of its data: the group is recreated and new messages flow', async () => {
      await h.queue.ensureGroup();
      await h.queue.publish(msg(1));
      await h.queue.readNew('A', 10);
      await h.loseAllData();

      expect(await h.queue.readNew('A', 10)).toEqual([]); // nothing left, and no exception
      expect((await h.queue.pending()).count).toBe(0);
      await h.queue.ensureGroup();
      await h.queue.publish(msg(2));
      expect((await h.queue.readNew('A', 10)).map((m) => m.fields.notificationId)).toEqual(['n-2']);
    });

    it('reports an unreachable broker as a QueueError instead of hanging or silently dropping the message', async () => {
      const down = h.unreachable();
      await expect(down.publish(msg(1))).rejects.toBeInstanceOf(QueueError);
      await expect(down.ensureGroup()).rejects.toBeInstanceOf(QueueError);
    });
  });
});
