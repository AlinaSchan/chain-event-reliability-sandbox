import { RpcError, RpcExhaustedError } from '../domain/errors.js';
import type { BlockHeader, HeadRef, Hex, ScanTrigger } from '../domain/types.js';
import type { WatchIndex } from '../domain/watchlist.js';
import type { CrashPoints } from '../observability/failpoints.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { openIncident, recordRecovery } from '../storage/audit.js';
import {
  ensureCheckpoint,
  getCheckpoint,
  haltCheckpoint,
  lockCheckpoint,
  setHealth,
  StaleCheckpointError,
  unhaltCheckpoint,
  type Checkpoint,
} from '../storage/checkpoint.js';
import type { Db } from '../storage/db.js';
import { applyBatch, type ApplyDeps } from './apply.js';
import type { ChainProvider } from './ports.js';
import { prepareBlocks, type PreparedBlock } from './prepare.js';
import { realSleep, withRetry, type RetryHooks, type RetryPolicy } from './retry.js';

export interface ScannerConfig {
  chainId: number;
  /** First block to ingest. The block at this height is the trust anchor; its parent is not checked. */
  startBlock: number;
  batchSize: number;
  /** Blocks that must sit on top of an event before it is confirmed. */
  confirmationDepth: number;
  /** Deepest reorganization rolled back automatically. Anything deeper halts the scanner. */
  maxReorgDepth: number;
  retry: RetryPolicy;
  /** Consecutive lost checkpoint races tolerated in one scan before giving the cycle up (the next cycle starts fresh). */
  maxStaleRetries: number;
  /** Safety valve on the number of steps in one scan. */
  maxStepsPerScan: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 2_000 };

export interface ScannerDeps {
  db: Db;
  provider: ChainProvider;
  watch: WatchIndex;
  logger: Logger;
  metrics: Metrics;
  crash?: CrashPoints;
  /** Injected so tests can run retries without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export type ScanOutcome = 'caught_up' | 'provider_behind' | 'halted' | 'rpc_failed' | 'stale_writer_limit' | 'step_limit';

export interface ScanReport {
  trigger: ScanTrigger;
  outcome: ScanOutcome;
  steps: number;
  blocksIngested: number;
  eventsInserted: number;
  eventsDuplicate: number;
  eventsReactivated: number;
  eventsConfirmed: number;
  reorgs: number;
  retries: number;
  staleWriterAborts: number;
  fromBlock: number | null;
  toBlock: number | null;
  backfill: { from: number; to: number } | null;
  error?: string;
}

type StepResult = 'advanced' | 'reorg_applied' | 'caught_up' | 'provider_behind' | 'halted';

function emptyReport(trigger: ScanTrigger): ScanReport {
  return {
    trigger,
    outcome: 'caught_up',
    steps: 0,
    blocksIngested: 0,
    eventsInserted: 0,
    eventsDuplicate: 0,
    eventsReactivated: 0,
    eventsConfirmed: 0,
    reorgs: 0,
    retries: 0,
    staleWriterAborts: 0,
    fromBlock: null,
    toBlock: null,
    backfill: null,
  };
}

/**
 * Drives one chain from the stored checkpoint to the provider's head.
 *
 * The provider is asked three questions - what is your head, what is the header at height N, what
 * are the logs in this range - and everything else comes from PostgreSQL. A head notification is never
 * an input; at most it is the reason `scanOnce` gets called.
 */
export class Scanner {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: ScannerDeps,
    readonly cfg: ScannerConfig,
  ) {
    this.sleep = deps.sleep ?? realSleep;
  }

  private get applyDeps(): ApplyDeps {
    return { db: this.deps.db, logger: this.deps.logger, metrics: this.deps.metrics, crash: this.deps.crash };
  }

