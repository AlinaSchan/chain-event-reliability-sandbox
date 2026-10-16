import { describe, expect, it, vi } from 'vitest';

/**
 * Control flow of the Redis adapter against a scripted stand-in for the client.
 *
 * This is NOT evidence about Redis. The replies below are the documented shapes (a pending entry whose stream
 * entry was deleted comes back as `[id, null]`); whether a real server behaves like that is what
 * tests/integration/queue-contract.test.ts establishes against Redis in CI. What this file checks is the part
 * that can be checked without a server: that the adapter acknowledges such entries, keeps reading until it
 * reaches live messages, and cannot loop forever.
 */

const state = vi.hoisted(() => ({
  calls: [] as unknown[][],
  /** Replies handed out by XREADGROUP, oldest first. `null` ends the script (an empty read). */
  reads: [] as unknown[],
  /** Replies handed out by XAUTOCLAIM, oldest first. */
  claims: [] as unknown[],
  endless: false,
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    status = 'ready';
    on() {
      return this;
    }
    once() {
      return this;
    }
    off() {
      return this;
    }
    xreadgroup(...args: unknown[]) {
      state.calls.push(['XREADGROUP', ...args]);
      if (state.endless) return Promise.resolve([['stream', [['1-0', null]]]]);
      return Promise.resolve(state.reads.shift() ?? null);
    }
    xautoclaim(...args: unknown[]) {
      state.calls.push(['XAUTOCLAIM', ...args]);
      return Promise.resolve(state.claims.shift() ?? ['0-0', []]);
    }
    xack(...args: unknown[]) {
      state.calls.push(['XACK', ...args]);
      return Promise.resolve(args.length - 2);
    }
    quit() {
      return Promise.resolve('OK');
    }
    disconnect() {
      /* nothing to close */
    }
  }
  return { Redis: FakeRedis };
});

const { RedisStreamQueue } = await import('../../src/queue/redis-streams.js');

const live = (id: string, n: number): [string, string[]] => [id, ['notificationId', `n-${n}`, 'type', 'event_confirmed', 'outboxId', String(n), 'payload', '{}']];
const dead = (id: string): [string, null] => [id, null];
const make = () => new RedisStreamQueue({ url: 'redis://fake', streamKey: 's', group: 'g' });
const acks = () => state.calls.filter((c) => c[0] === 'XACK').map((c) => c.slice(3));
const reset = () => {
  state.calls.length = 0;
  state.reads.length = 0;
  state.claims.length = 0;
  state.endless = false;
};

describe('RedisStreamQueue: entries deleted from the stream while pending', () => {
  it('acknowledges them and keeps reading until it reaches the live messages behind them', async () => {
    reset();
    state.reads.push([['s', [dead('1-0'), dead('2-0')]]], [['s', [live('3-0', 3), live('4-0', 4)]]]);

    const messages = await make().readPending('A', 2);

    expect(messages.map((m) => m.fields.notificationId)).toEqual(['n-3', 'n-4']);
    expect(acks()).toEqual([['1-0', '2-0']]);
    expect(state.calls.filter((c) => c[0] === 'XREADGROUP')).toHaveLength(2);
  });

  it('returns the live messages of a mixed reply straight away, and still acknowledges the dead ones', async () => {
    reset();
    state.reads.push([['s', [dead('1-0'), live('2-0', 2)]]]);

    const messages = await make().readPending('A', 10);

    expect(messages.map((m) => m.fields.notificationId)).toEqual(['n-2']);
    expect(acks()).toEqual([['1-0']]);
    expect(state.calls.filter((c) => c[0] === 'XREADGROUP')).toHaveLength(1);
  });

  it('does nothing extra for an ordinary read, or an empty one', async () => {
    reset();
    state.reads.push([['s', [live('1-0', 1)]]], null);
    const queue = make();
    expect((await queue.readNew('A', 10)).map((m) => m.fields.notificationId)).toEqual(['n-1']);
    expect(await queue.readNew('A', 10)).toEqual([]);
    expect(acks()).toEqual([]);
  });

  it('stops after a bounded number of passes even if the broker keeps answering with deleted entries', async () => {
    reset();
    state.endless = true;

    expect(await make().readPending('A', 10)).toEqual([]);

    const passes = state.calls.filter((c) => c[0] === 'XREADGROUP').length;
    expect(passes).toBeGreaterThan(1);
    expect(passes).toBeLessThanOrEqual(50);
  });

  it('drops them from a claim too, in both reply shapes (nil entries; and entries already removed by Redis 7)', async () => {
    reset();
    state.claims.push(['0-0', [dead('1-0'), live('2-0', 2)]], ['0-0', [live('3-0', 3)], ['9-0']]);
    const queue = make();

    expect((await queue.claimStale('B', { minIdleMs: 0, count: 10 })).map((m) => m.fields.notificationId)).toEqual(['n-2']);
    expect((await queue.claimStale('B', { minIdleMs: 0, count: 10 })).map((m) => m.fields.notificationId)).toEqual(['n-3']);
    expect(acks()).toEqual([['1-0']]); // the Redis 7 reply needs no acknowledgement: the server already removed '9-0'
  });
});
