import type { Logger } from '../observability/logger.js';
import type { ConsumerReport, NotificationConsumer } from './consumer.js';
import type { OutboxPublisher, PublishReport } from './publisher.js';

export interface PipelineStatus {
  running: boolean;
  passes: number;
  lastPassAt: string | null;
  publisher: { lastReport: PublishReport | null; lastError: string | null; requeuedTotal: number };
  consumer: { lastReport: ConsumerReport | null; lastError: string | null };
}

/**
 * Drives the outbox publisher, the stream consumer and the stale-row reconciler on a fixed interval.
 * One pass never lets a failure in one step block the others, and no failure kills the loop: a Redis
 * outage shows up as `lastError` and as a growing pending count, and clears itself when Redis returns.
 */
export class PipelineWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private passes = 0;
  private lastPassAt: string | null = null;
  private requeuedTotal = 0;
  private publisherReport: PublishReport | null = null;
  private publisherError: string | null = null;
  private consumerReport: ConsumerReport | null = null;
  private consumerError: string | null = null;

  constructor(
    private readonly deps: { publisher: OutboxPublisher; consumer: NotificationConsumer; logger: Logger },
    private readonly cfg: { intervalMs: number },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // A slow pass must not overlap the next one.
      this.inFlight ??= this.runOnce().finally(() => {
        this.inFlight = null;
      });
    }, this.cfg.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** One pass: publish pending rows, consume messages, re-queue rows that were published but never settled. */
  async runOnce(): Promise<void> {
    const { publisher, consumer, logger } = this.deps;
    try {
      this.publisherReport = await publisher.publishPending();
      this.publisherError = this.publisherReport.error ?? null;
    } catch (err) {
      this.publisherError = (err as Error).message;
      logger.error({ event: 'pipeline.publisher_failed', error: this.publisherError }, 'publisher pass failed');
    }
    try {
      this.consumerReport = await consumer.processBatch();
      this.consumerError = this.consumerReport.error ?? null;
    } catch (err) {
      this.consumerError = (err as Error).message;
      logger.error({ event: 'pipeline.consumer_failed', error: this.consumerError }, 'consumer pass failed');
    }
    try {
      this.requeuedTotal += await publisher.requeueStale();
    } catch (err) {
      logger.error({ event: 'pipeline.requeue_failed', error: (err as Error).message }, 'reconciler pass failed');
    }
    this.passes += 1;
    this.lastPassAt = new Date().toISOString();
  }

  status(): PipelineStatus {
    return {
      running: this.timer !== null,
      passes: this.passes,
      lastPassAt: this.lastPassAt,
      publisher: { lastReport: this.publisherReport, lastError: this.publisherError, requeuedTotal: this.requeuedTotal },
      consumer: { lastReport: this.consumerReport, lastError: this.consumerError },
    };
  }
}