  /** Scans until the checkpoint matches the provider's head, the scanner halts, or the provider keeps failing. */
  async scanOnce(trigger: ScanTrigger = 'manual'): Promise<ScanReport> {
    const { db, logger, metrics } = this.deps;
    const { chainId } = this.cfg;
    const report = emptyReport(trigger);
    metrics.inc('scan_cycles_total');

    const initial = await ensureCheckpoint(db, chainId, this.cfg.startBlock);
    report.fromBlock = initial.lastBlockNumber + 1;
    if (trigger === 'startup') await this.recordStart(initial);
    let degradedAtStart = initial.scanStatus === 'degraded';
    let staleStreak = 0; // lost checkpoint races in a row; any step that gets through resets it

    for (let i = 0; i < this.cfg.maxStepsPerScan; i++) {
      const cp = (await getCheckpoint(db, chainId)) ?? initial;
      if (cp.scanStatus === 'halted') return this.finish(report, 'halted');
      report.steps += 1;
      try {
        const result = await this.step(cp, trigger, report);
        staleStreak = 0;
        if (result !== 'halted' && degradedAtStart) {
          degradedAtStart = false;
          await setHealth(db, chainId, 'ok', null);
          logger.info({ event: 'scanner.recovered', chainId }, 'provider reachable again; scan status back to ok');
        }
        if (result === 'advanced' || result === 'reorg_applied') continue;
        if (result === 'halted') return this.finish(report, 'halted');
        return this.finish(report, result);
      } catch (err) {
        if (err instanceof StaleCheckpointError) {
          report.staleWriterAborts += 1;
          metrics.inc('stale_writer_aborts_total');
          logger.info(
            { event: 'writer.stale', chainId, expectedVersion: err.expectedVersion, actualVersion: err.actualVersion },
            'another writer moved the checkpoint first; starting over from stored state',
          );
          staleStreak += 1;
          if (staleStreak > this.cfg.maxStaleRetries) return this.finish(report, 'stale_writer_limit');
          continue;
        }
        if (err instanceof RpcExhaustedError || err instanceof RpcError) {
          metrics.inc('rpc_exhausted_total');
          report.error = err.message;
          logger.warn({ event: 'rpc.exhausted', chainId, error: err.message }, 'provider kept failing; no state was changed');
          await setHealth(db, chainId, 'degraded', { error: err.message, at: new Date().toISOString() });
          return this.finish(report, 'rpc_failed');
        }
        throw err;
      }
    }
    return this.finish(report, 'step_limit');
  }

  /**
   * Re-reads `[from, to]` (clamped to what is already processed) and re-applies it. Everything already
   * stored is recognised by identity and left alone; anything missing is inserted. Used to verify a
   * range or to heal a gap, never to move the checkpoint.
   */
  async replayRange(from: number, to: number): Promise<ScanReport> {
    const { db, logger } = this.deps;
    const { chainId } = this.cfg;
    const report = emptyReport('manual');
    const cp = await ensureCheckpoint(db, chainId, this.cfg.startBlock);
    if (cp.scanStatus === 'halted') return this.finish(report, 'halted');
    const lower = Math.max(from, cp.startBlock);
    const upper = Math.min(to, cp.lastBlockNumber);
    report.fromBlock = lower;
    for (let start = lower; start <= upper; start += this.cfg.batchSize) {
      const end = Math.min(upper, start + this.cfg.batchSize - 1);
      const blocks = await this.fetchPrepared(start, end, report);
      const res = await applyBatch(this.applyDeps, {
        chainId,
        mode: 'replay',
        trigger: 'manual',
        expectedVersion: null,
        blocks,
        confirmationDepth: this.cfg.confirmationDepth,
        watch: this.deps.watch,
      });
      report.steps += 1;
      report.eventsInserted += res.eventsInserted;
      report.eventsDuplicate += res.eventsDuplicate;
      report.eventsReactivated += res.eventsReactivated;
      report.eventsConfirmed += res.confirmed;
      report.toBlock = end;
    }
    if (upper >= lower) {
      await recordRecovery(db, chainId, {
        kind: 'replay',
        fromBlock: lower,
        toBlock: upper,
        summary: `replayed blocks ${lower}..${upper}: ${report.eventsInserted} event(s) were missing and inserted, ${report.eventsDuplicate} repeat sighting(s) ignored`,
        details: { inserted: report.eventsInserted, duplicates: report.eventsDuplicate },
      });
      logger.info({ event: 'replay.done', chainId, from: lower, to: upper, inserted: report.eventsInserted, duplicates: report.eventsDuplicate }, 'range replayed');
    }
    return this.finish(report, 'caught_up');
  }

