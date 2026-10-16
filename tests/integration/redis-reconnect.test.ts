import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisStreamQueue } from '../../src/queue/redis-streams.js';
import { redisUrl } from '../../scenarios/harness.js';

/**
 * The server drops this queue's connection (what a Redis restart or a network cut looks like from the
 * client). Only this test's own connection is killed, by id, so other tests sharing the server are not
 * disturbed. Needs REDIS_URL; skipped (and reported as skipped) otherwise.
 */
const url = redisUrl();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(url === undefined)('Redis connection loss (real Redis)', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn().catch(() => undefined)));
  });

  it('fails calls loudly while the connection is gone, then reconnects on its own with no lost or invented message', async () => {
    const tag = Math.random().toString(36).slice(2);
    const streamKey = `cers-test:reconnect:${tag}`;
    const connectionName = `cers-reconnect-${tag}`;
    const queue = new RedisStreamQueue({ url: url ?? '', streamKey, group: 'g', connectionName });
    const admin = new Redis(url ?? '', { maxRetriesPerRequest: 1 });
    cleanup.push(async () => {
      await queue.close();
      await admin.del(streamKey);
      admin.disconnect();
    });

    await queue.ensureGroup();
    const first = await queue.publish({ notificationId: 'n-1', type: 'event_confirmed', outboxId: 1, payload: '{}' });

    // Find and kill exactly this queue's connection on the server.
    const list = (await admin.client('LIST')) as string;
    const line = list.split('\n').find((l) => l.includes(`name=${connectionName}`));
    const id = /\bid=(\d+)/.exec(line ?? '')?.[1];
    expect(id, 'the queue\'s connection should be listed on the server').toBeDefined();
    await admin.client('KILL', 'ID', id as string);

    // Calls may fail while the client notices and reconnects; they must fail as QueueErrors and then succeed.
    let failures = 0;
    let second: string | undefined;
    for (let attempt = 0; attempt < 20 && second === undefined; attempt++) {
      try {
        second = await queue.publish({ notificationId: 'n-2', type: 'event_confirmed', outboxId: 2, payload: '{}' });
      } catch (err) {
        expect((err as Error).name).toBe('QueueError');
        failures += 1;
        await sleep(150);
      }
    }
    expect(second).toBeDefined();
    expect(failures).toBeLessThan(20);

    // Nothing was lost and nothing was invented. (A command that reached the server but whose reply was lost
    // would legitimately appear twice - delivery is at-least-once - so compare sets, not counts.)
    const read = await queue.readNew('c1', 10);
    expect([...new Set(read.map((m) => m.fields.notificationId))].sort()).toEqual(['n-1', 'n-2']);
    expect(read.map((m) => m.id)).toContain(first);
    expect(await queue.length()).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
