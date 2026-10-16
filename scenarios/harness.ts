import { randomBytes } from 'node:crypto';
import type { EventKind, EventStatus, Hex } from '../src/domain/types.js';
import { buildWatchIndex, type WatchEntry, type WatchIndex } from '../src/domain/watchlist.js';
import { FIXTURE_WATCHLIST } from '../src/fixtures/accounts.js';
import { FixtureChain } from '../src/fixtures/chain.js';
import { FixtureNotifier } from '../src/fixtures/notifier.js';
import { FixtureProvider } from '../src/fixtures/provider.js';
import { DEFAULT_RETRY, Scanner, type ScannerConfig } from '../src/ingestion/scanner.js';
import type { RetryPolicy } from '../src/ingestion/retry.js';
import { CrashPoints } from '../src/observability/failpoints.js';
import { LogCapture } from '../src/observability/logger.js';
import { Metrics } from '../src/observability/metrics.js';
import { checkInvariants, type InvariantReport } from '../src/recovery/invariants.js';
import { Db } from '../src/storage/db.js';
import { dropSchema, migrate } from '../src/storage/migrate.js';

export const DEFAULT_DATABASE_URL = 'postgres://sandbox:sandbox@127.0.0.1:5432/cers';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export interface SandboxOptions {
  chainId?: number;
  seed?: string;
  /** 'scripted' (default) emits only what the caller asks for; 'random' adds seeded background traffic. */
  traffic?: 'random' | 'scripted';
  confirmationDepth?: number;
  maxReorgDepth?: number;
  batchSize?: number;
  startBlock?: number;
  watch?: readonly WatchEntry[];
  retry?: RetryPolicy;
}

export interface EventView {
  eventId: string;
  blockNumber: number;
  blockHash: Hex;
  logIndex: number;
  kind: EventKind;
  contract: Hex;
  status: EventStatus;
  amount: bigint;
  confirmCount: number;
  seenCount: number;
}

export interface Counts {
  provisional: number;
  confirmed: number;
  orphaned: number;
  canonical: number;
}

/**
 * A complete, isolated test bed: its own PostgreSQL schema, a deterministic fixture chain with a
 * fault-injectable provider and notifier, and a scanner wired to all of it. Tests and the scenario
 * runner share this class, so a scenario and a test of the same behavior exercise the same code.
 * Constructing a second scanner on the same sandbox models a process restart: new instance, same database.
 */
export class Sandbox {
  readonly logs = new LogCapture();
  readonly metrics = new Metrics();
  readonly crash = new CrashPoints();
  /** Back-off delays the scanner asked for. Nothing actually sleeps; this is the evidence. */
  readonly sleeps: number[] = [];
  scanner: Scanner;

  private constructor(
    readonly schema: string,
    readonly db: Db,
    readonly chain: FixtureChain,
    readonly provider: FixtureProvider,
    readonly notifier: FixtureNotifier,
    readonly watch: WatchIndex,
    readonly options: Required<Omit<SandboxOptions, 'watch' | 'retry'>> & { retry: RetryPolicy },
  ) {
    this.scanner = this.newScanner();
  }

  static async create(opts: SandboxOptions = {}): Promise<Sandbox> {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    await migrate({ connectionString: databaseUrl(), schema });
    const db = new Db({ connectionString: databaseUrl(), schema, max: 6, applicationName: `sandbox-${schema}` });
    const watch = buildWatchIndex(opts.watch ?? FIXTURE_WATCHLIST);
    const chainId = opts.chainId ?? 31337;
    const chain = new FixtureChain({ chainId, seed: opts.seed ?? 'sandbox', watch, traffic: opts.traffic ?? 'scripted' });
    return new Sandbox(schema, db, chain, new FixtureProvider(chain), new FixtureNotifier(chain), watch, {
      chainId,
      seed: opts.seed ?? 'sandbox',
      traffic: opts.traffic ?? 'scripted',
      confirmationDepth: opts.confirmationDepth ?? 3,
      maxReorgDepth: opts.maxReorgDepth ?? 10,
      batchSize: opts.batchSize ?? 5,
      startBlock: opts.startBlock ?? 0,
      retry: opts.retry ?? { ...DEFAULT_RETRY, maxAttempts: 4 },
    });
  }

  get chainId(): number {
    return this.options.chainId;
  }

  scannerConfig(overrides: Partial<ScannerConfig> = {}): ScannerConfig {
    return {
      chainId: this.options.chainId,
      startBlock: this.options.startBlock,
      batchSize: this.options.batchSize,
      confirmationDepth: this.options.confirmationDepth,
      maxReorgDepth: this.options.maxReorgDepth,
      retry: this.options.retry,
      maxStaleRetries: 20,
      maxStepsPerScan: 500,
      ...overrides,
    };
  }