  /** Operator action: clear a halt after the cause has been dealt with. */
  async unhalt(note: string): Promise<boolean> {
    const { db, logger } = this.deps;
    const { chainId } = this.cfg;
    const changed = await db.tx(async (tx) => {
      await lockCheckpoint(tx, chainId);
      const cleared = await unhaltCheckpoint(tx, chainId);
      if (cleared) {
        await recordRecovery(tx, chainId, { kind: 'unhalt', summary: `halt cleared by an operator: ${note}`, details: { note } });
        await tx.query(
          `UPDATE incidents SET status = 'resolved', resolved_at = now(), resolution_note = $2
            WHERE chain_id = $1 AND kind = 'scanner_halted' AND status = 'open'`,
          [chainId, note],
        );
      }
      return cleared;
    });
    if (changed) logger.warn({ event: 'scanner.unhalted', chainId, note }, 'halt cleared by an operator');
    return changed;
  }

  // ---- One step -----------------------------------------------------------------------------------

  private async step(cp: Checkpoint, trigger: ScanTrigger, report: ScanReport): Promise<StepResult> {
    const { logger } = this.deps;
    const { chainId } = this.cfg;
    const head = await this.rpc('getHead', () => this.deps.provider.getHead(), report);

    if (cp.lastBlockHash !== null) {
      if (head.number < cp.lastBlockNumber) {
        // Either the provider is lagging (or answered from a stale cache) or the chain really got shorter.
        // Only a hash mismatch at the provider's own height proves the latter.
        const local = await this.canonicalHashAt(head.number);
        if (local === head.hash) {
          logger.info(
            { event: 'provider.behind', chainId, providerHead: head, checkpoint: { number: cp.lastBlockNumber, hash: cp.lastBlockHash } },
            'provider head is behind the checkpoint and consistent with it; nothing to do',
          );
          return 'provider_behind';
        }
        return this.handleReorg(cp, head, report);
      }
      // Verify the tip we hold is still the provider's block at that height, even if nothing new arrived.
      const remoteTipHash = head.number === cp.lastBlockNumber ? head.hash : (await this.fetchHeader(cp.lastBlockNumber, report)).hash;
      if (remoteTipHash !== cp.lastBlockHash) return this.handleReorg(cp, head, report);
      if (head.number === cp.lastBlockNumber) return 'caught_up';
    } else if (head.number < cp.startBlock) {
      return 'caught_up';
    }

    const from = cp.lastBlockNumber + 1;
    const to = Math.min(head.number, from + this.cfg.batchSize - 1);
    if (report.backfill === null && report.reorgs === 0 && head.number - cp.lastBlockNumber > 1) {
      report.backfill = { from, to: head.number };
      this.deps.metrics.inc('backfills_total');
      logger.info(
        { event: 'backfill.range', chainId, trigger, checkpoint: cp.lastBlockNumber, providerHead: head, from, to: head.number },
        'checkpoint is behind the head; backfilling the range from stored state',
      );
      await recordRecovery(this.deps.db, chainId, {
        kind: 'backfill',
        fromBlock: from,
        toBlock: head.number,
        summary:
          cp.lastBlockHash === null
            ? `nothing ingested yet; initial sync of blocks ${from}..${head.number} (trigger: ${trigger})`
            : `checkpoint ${cp.lastBlockNumber} is ${head.number - cp.lastBlockNumber} block(s) behind head ${head.number}; backfilling ${from}..${head.number} (trigger: ${trigger})`,
        details: { trigger, checkpoint: cp.lastBlockNumber, providerHead: head },
      });
    }

    const blocks = await this.fetchPrepared(from, to, report);
    const first = blocks[0];
    if (!first) return 'caught_up';
    if (cp.lastBlockHash !== null && first.header.parentHash !== cp.lastBlockHash) {
      // The chain changed between the tip check and the range fetch.
      return this.handleReorg(cp, head, report);
    }

    const res = await applyBatch(this.applyDeps, {
      chainId,
      mode: 'forward',
      trigger,
      expectedVersion: cp.version,
      blocks,
      confirmationDepth: this.cfg.confirmationDepth,
      watch: this.deps.watch,
    });
    this.tally(report, res.blocksInserted + res.blocksReactivated, res);
    report.toBlock = res.tip.number;
    return 'advanced';
  }

  // ---- Reorganization -----------------------------------------------------------------------------

