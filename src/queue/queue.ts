/**
 * The delivery port. Redis Streams is the implementation; this interface is what the publisher and the
 * consumer depend on. Its contract is deliberately weak: messages are delivered at least once, possibly
 * more than once, in no guaranteed order, and may disappear if the broker loses its data. Everything
 * that must be exactly-once in effect is enforced in PostgreSQL, never here.
 */

export interface PublishInput {
  notificationId: string;
  type: string;
  outboxId: number;
  /** JSON text of the notification payload. */
  payload: string;
}

export interface StreamMessage {
  /** Broker-assigned id. Only meaningful to the broker (used for acknowledgement). */
  id: string;
  fields: Record<string, string>;
}

export interface PendingSummary {
  count: number;
  /** Idle time of the oldest unacknowledged message, if any. */
  oldestIdleMs: number | null;
}

export class QueueError extends Error {
  override readonly name = 'QueueError';
}

export interface StreamQueue {
  /** Appends a message and returns its broker id. Rejects with QueueError if the broker cannot take it. */
  publish(message: PublishInput): Promise<string>;
  /** Creates the consumer group if missing. Safe to call repeatedly, and after the broker lost its data. */
  ensureGroup(): Promise<void>;
  /** Messages previously delivered to `consumer` and never acknowledged. */
  readPending(consumer: string, count: number): Promise<StreamMessage[]>;
  /** Messages never delivered to any consumer of the group. */
  readNew(consumer: string, count: number): Promise<StreamMessage[]>;
  /** Takes over messages another consumer received but has not acknowledged for at least `minIdleMs`. */
  claimStale(consumer: string, opts: { minIdleMs: number; count: number }): Promise<StreamMessage[]>;
  ack(id: string): Promise<void>;
  pending(): Promise<PendingSummary>;
  /** Messages the broker currently holds for this stream, acknowledged or not. */
  length(): Promise<number>;
  close(): Promise<void>;
}
