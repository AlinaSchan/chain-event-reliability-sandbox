import { writeSync } from 'node:fs';
import { buildWatchIndex } from '../src/domain/watchlist.js';
import { FIXTURE_WATCHLIST } from '../src/fixtures/accounts.js';
import { FixtureChain } from '../src/fixtures/chain.js';
import { FixtureProvider } from '../src/fixtures/provider.js';
import { Scanner } from '../src/ingestion/scanner.js';
import { CrashPoints, type CrashPointName } from '../src/observability/failpoints.js';
import { silentLogger } from '../src/observability/logger.js';
import { Metrics } from '../src/observability/metrics.js';
import { NotificationConsumer } from '../src/queue/consumer.js';
import { RedisStreamQueue } from '../src/queue/redis-streams.js';
import { Db } from '../src/storage/db.js';

/**
 * Test helper (see tests/fault-injection/hard-kill.test.ts). Runs a scanner or a consumer in its own
 * process and, at a named failpoint, kills THAT PROCESS with SIGKILL: no finally blocks, no rollback in
 * our code, no graceful close - the operating system drops the database and Redis connections and the
 * servers deal with whatever was in flight. That is the crash the in-process failpoints stand in for.
 */
class SelfKill extends CrashPoints {
  constructor(
    private readonly target: CrashPointName | undefined,
    private remaining: number,
  ) {
    super();
  }

  override hit(point: CrashPointName): void {
    if (point !== this.target) return;
    if (this.remaining-- > 0) return;
    writeSync(1, `KILL ${point}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
}

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const role = env('ROLE');
const db = new Db({ connectionString: env('DATABASE_URL'), schema: env('SCHEMA'), max: 3, applicationName: `crash-child-${role}` });
const crash = new SelfKill(process.env.KILL_POINT as CrashPointName | undefined, Number(process.env.KILL_AFTER_HITS ?? 0));

if (role === 'scanner') {
  const watch = buildWatchIndex(FIXTURE_WATCHLIST);
  const chain = new FixtureChain({ chainId: 31337, seed: env('SEED'), watch, traffic: 'random' });
  chain.mine(Number(env('BLOCKS')));
  const scanner = new Scanner(
    { db, provider: new FixtureProvider(chain), watch, logger: silentLogger(), metrics: new Metrics(), crash },
    {
      chainId: 31337,
      startBlock: 0,
      batchSize: Number(env('BATCH')),
      confirmationDepth: Number(env('DEPTH')),
      maxReorgDepth: 10,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 },
      maxStaleRetries: 20,
      maxStepsPerScan: 1000,
    },
  );
  const report = await scanner.scanOnce('startup');
  writeSync(1, `COMPLETED ${report.outcome} blocks=${report.blocksIngested}\n`);
} else if (role === 'consumer') {
  const queue = new RedisStreamQueue({ url: env('REDIS_URL'), streamKey: env('STREAM_KEY'), group: 'notifier', connectionName: 'crash-child-consumer' });
  const consumer = new NotificationConsumer(
    { db, queue, logger: silentLogger(), metrics: new Metrics(), crash },
    { consumerName: env('CONSUMER_NAME'), batchSize: 20, claimIdleMs: 60_000 },
  );
  const report = await consumer.processBatch();
  writeSync(1, `COMPLETED received=${report.received} delivered=${report.delivered}\n`);
  await queue.close();
} else {
  throw new Error(`unknown ROLE ${role}`);
}
await db.close();
process.exit(0);
