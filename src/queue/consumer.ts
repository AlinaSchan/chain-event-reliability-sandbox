import type { NotificationPayload } from '../confirmation/notification.js';
import type { EventStatus } from '../domain/types.js';
import type { CrashPoints } from '../observability/failpoints.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { Db } from '../storage/db.js';
import type { StreamMessage, StreamQueue } from './queue.js';

export interface ConsumerConfig {
  /** Stable per process role. A restarted consumer with the same name first sees its own unacknowledged messages. */
  consumerName: string;
  batchSize: number;
  /** Messages another consumer received and did not acknowledge for this long are taken over. */
  claimIdleMs: number;
}

export interface ConsumerReport {
  received: number;
  delivered: number;
  duplicates: number;
  suppressed: number;
  unknown: number;
  failed: number;
  acked: number;
  ackFailed: number;
  error?: string;
}

type Outcome = 'delivered' | 'duplicate' | 'suppressed' | 'unknown';

export interface NotificationConsumerDeps {
  db: Db;
  queue: StreamQueue;
  logger: Logger;
  metrics: Metrics;
  crash?: CrashPoints;
}

interface OutboxRow {
  id: number;
  chain_id: number;
  notification_id: string;
  event_id: string;
  notification_type: 'event_confirmed' | 'event_retracted';
  payload: NotificationPayload;
  status: 'pending' | 'published' | 'processed' | 'suppressed';
}

/**
 * Reads the stream and turns each message into a durable effect, then acknowledges it.
 *
 * Order matters and is the whole point: the effect (a sink row plus the outbox row's new status) is
 * committed in one PostgreSQL transaction FIRST, and the message is acknowledged only afterwards.
 * If the process dies in between, the message comes back, finds the outbox row already settled, and is
 * simply acknowledged. The stream decides what to look at; the database decides whether it happened.
 */
export class NotificationConsumer {
  constructor(
    private readonly deps: NotificationConsumerDeps,
    private readonly cfg: ConsumerConfig,
  ) {}

