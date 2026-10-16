import type { CrashPoints } from '../observability/failpoints.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { recordRecovery } from '../storage/audit.js';
import type { Db } from '../storage/db.js';
import type { StreamQueue } from './queue.js';

export interface PublisherConfig {
  /** Rows taken per pass. A crash mid-pass re-publishes at most this many (duplicates are harmless by design). */
  batchSize: number;
  /** A row that has been `published` this long without an effect being recorded is put back to `pending`. */
  republishAfterMs: number;
}

export interface PublishReport {
  selected: number;
  published: number;
  /** Set when the queue refused a message; the rest of the batch was left untouched. */
  error?: string;
}

export interface OutboxPublisherDeps {
  db: Db;
  queue: StreamQueue;
  logger: Logger;
  metrics: Metrics;
  crash?: CrashPoints;
}

/**
 * Moves outbox rows into the stream. The outbox row was written in the same transaction as the event
 * transition that created it, so a notification can neither be lost between the two nor exist for an
 * event that was never stored.
 *
 * "Marked published" and "in the stream" cannot be made atomic across two systems, so this publisher
 * errs on the side of publishing twice: a row only leaves `pending` after the queue accepted it, and
 * the consumer is idempotent on the notification id.
 */
export class OutboxPublisher {
  constructor(
    private readonly deps: OutboxPublisherDeps,
    private readonly cfg: PublisherConfig,
  ) {}

  async publishPending(): Promise<PublishReport> {
    const { db, queue, logger, metrics, crash } = this.deps;
    const report: PublishReport = { selected: 0, published: 0 };

    await db.tx(async (tx) => {
      // SKIP LOCKED lets several publishers share the table without waiting on or duplicating each other's rows.
      const { rows } = await tx.query<{ id: number; notification_id: string; notification_type: string; payload: unknown }>(
        `SELECT id, notification_id, notification_type, payload
           FROM outbox WHERE status = 'pending' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.cfg.batchSize],
      );
      report.selected = rows.length;

      for (const row of rows) {
        let streamId: string;
        try {
          streamId = await queue.publish({
            notificationId: row.notification_id,
            type: row.notification_type,
            outboxId: row.id,
            payload: JSON.stringify(row.payload),
          });
        } catch (err) {
          const message = (err as Error).message;
          report.error = message;
          metrics.inc('outbox_publish_failures_total');
          await tx.query('UPDATE outbox SET publish_attempts = publish_attempts + 1, last_error = $2 WHERE id = $1', [row.id, message]);
          logger.warn(
            { event: 'outbox.publish_failed', notificationId: row.notification_id, error: message },
            'queue unavailable; the row stays pending and is retried on the next pass',
          );
          break; // the queue is down for everyone; do not hammer it row by row
        }

        // In the stream, not yet marked. A crash here rolls this transaction back: the row stays `pending`,
        // is published again, and the consumer discards the duplicate.
        crash?.hit('publisher.after_publish_before_mark');

        await tx.query(
          `UPDATE outbox
              SET status = 'published', stream_message_id = $2, published_at = now(),
                  publish_attempts = publish_attempts + 1, last_error = NULL
            WHERE id = $1`,
          [row.id, streamId],
        );
        report.published += 1;
        metrics.inc('outbox_published_total');
      }
    });

    if (report.published > 0) logger.info({ event: 'outbox.published', count: report.published }, 'outbox rows published');
    return report;
  }

  /**
   * Reconciliation for a broker that lost messages (restart without persistence, failover): rows that
   * were handed to the queue but never produced an effect go back to `pending`. The queue's copy, if it
   * still exists, becomes a duplicate that the consumer discards.
   */
  async requeueStale(): Promise<number> {
    const { db, logger, metrics } = this.deps;
    // Rows another transaction holds (a consumer mid-delivery, a reorg, a publisher) are being handled, which is
    // the opposite of abandoned: they are skipped rather than waited for and picked up on a later pass if they
    // are still stale. Locking in id order with SKIP LOCKED means this job can never take part in a deadlock.
    const { rows } = await db.query<{ chain_id: number; notification_id: string }>(
      `WITH stale AS MATERIALIZED (
         SELECT id FROM outbox
          WHERE status = 'published' AND published_at < now() - make_interval(secs => $1::double precision / 1000)
          ORDER BY id FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o
          SET status = 'pending', republish_count = o.republish_count + 1,
              status_reason = 'requeued: published but no effect was recorded in time'
         FROM stale s
        WHERE o.id = s.id
        RETURNING o.chain_id, o.notification_id`,
      [this.cfg.republishAfterMs],
    );
    if (rows.length === 0) return 0;

    metrics.inc('outbox_requeued_total', rows.length);
    const byChain = new Map<number, string[]>();
    for (const r of rows) byChain.set(r.chain_id, [...(byChain.get(r.chain_id) ?? []), r.notification_id]);
    for (const [chainId, ids] of byChain) {
      await recordRecovery(db, chainId, {
        kind: 'outbox_requeue',
        summary: `${ids.length} notification(s) were published but no effect was recorded within ${this.cfg.republishAfterMs}ms; put back to pending`,
        details: { notificationIds: ids.slice(0, 20), total: ids.length },
      });
    }
    logger.warn({ event: 'outbox.requeued', count: rows.length }, 'published outbox rows with no recorded effect were re-queued');
    return rows.length;
  }
}