  private async handleReorg(cp: Checkpoint, head: HeadRef, report: ScanReport): Promise<StepResult> {
    const { logger } = this.deps;
    const { chainId } = this.cfg;
    const oldTip: HeadRef = { number: cp.lastBlockNumber, hash: cp.lastBlockHash as Hex };

    const search = await this.findCommonAncestor(cp, head, report);
    if (!search.ancestor) {
      await this.halt(cp, head, search.diagnostics);
      return 'halted';
    }
    const ancestor = search.ancestor;
    logger.warn(
      { event: 'reorg.detected', chainId, storedTip: oldTip, providerHead: head, commonAncestor: ancestor, depth: oldTip.number - ancestor.number },
      'stored chain no longer matches the provider; rolling back to the common ancestor',
    );

    const from = ancestor.number + 1;
    const to = Math.min(head.number, from + this.cfg.batchSize - 1);
    const blocks = to >= from ? await this.fetchPrepared(from, to, report) : [];
    const first = blocks[0];
    if (first && first.header.parentHash !== ancestor.hash) {
      throw new RpcError('INCONSISTENT', `replacement block ${first.header.number} does not attach to common ancestor ${ancestor.number}`);
    }

    const res = await applyBatch(this.applyDeps, {
      chainId,
      mode: 'reorg',
      trigger: report.trigger,
      expectedVersion: cp.version,
      blocks,
      reorg: {
        ancestor,
        oldTip,
        reason: `reorganization: blocks above ${ancestor.number} (stored tip ${oldTip.number}) are no longer on the provider's canonical chain`,
      },
      confirmationDepth: this.cfg.confirmationDepth,
      watch: this.deps.watch,
    });
    report.reorgs += 1;
    this.tally(report, res.blocksInserted + res.blocksReactivated, res);
    report.toBlock = res.tip.number;
    return 'reorg_applied';
  }

  /**
   * Walks down from the lower of (our tip, the provider's head) comparing the hash we stored at each
   * height with the provider's, up to `maxReorgDepth` below our tip. If no height agrees, or we have no
   * history left to compare, there is no safe rollback target and the answer is "none", with the evidence.
   */
  private async findCommonAncestor(
    cp: Checkpoint,
    head: HeadRef,
    report: ScanReport,
  ): Promise<{ ancestor: HeadRef; diagnostics?: undefined } | { ancestor: null; diagnostics: Record<string, unknown> }> {
    const lowest = Math.max(cp.startBlock, cp.lastBlockNumber - this.cfg.maxReorgDepth);
    const probes: Array<{ height: number; stored: string | null; provider: string }> = [];
    for (let height = Math.min(cp.lastBlockNumber, head.number); height >= lowest; height--) {
      const stored = await this.canonicalHashAt(height);
      if (stored === null) {
        probes.push({ height, stored: null, provider: 'not compared: no stored block' });
        break;
      }
      const provider = height === head.number ? head.hash : (await this.fetchHeader(height, report)).hash;
      probes.push({ height, stored, provider });
      if (provider === stored) return { ancestor: { number: height, hash: stored } };
    }
    return {
      ancestor: null,
      diagnostics: {
        reason: 'no_common_ancestor_within_max_reorg_depth',
        storedTip: { number: cp.lastBlockNumber, hash: cp.lastBlockHash },
        providerHead: head,
        maxReorgDepth: this.cfg.maxReorgDepth,
        searchedDownTo: lowest,
        startBlock: cp.startBlock,
        probes: probes.slice(0, 10),
        probesTotal: probes.length,
      },
    };
  }

  private async halt(cp: Checkpoint, head: HeadRef, diagnostics: Record<string, unknown>): Promise<void> {
    const { db, logger, metrics } = this.deps;
    const { chainId } = this.cfg;
    const summary =
      `no common ancestor with the provider within ${this.cfg.maxReorgDepth} blocks of stored tip ${cp.lastBlockNumber} ` +
      `(provider head ${head.number}); automatic rollback refused`;
    await db.tx(async (tx) => {
      const locked = await lockCheckpoint(tx, chainId);
      if (locked.version !== cp.version) throw new StaleCheckpointError(cp.version, locked.version);
      await haltCheckpoint(tx, chainId, diagnostics);
      await recordRecovery(tx, chainId, { kind: 'halt', fromBlock: cp.lastBlockNumber, toBlock: head.number, summary, details: diagnostics });
      await openIncident(tx, chainId, { kind: 'scanner_halted', severity: 'critical', requiresManualReview: true, summary, details: diagnostics });
    });
    metrics.inc('scanner_halts_total');
    const { probes: _probes, ...summaryForLog } = diagnostics;
    logger.error({ event: 'scanner.halted', chainId, ...summaryForLog }, 'scanner halted: manual intervention required (full probe list is in scanner_checkpoints.status_detail)');
  }

