import { Redis } from 'ioredis';
import { QueueError, type PendingSummary, type PublishInput, type StreamMessage, type StreamQueue } from './queue.js';

export interface RedisStreamQueueOptions {
  url: string;
  streamKey: string;
  group: string;
  commandTimeoutMs?: number;
  /** How long a call waits for the connection before giving up with a QueueError. */
  readyTimeoutMs?: number;
  connectionName?: string;
}

/** Redis reply shape for entries: [[id, [field, value, field, value, ...]], ...]. A deleted entry has null fields. */
type RawEntry = [string, string[] | null];

interface ParsedEntries {
  messages: StreamMessage[];
  /** Ids the broker still lists as pending although the entry no longer exists in the stream (XDEL, trimming). */
  deleted: string[];
}

function parseEntries(entries: unknown): ParsedEntries {
  const messages: StreamMessage[] = [];
  const deleted: string[] = [];
  for (const entry of (entries ?? []) as RawEntry[]) {
    const [id, flat] = entry;
    if (!flat) {
      deleted.push(id);
      continue;
    }
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) fields[String(flat[i])] = String(flat[i + 1]);
    messages.push({ id, fields });
  }
  return { messages, deleted };
}

/** Upper bound on consecutive reads that return nothing but deleted entries; the rest is cleaned on later calls. */
const MAX_CLEANUP_PASSES = 50;

const isNoGroup = (err: unknown): boolean => err instanceof Error && err.message.includes('NOGROUP');
const isBusyGroup = (err: unknown): boolean => err instanceof Error && err.message.includes('BUSYGROUP');

/**
 * Redis Streams with a consumer group. Requires Redis >= 6.2 (XAUTOCLAIM).
 *
 * Connection behavior is chosen so that an outage is loud and bounded rather than silent:
 * the offline queue is off (a command issued while disconnected fails immediately instead of waiting
 * and being replayed later), unfulfilled commands are not auto-resent after a reconnect, and every
 * command has a timeout. The client still reconnects on its own in the background.
 *
 * No blocking reads are used, so one connection can serve every call; the consumer loop polls.
 */
export class RedisStreamQueue implements StreamQueue {
  private readonly client: Redis;

  constructor(private readonly opts: RedisStreamQueueOptions) {
    this.client = new Redis(opts.url, {
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: opts.commandTimeoutMs ?? 5_000,
      retryStrategy: (attempt) => Math.min(100 * 2 ** Math.min(attempt, 5), 2_000),
      connectionName: opts.connectionName ?? 'cers',
    });
    // Failures are reported through the rejected command; an unhandled 'error' event would crash the process.
    this.client.on('error', () => undefined);
  }

  async publish(message: PublishInput): Promise<string> {
    return this.run('XADD', async () => {
      const id = await this.client.xadd(
        this.opts.streamKey,
        '*',
        'notificationId',
        message.notificationId,
        'type',
        message.type,
        'outboxId',
        String(message.outboxId),
        'payload',
        message.payload,
      );
      if (!id) throw new Error('XADD returned no id');
      return id;
    });
  }

  async ensureGroup(): Promise<void> {
    await this.run('XGROUP CREATE', async () => {
      try {
        // Start id 0, not $: messages published before the first consumer ever started must still be delivered.
        await this.client.xgroup('CREATE', this.opts.streamKey, this.opts.group, '0', 'MKSTREAM');
      } catch (err) {
        if (!isBusyGroup(err)) throw err;
      }
    });
  }

  readPending(consumer: string, count: number): Promise<StreamMessage[]> {
    return this.read(consumer, count, '0');
  }

  readNew(consumer: string, count: number): Promise<StreamMessage[]> {
    return this.read(consumer, count, '>');
  }

