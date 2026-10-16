import { QueueError, type PendingSummary, type PublishInput, type StreamMessage, type StreamQueue } from './queue.js';

interface Entry {
  id: string;
  fields: Record<string, string>;
  /** Set once delivered to a consumer. */
  owner: string | null;
  deliveredAt: number;
  deliveries: number;
  acked: boolean;
}

/**
 * An in-process stand-in for a Redis Streams consumer group, used to test the publisher and consumer
 * logic quickly and deterministically. It models the semantics those two components rely on - ids,
 * a per-consumer pending list, acknowledgement, idle-based claiming - and can be switched off
 * (`down`) or wiped (`flush`) to imitate an outage or data loss.
 *
 * It proves nothing about Redis itself. tests/integration/queue-contract.test.ts runs one behavioral
 * contract against this class and against the real Redis adapter.
 */
export class MemoryQueue implements StreamQueue {
  down = false;
  private entries: Entry[] = [];
  private cursor = 0; // index of the next never-delivered entry
  private seq = 0;
  private groupExists = false;

  constructor(private readonly now: () => number = () => 0) {}

  publish(message: PublishInput): Promise<string> {
    return this.guard(() => {
      this.seq += 1;
      const id = `${this.seq}-0`;
      this.entries.push({
        id,
        fields: { notificationId: message.notificationId, type: message.type, outboxId: String(message.outboxId), payload: message.payload },
        owner: null,
        deliveredAt: 0,
        deliveries: 0,
        acked: false,
      });
      return id;
    });
  }

  ensureGroup(): Promise<void> {
    return this.guard(() => {
      this.groupExists = true;
    });
  }

  readPending(consumer: string, count: number): Promise<StreamMessage[]> {
    return this.guard(() =>
      this.entries
        .filter((e) => !e.acked && e.owner === consumer)
        .slice(0, count)
        .map(toMessage),
    );
  }

  readNew(consumer: string, count: number): Promise<StreamMessage[]> {
    return this.guard(() => {
      if (!this.groupExists) return [];
      const fresh = this.entries.slice(this.cursor, this.cursor + count);
      this.cursor += fresh.length;
      for (const e of fresh) this.deliver(e, consumer);
      return fresh.map(toMessage);
    });
  }

  claimStale(consumer: string, opts: { minIdleMs: number; count: number }): Promise<StreamMessage[]> {
    return this.guard(() => {
      const stale = this.entries
        .filter((e) => !e.acked && e.owner !== null && e.owner !== consumer && this.now() - e.deliveredAt >= opts.minIdleMs)
        .slice(0, opts.count);
      for (const e of stale) this.deliver(e, consumer);
      return stale.map(toMessage);
    });
  }

  ack(id: string): Promise<void> {
    return this.guard(() => {
      const entry = this.entries.find((e) => e.id === id);
      if (entry) entry.acked = true;
    });
  }

  pending(): Promise<PendingSummary> {
    return this.guard(() => {
      const open = this.entries.filter((e) => !e.acked && e.owner !== null);
      const oldest = open[0];
      return { count: open.length, oldestIdleMs: oldest ? this.now() - oldest.deliveredAt : null };
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  // ---- Test controls ---------------------------------------------------------------------------

  /** Everything the broker holds, delivered or not. */
  get length(): number {
    return this.entries.length;
  }

  /** The broker loses all data, group included (a restart without persistence). */
  flush(): void {
    this.entries = [];
    this.cursor = 0;
    this.groupExists = false;
  }

  private deliver(entry: Entry, consumer: string): void {
    entry.owner = consumer;
    entry.deliveredAt = this.now();
    entry.deliveries += 1;
  }

  /** Runs `fn` as a broker call: rejects (never throws synchronously) while the broker is down. */
  private guard<T>(fn: () => T): Promise<T> {
    if (this.down) return Promise.reject(new QueueError('queue unavailable (simulated outage)'));
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

const toMessage = (e: Entry): StreamMessage => ({ id: e.id, fields: { ...e.fields } });