  // ---- Provider access ----------------------------------------------------------------------------

  private hooks(report: ScanReport): RetryHooks {
    return {
      sleep: this.sleep,
      onRetry: ({ operation, attempt, delayMs, error }) => {
        report.retries += 1;
        this.deps.metrics.inc('rpc_retries_total');
        this.deps.logger.warn(
          { event: 'rpc.retry', chainId: this.cfg.chainId, operation, attempt, delayMs, code: error.code, error: error.message },
          'transient provider error; retrying',
        );
      },
    };
  }

  private rpc<T>(operation: string, fn: () => Promise<T>, report: ScanReport): Promise<T> {
    return withRetry(operation, fn, this.cfg.retry, this.hooks(report));
  }

  private fetchHeader(number: number, report: ScanReport): Promise<BlockHeader> {
    return this.rpc(`getHeader(${number})`, async () => {
      const header = await this.deps.provider.getHeader(number);
      if (!header) throw new RpcError('INCONSISTENT', `provider has no header for block ${number}`);
      return header;
    }, report);
  }

  /** Headers and logs for the range, fetched and cross-checked as one retryable unit. */
  private fetchPrepared(from: number, to: number, report: ScanReport): Promise<PreparedBlock[]> {
    return withRetry(
      `fetchRange(${from}..${to})`,
      async () => {
        const headers: BlockHeader[] = [];
        for (let n = from; n <= to; n++) {
          const header = await this.deps.provider.getHeader(n);
          if (!header) throw new RpcError('INCONSISTENT', `provider has no header for block ${n}`);
          headers.push(header);
        }
        const logs = await this.deps.provider.getLogs({ fromBlock: from, toBlock: to, addresses: this.deps.watch.addresses });
        return prepareBlocks(this.cfg.chainId, headers, logs, this.deps.watch);
      },
      this.cfg.retry,
      this.hooks(report),
    );
  }

  private async canonicalHashAt(height: number): Promise<Hex | null> {
    const { rows } = await this.deps.db.query<{ block_hash: Hex }>(
      'SELECT block_hash FROM chain_blocks WHERE chain_id = $1 AND canonical AND block_number = $2',
      [this.cfg.chainId, height],
    );
    return rows[0]?.block_hash ?? null;
  }

  // ---- Bookkeeping --------------------------------------------------------------------------------

  private async recordStart(cp: Checkpoint): Promise<void> {
    const { db, logger } = this.deps;
    const { chainId } = this.cfg;
    if (cp.lastBlockHash === null) {
      logger.info({ event: 'scanner.start', chainId, startBlock: cp.startBlock }, 'no checkpoint yet; starting from the configured start block');
      return;
    }
    logger.info(
      { event: 'scanner.resume', chainId, checkpoint: { number: cp.lastBlockNumber, hash: cp.lastBlockHash }, version: cp.version },
      'resuming from the durable checkpoint in PostgreSQL',
    );
    await recordRecovery(db, chainId, {
      kind: 'resume',
      fromBlock: cp.lastBlockNumber + 1,
      summary: `worker started; resumed from durable checkpoint ${cp.lastBlockNumber} (${cp.lastBlockHash})`,
      details: { checkpoint: { number: cp.lastBlockNumber, hash: cp.lastBlockHash }, version: cp.version },
    });
  }

  private tally(
    report: ScanReport,
    blocks: number,
    res: { eventsInserted: number; eventsDuplicate: number; eventsReactivated: number; confirmed: number },
  ): void {
    report.blocksIngested += blocks;
    report.eventsInserted += res.eventsInserted;
    report.eventsDuplicate += res.eventsDuplicate;
    report.eventsReactivated += res.eventsReactivated;
    report.eventsConfirmed += res.confirmed;
  }

  private finish(report: ScanReport, outcome: ScanOutcome): ScanReport {
    report.outcome = outcome;
    return report;
  }
}
