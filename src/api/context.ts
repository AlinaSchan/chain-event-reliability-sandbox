import type { WatchIndex } from '../domain/watchlist.js';
import type { FixtureChain } from '../fixtures/chain.js';
import type { FixtureNotifier } from '../fixtures/notifier.js';
import type { FixtureProvider } from '../fixtures/provider.js';
import type { ChainProvider } from '../ingestion/ports.js';
import type { Scanner } from '../ingestion/scanner.js';
import type { WorkerStatus } from '../ingestion/worker.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { PipelineStatus } from '../queue/pipeline.js';
import type { StreamQueue } from '../queue/queue.js';
import type { Db } from '../storage/db.js';

/** What the admin routes may touch. Only exists when the service runs on the in-process fixture chain. */
export interface FixtureControls {
  chain: FixtureChain;
  provider: FixtureProvider;
  notifier: FixtureNotifier;
  scanner: Scanner;
}

export interface ScenarioCatalogEntry {
  id: string;
  title: string;
  summary: string;
  fixture: string;
  faults: string[];
  expected: string[];
  acceptance: string;
  evidence: string[];
  requires: string[];
  checks: Array<{ id: string; description: string }>;
}

/** Everything the HTTP layer needs, passed in explicitly so it can be tested without starting the service. */
export interface ApiContext {
  db: Db;
  chainId: number;
  confirmationDepth: number;
  maxReorgDepth: number;
  watch: WatchIndex;
  logger: Logger;
  metrics: Metrics;
  provider: ChainProvider;
  worker: { status(): WorkerStatus } | null;
  pipeline: { status(): PipelineStatus } | null;
  queue: StreamQueue | null;
  scenarios: readonly ScenarioCatalogEntry[];
  host: string;
  admin: { enabled: boolean; token: string | null; controls: FixtureControls | null };
}
