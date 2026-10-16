import type { ScanTrigger } from '../domain/types.js';
import type { Logger } from '../observability/logger.js';
import type { HeadNotifier } from './ports.js';
import { realSleep } from './retry.js';
import type { ScanOutcome, Scanner } from './scanner.js';

export interface WorkerConfig {
  /** Safety-net scan interval. 0 disables it (tests and scenarios drive scans explicitly). */
  pollIntervalMs: number;
  /** Pause after a cycle that could not finish (provider down, lost races) before trying again. */
  errorBackoffMs: number;
}

export interface WorkerStatus {
  state: 'stopped' | 'idle' | 'scanning' | 'backing_off';
  cycles: number;
  lastCycle: { at: string; trigger: ScanTrigger; outcome: ScanOutcome; blocksIngested: number; reorgs: number } | null;
  lastError: string | null;
  notifications: { connected: boolean; headsReceived: number };
}

/**
 * Runs the scanner when something suggests the head moved: a head notification, a (re)connect, a
 * periodic poll, or startup. Triggers are coalesced - ten notifications during one scan cause at most
 * one more scan - and a notification is never trusted for its content, only as a reason to look.
 */
export class ScannerWorker {
  private stopped = true;
  private state: WorkerStatus['state'] = 'stopped';
  private pending: ScanTrigger | null = null;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private poll: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private idleWaiters: Array<() => void> = [];
  private cycles = 0;
  private lastCycle: WorkerStatus['lastCycle'] = null;
  private lastError: string | null = null;
  private connected = true;
  private headsReceived = 0;

  constructor(
    private readonly deps: { scanner: Scanner; notifier: HeadNotifier | null; logger: Logger },
    private readonly cfg: WorkerConfig,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.state = 'idle';
    this.unsubscribe =
      this.deps.notifier?.subscribe({
        onHead: () => {
          this.headsReceived += 1;
          this.trigger('notification');
        },
        onConnect: () => {
          this.connected = true;
          this.deps.logger.info({ event: 'notifier.connected' }, 'notification stream (re)connected; reconciling against stored state');
          this.trigger('reconnect');
        },
        onDisconnect: () => {
          this.connected = false;
          this.deps.logger.warn({ event: 'notifier.disconnected' }, 'notification stream disconnected; relying on the poll and on reconnect to catch up');
        },
      }) ?? null;
    if (this.cfg.pollIntervalMs > 0) {
      this.poll = setInterval(() => this.trigger('poll'), this.cfg.pollIntervalMs);
      this.poll.unref();
    }
    this.pending = 'startup';
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.wake?.();
    await this.loopDone;
    this.state = 'stopped';
    this.release();
  }

  trigger(reason: ScanTrigger): void {
    if (this.stopped) return;
    this.pending ??= reason;
    this.wake?.();
  }

  /** Resolves when no scan is running and none is queued. For tests, scenarios and graceful shutdown. */
  idle(): Promise<void> {
    if (this.stopped || (this.pending === null && this.state !== 'scanning' && this.state !== 'backing_off')) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  status(): WorkerStatus {
    return {
      state: this.state,
      cycles: this.cycles,
      lastCycle: this.lastCycle,
      lastError: this.lastError,
      notifications: { connected: this.connected, headsReceived: this.headsReceived },
    };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.pending === null) {
        this.state = 'idle';
        this.release();
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
        continue;
      }
      const trigger = this.pending;
      this.pending = null;
      this.state = 'scanning';
      let retryAfterBackoff: boolean;
      try {
        const report = await this.deps.scanner.scanOnce(trigger);
        this.cycles += 1;
        this.lastError = report.error ?? null;
        this.lastCycle = {
          at: new Date().toISOString(),
          trigger,
          outcome: report.outcome,
          blocksIngested: report.blocksIngested,
          reorgs: report.reorgs,
        };
        retryAfterBackoff = report.outcome === 'rpc_failed' || report.outcome === 'stale_writer_limit' || report.outcome === 'step_limit';
      } catch (err) {
        // Unexpected (database down, bug). Keep the process alive, say so, and try again.
        this.lastError = (err as Error).message;
        this.deps.logger.error({ event: 'worker.cycle_failed', trigger, error: this.lastError }, 'scan cycle failed unexpectedly');
        retryAfterBackoff = true;
      }
      if (retryAfterBackoff && !this.stopped) {
        this.state = 'backing_off';
        await realSleep(this.cfg.errorBackoffMs);
        this.pending ??= 'poll';
      }
    }
  }

  private release(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