  /** A fresh scanner over the same database and provider - what a restarted worker process would be. */
  newScanner(overrides: Partial<ScannerConfig> = {}): Scanner {
    return new Scanner(
      {
        db: this.db,
        provider: this.provider,
        watch: this.watch,
        logger: this.logs.logger(),
        metrics: this.metrics,
        crash: this.crash,
        sleep: (ms) => {
          this.sleeps.push(ms);
          return Promise.resolve();
        },
      },
      this.scannerConfig(overrides),
    );
  }

  async destroy(): Promise<void> {
    await this.db.close();
    await dropSchema(databaseUrl(), this.schema);
  }

  // ---- Inspecting stored state ---------------------------------------------------------------------

  async events(): Promise<EventView[]> {
    const { rows } = await this.db.query<{
      event_id: string;
      block_number: number;
      block_hash: Hex;
      log_index: number;
      kind: EventKind;
      contract_address: Hex;
      status: EventStatus;
      amount: string;
      confirm_count: number;
      seen_count: number;
    }>(
      `SELECT event_id, block_number, block_hash, log_index, kind, contract_address, status, amount::text AS amount, confirm_count, seen_count
         FROM chain_events WHERE chain_id = $1 ORDER BY block_number, log_index, block_hash`,
      [this.chainId],
    );
    return rows.map((r) => ({
      eventId: r.event_id,
      blockNumber: r.block_number,
      blockHash: r.block_hash,
      logIndex: r.log_index,
      kind: r.kind,
      contract: r.contract_address,
      status: r.status,
      amount: BigInt(r.amount),
      confirmCount: r.confirm_count,
      seenCount: r.seen_count,
    }));
  }

  async counts(): Promise<Counts> {
    const { rows } = await this.db.query<{ status: EventStatus; n: number }>(
      'SELECT status, count(*)::int AS n FROM chain_events WHERE chain_id = $1 GROUP BY status',
      [this.chainId],
    );
    const by = new Map(rows.map((r) => [r.status, r.n]));
    const provisional = by.get('provisional') ?? 0;
    const confirmed = by.get('confirmed') ?? 0;
    return { provisional, confirmed, orphaned: by.get('orphaned') ?? 0, canonical: provisional + confirmed };
  }

  async checkpoint(): Promise<{ number: number; hash: Hex | null; status: string; version: number }> {
    const { rows } = await this.db.query<{ last_block_number: number; last_block_hash: Hex | null; scan_status: string; version: number }>(
      'SELECT last_block_number, last_block_hash, scan_status, version FROM scanner_checkpoints WHERE chain_id = $1',
      [this.chainId],
    );
    const row = rows[0];
    if (!row) throw new Error('no checkpoint row');
    return { number: row.last_block_number, hash: row.last_block_hash, status: row.scan_status, version: row.version };
  }

  async flows(): Promise<Array<{ token: string; account: string; inbound: bigint; outbound: bigint }>> {
    const { rows } = await this.db.query<{ token_address: string; account: string; inbound: string; outbound: string }>(
      `SELECT token_address, account, inbound::text AS inbound, outbound::text AS outbound
         FROM account_flows WHERE chain_id = $1 AND (inbound <> 0 OR outbound <> 0) ORDER BY token_address, account`,
      [this.chainId],
    );
    return rows.map((r) => ({ token: r.token_address, account: r.account, inbound: BigInt(r.inbound), outbound: BigInt(r.outbound) }));
  }

  async alerts(): Promise<{ open: number; withdrawn: number }> {
    const { rows } = await this.db.query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM alerts WHERE chain_id = $1 GROUP BY status',
      [this.chainId],
    );
    const by = new Map(rows.map((r) => [r.status, r.n]));
    return { open: by.get('open') ?? 0, withdrawn: by.get('withdrawn') ?? 0 };
  }

  async count(table: string, where = 'true', params: unknown[] = []): Promise<number> {
    if (!/^[a-z_]+$/.test(table)) throw new Error('bad table name');
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE chain_id = $1 AND (${where})`,
      [this.chainId, ...params],
    );
    return rows[0]?.n ?? 0;
  }

  async invariants(): Promise<InvariantReport> {
    return checkInvariants(this.db, { chainId: this.chainId, confirmationDepth: this.options.confirmationDepth, watch: this.watch });
  }

  /** Canonical block hashes in the database, by height. */
  async canonicalBlocks(): Promise<Array<{ number: number; hash: Hex }>> {
    const { rows } = await this.db.query<{ block_number: number; block_hash: Hex }>(
      'SELECT block_number, block_hash FROM chain_blocks WHERE chain_id = $1 AND canonical ORDER BY block_number',
      [this.chainId],
    );
    return rows.map((r) => ({ number: r.block_number, hash: r.block_hash }));
  }
}