  /** One pass over: own unacknowledged messages, messages abandoned by other consumers, new messages. */
  async processBatch(): Promise<ConsumerReport> {
    const { queue, logger } = this.deps;
    const report: ConsumerReport = { received: 0, delivered: 0, duplicates: 0, suppressed: 0, unknown: 0, failed: 0, acked: 0, ackFailed: 0 };

    const batch: StreamMessage[] = [];
    const seen = new Set<string>();
    const add = (messages: StreamMessage[]) => {
      for (const m of messages) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          batch.push(m);
        }
      }
    };

    try {
      await queue.ensureGroup();
      add(await queue.readPending(this.cfg.consumerName, this.cfg.batchSize));
      add(await queue.claimStale(this.cfg.consumerName, { minIdleMs: this.cfg.claimIdleMs, count: this.cfg.batchSize }));
      add(await queue.readNew(this.cfg.consumerName, this.cfg.batchSize));
    } catch (err) {
      // The broker is unreachable or misbehaving. Anything already delivered to us stays in our pending list.
      report.error = (err as Error).message;
      logger.warn({ event: 'consumer.queue_unavailable', consumer: this.cfg.consumerName, error: report.error }, 'could not read from the queue');
    }

    report.received = batch.length;
    for (const message of batch) await this.process(message, report);
    return report;
  }

  private async process(message: StreamMessage, report: ConsumerReport): Promise<void> {
    const { queue, logger, metrics, crash } = this.deps;

    let outcome: Outcome;
    try {
      outcome = await this.applyEffect(message);
    } catch (err) {
      // Not acknowledged: the message stays pending and is retried. Nothing was committed.
      report.failed += 1;
      metrics.inc('consumer_errors_total');
      logger.warn(
        { event: 'consumer.failed', consumer: this.cfg.consumerName, messageId: message.id, notificationId: message.fields.notificationId, error: (err as Error).message },
        'handling failed; leaving the message unacknowledged for redelivery',
      );
      return;
    }

    if (outcome === 'delivered') report.delivered += 1;
    else if (outcome === 'duplicate') report.duplicates += 1;
    else if (outcome === 'suppressed') report.suppressed += 1;
    else report.unknown += 1;

    // The effect is durable; the acknowledgement is not sent yet. A crash here is the case this ordering exists for.
    crash?.hit('consumer.after_effect_before_ack');

    try {
      await queue.ack(message.id);
      report.acked += 1;
    } catch (err) {
      report.ackFailed += 1;
      logger.warn(
        { event: 'consumer.ack_failed', consumer: this.cfg.consumerName, messageId: message.id, error: (err as Error).message },
        'effect committed but the acknowledgement failed; the message will be redelivered and recognised as a duplicate',
      );
    }
  }

  private async applyEffect(message: StreamMessage): Promise<Outcome> {
    const { db, logger, metrics, crash } = this.deps;
    const notificationId = message.fields.notificationId;
    if (!notificationId) {
      logger.error({ event: 'consumer.malformed', messageId: message.id }, 'message has no notification id; acknowledging it so it cannot loop');
      return 'unknown';
    }

    const outcome = await db.tx(async (tx): Promise<Outcome> => {
      const { rows: ref } = await tx.query<{ event_id: string }>('SELECT event_id FROM outbox WHERE notification_id = $1', [notificationId]);
      const eventId = ref[0]?.event_id;
      if (!eventId) return 'unknown';

      // Lock order is events -> outbox everywhere (reorg handling, confirmation, here), so these cannot deadlock.
      // The shared lock on the event also means a reorg cannot orphan it between our check and our commit.
      const { rows: ev } = await tx.query<{ status: EventStatus; confirm_count: number }>(
        'SELECT status, confirm_count FROM chain_events WHERE event_id = $1 FOR SHARE',
        [eventId],
      );
      const event = ev[0];
      const { rows } = await tx.query<OutboxRow>('SELECT * FROM outbox WHERE notification_id = $1 FOR UPDATE', [notificationId]);
      const row = rows[0];
      if (!row || !event) return 'unknown';

      if (row.status === 'processed' || row.status === 'suppressed') {
        await tx.query('UPDATE outbox SET duplicate_deliveries = duplicate_deliveries + 1 WHERE id = $1', [row.id]);
        return 'duplicate';
      }

      // Deliver a confirmation only if the event is still confirmed, in the same confirmation epoch.
      // A retraction is always delivered: it exists because a confirmation already went out.
      const deliverable =
        row.notification_type === 'event_retracted' ||
        (event.status === 'confirmed' && event.confirm_count === row.payload.confirmationEpoch);
      if (!deliverable) {
        await tx.query(
          `UPDATE outbox SET status = 'suppressed', processed_at = now(), status_reason = $2 WHERE id = $1`,
          [row.id, `not delivered: event is ${event.status} at confirmation epoch ${event.confirm_count}, notification is for epoch ${row.payload.confirmationEpoch}`],
        );
        return 'suppressed';
      }

      await tx.query(
        `INSERT INTO notification_sink (notification_id, chain_id, event_id, notification_type, payload, event_status_at_delivery)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (notification_id) DO NOTHING`,
        [row.notification_id, row.chain_id, row.event_id, row.notification_type, JSON.stringify(row.payload), event.status],
      );
      await tx.query(`UPDATE outbox SET status = 'processed', processed_at = now(), status_reason = NULL WHERE id = $1`, [row.id]);
      await crash?.pause('consumer.before_effect_commit'); // test seam: locks are held, COMMIT has not happened
      return 'delivered';
    });

    if (outcome === 'delivered') metrics.inc('consumer_delivered_total');
    else if (outcome === 'duplicate') metrics.inc('consumer_duplicates_total');
    else if (outcome === 'suppressed') metrics.inc('consumer_suppressed_total');
    logger.info({ event: `consumer.${outcome}`, consumer: this.cfg.consumerName, messageId: message.id, notificationId }, `notification ${outcome}`);
    return outcome;
  }
}