  async claimStale(consumer: string, opts: { minIdleMs: number; count: number }): Promise<StreamMessage[]> {
    return this.run('XAUTOCLAIM', async () => {
      try {
        // Reply: [next-start-id, entries, (Redis 7+) deleted-ids]
        const reply = (await this.client.xautoclaim(
          this.opts.streamKey,
          this.opts.group,
          consumer,
          opts.minIdleMs,
          '0-0',
          'COUNT',
          opts.count,
        )) as unknown as [string, unknown];
        const { messages, deleted } = parseEntries(reply[1]);
        await this.dropDeleted(deleted); // Redis 7 already removed these from the pending list; 6.2 returns them as nil
        return messages;
      } catch (err) {
        if (isNoGroup(err)) return [];
        throw err;
      }
    });
  }

  /**
   * An entry deleted from the stream while it was still pending can never be processed. Left in the pending
   * list it would be returned first on every pass and, with enough of them, hide the live messages behind
   * it. Acknowledging removes it. The outbox row is still `published`, so reconciliation re-queues the
   * notification if it was lost.
   */
  private async dropDeleted(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.client.xack(this.opts.streamKey, this.opts.group, ...ids);
  }

  async ack(id: string): Promise<void> {
    await this.run('XACK', async () => {
      await this.client.xack(this.opts.streamKey, this.opts.group, id);
    });
  }

  async pending(): Promise<PendingSummary> {
    return this.run('XPENDING', async () => {
      try {
        const summary = (await this.client.xpending(this.opts.streamKey, this.opts.group)) as unknown as [number, ...unknown[]];
        const count = Number(summary[0] ?? 0);
        if (count === 0) return { count: 0, oldestIdleMs: null };
        const oldest = (await this.client.xpending(this.opts.streamKey, this.opts.group, '-', '+', 1)) as unknown as Array<
          [string, string, number, number]
        >;
        return { count, oldestIdleMs: oldest[0] ? Number(oldest[0][2]) : null };
      } catch (err) {
        if (isNoGroup(err)) return { count: 0, oldestIdleMs: null };
        throw err;
      }
    });
  }

  async length(): Promise<number> {
    return this.run('XLEN', () => this.client.xlen(this.opts.streamKey));
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  private async read(consumer: string, count: number, id: '0' | '>'): Promise<StreamMessage[]> {
    return this.run('XREADGROUP', async () => {
      try {
        // Reading the pending list can return nothing but deleted entries. Each pass removes them, so the next
        // one reaches the live messages behind them.
        for (let pass = 0; pass < MAX_CLEANUP_PASSES; pass++) {
          const reply = (await this.client.xreadgroup(
            'GROUP',
            this.opts.group,
            consumer,
            'COUNT',
            count,
            'STREAMS',
            this.opts.streamKey,
            id,
          )) as unknown as Array<[string, unknown]> | null;
          const { messages, deleted } = parseEntries(reply?.[0]?.[1]);
          await this.dropDeleted(deleted);
          if (messages.length > 0 || deleted.length === 0) return messages;
        }
        return [];
      } catch (err) {
        // The broker lost the group (data loss / restart without persistence). Recreate it and report nothing read.
        if (isNoGroup(err)) {
          await this.client.xgroup('CREATE', this.opts.streamKey, this.opts.group, '0', 'MKSTREAM').catch((e: unknown) => {
            if (!isBusyGroup(e)) throw e;
          });
          return [];
        }
        throw err;
      }
    });
  }

  /** Waits (bounded) for a ready connection, runs the command, and turns every failure into a QueueError. */
  private async run<T>(command: string, fn: () => Promise<T>): Promise<T> {
    try {
      await this.ready();
      return await fn();
    } catch (err) {
      if (err instanceof QueueError) throw err;
      throw new QueueError(`${command} failed: ${(err as Error).message}`, { cause: err });
    }
  }

  private ready(): Promise<void> {
    if (this.client.status === 'ready') return Promise.resolve();
    const timeoutMs = this.opts.readyTimeoutMs ?? 3_000;
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.client.off('ready', onReady);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new QueueError(`Redis not ready after ${timeoutMs}ms (status: ${this.client.status})`));
      }, timeoutMs);
      this.client.once('ready', onReady);
    });
  }
}
