import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { SCENARIOS, toCatalog } from '../../scenarios/index.js';
import { buildServer } from '../api/server.js';
import type { FixtureControls } from '../api/context.js';
import { buildWatchIndex, type WatchEntry, type WatchIndex } from '../domain/watchlist.js';
import { FIXTURE_WATCHLIST } from '../fixtures/accounts.js';
import { FixtureChain } from '../fixtures/chain.js';
import { FixtureNotifier } from '../fixtures/notifier.js';
import { FixtureProvider } from '../fixtures/provider.js';
import { DEFAULT_RETRY, Scanner } from '../ingestion/scanner.js';
import { ScannerWorker } from '../ingestion/worker.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { Metrics } from '../observability/metrics.js';
import { NotificationConsumer } from '../queue/consumer.js';
import { PipelineWorker } from '../queue/pipeline.js';
import { OutboxPublisher } from '../queue/publisher.js';
import type { StreamQueue } from '../queue/queue.js';
import { RedisStreamQueue } from '../queue/redis-streams.js';
import { Db } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import type { AppConfig } from './config.js';

export interface Runtime {
  config: AppConfig;
  db: Db;
  logger: Logger;
  metrics: Metrics;
  watch: WatchIndex;
  fixture: FixtureControls;
  worker: ScannerWorker;
  queue: StreamQueue | null;
  pipeline: PipelineWorker | null;
  server: FastifyInstance;
  start(): Promise<{ address: string }>;
  stop(): Promise<void>;
}

export function loadWatchlist(file: string | null): WatchIndex {
  if (!file) return buildWatchIndex(FIXTURE_WATCHLIST);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array of watched contracts`);
  return buildWatchIndex(parsed as WatchEntry[]);
}

/**
 * Wires the whole service from configuration: PostgreSQL, the deterministic fixture chain and its
 * notifier, the scanner worker, (when REDIS_URL is set) the outbox publisher and stream consumer, and
 * the local API. Nothing starts until `start()`.
 */
export async function createRuntime(config: AppConfig, opts: { logger?: Logger } = {}): Promise<Runtime> {
  const logger = opts.logger ?? createLogger({ level: config.logLevel, name: 'cers' });
  const metrics = new Metrics();

  const migration = await migrate({ connectionString: config.databaseUrl, schema: config.dbSchema });
  logger.info({ event: 'migrate.done', schema: config.dbSchema, applied: migration.applied }, 'database schema is up to date');
  const db = new Db({ connectionString: config.databaseUrl, schema: config.dbSchema, applicationName: 'cers-app' });

  const watch = loadWatchlist(config.watchlistFile);
  const chain = new FixtureChain({ chainId: config.chainId, seed: config.fixtureSeed, watch, traffic: 'random' });
  chain.mine(config.fixtureInitialBlocks);
  const provider = new FixtureProvider(chain);
  const notifier = new FixtureNotifier(chain);

  const scanner = new Scanner(
    { db, provider, watch, logger, metrics },
    {
      chainId: config.chainId,
      startBlock: config.startBlock,
      batchSize: config.batchSize,
      confirmationDepth: config.confirmationDepth,
      maxReorgDepth: config.maxReorgDepth,
      retry: DEFAULT_RETRY,
      maxStaleRetries: 50,
      maxStepsPerScan: 10_000,
    },
  );
  const worker = new ScannerWorker({ scanner, notifier, logger }, { pollIntervalMs: config.pollIntervalMs, errorBackoffMs: 1_000 });
  const fixture: FixtureControls = { chain, provider, notifier, scanner };

  let queue: StreamQueue | null = null;
  let pipeline: PipelineWorker | null = null;
  if (config.redisUrl) {
    queue = new RedisStreamQueue({ url: config.redisUrl, streamKey: `${config.redisKeyPrefix}:notifications`, group: 'notifier', connectionName: `cers-${config.consumerName}` });
    const publisher = new OutboxPublisher({ db, queue, logger, metrics }, { batchSize: 50, republishAfterMs: 60_000 });
    const consumer = new NotificationConsumer({ db, queue, logger, metrics }, { consumerName: config.consumerName, batchSize: 50, claimIdleMs: 30_000 });
    pipeline = new PipelineWorker({ publisher, consumer, logger }, { intervalMs: 500 });
  } else {
    logger.warn({ event: 'queue.disabled' }, 'REDIS_URL is not set: events and checkpoints work, but no notifications are published or delivered');
  }

  const server = await buildServer({
    db,
    chainId: config.chainId,
    confirmationDepth: config.confirmationDepth,
    maxReorgDepth: config.maxReorgDepth,
    watch,
    logger,
    metrics,
    provider,
    worker,
    pipeline,
    queue,
    scenarios: SCENARIOS.map(toCatalog),
    host: config.api.host,
    admin: { enabled: config.api.adminEnabled, token: config.api.adminToken, controls: fixture },
  });

  let automine: NodeJS.Timeout | null = null;
  return {
    config,
    db,
    logger,
    metrics,
    watch,
    fixture,
    worker,
    queue,
    pipeline,
    server,
    async start() {
      worker.start();
      pipeline?.start();
      if (config.fixtureAutomineMs > 0) {
        automine = setInterval(() => chain.mine(1), config.fixtureAutomineMs);
        automine.unref();
      }
      const address = await server.listen({ host: config.api.host, port: config.api.port });
      logger.info(
        { event: 'app.started', address, chainId: config.chainId, confirmationDepth: config.confirmationDepth, queue: queue ? 'redis' : 'disabled', admin: config.api.adminEnabled },
        'service started',
      );
      return { address };
    },
    async stop() {
      if (automine) clearInterval(automine);
      await worker.stop();
      await pipeline?.stop();
      await server.close();
      await queue?.close();
      await db.close();
      logger.info({ event: 'app.stopped' }, 'service stopped');
    },
  };
}
