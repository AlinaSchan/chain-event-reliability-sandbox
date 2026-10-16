import { existsSync } from 'node:fs';

export interface AppConfig {
  databaseUrl: string;
  dbSchema: string;
  /** null = run without the notification pipeline. */
  redisUrl: string | null;
  redisKeyPrefix: string;
  chainId: number;
  fixtureSeed: string;
  fixtureAutomineMs: number;
  fixtureInitialBlocks: number;
  /** Optional JSON file with a watchlist; the built-in synthetic one is used when unset. */
  watchlistFile: string | null;
  consumerName: string;
  startBlock: number;
  batchSize: number;
  confirmationDepth: number;
  maxReorgDepth: number;
  pollIntervalMs: number;
  logLevel: string;
  api: {
    host: string;
    port: number;
    adminEnabled: boolean;
    adminToken: string | null;
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n - ${problems.join('\n - ')}`);
  }
}

/** Reads `.env` if present. Variables already set in the environment win. */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host);

/**
 * Validates every setting and reports all problems at once. There are no silent fallbacks to values
 * that would change behavior: an unparseable number is an error, not a default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const text = (name: string, fallback?: string): string => {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    problems.push(`${name} is required`);
    return '';
  };
  const int = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
      return fallback;
    }
    return value;
  };
  const flag = (name: string): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
    if (raw === 'true' || raw === '1') return true;
    problems.push(`${name} must be true or false, got ${JSON.stringify(env[name])}`);
    return false;
  };

  const databaseUrl = text('DATABASE_URL');
  const dbSchema = text('DB_SCHEMA', 'public');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbSchema)) problems.push(`DB_SCHEMA is not a plain lowercase identifier: ${JSON.stringify(dbSchema)}`);

  const confirmationDepth = int('CONFIRMATION_DEPTH', 12, 1, 10_000);
  const maxReorgDepth = int('MAX_REORG_DEPTH', 64, 1, 100_000);
  if (maxReorgDepth < confirmationDepth) {
    problems.push(
      `MAX_REORG_DEPTH (${maxReorgDepth}) must be at least CONFIRMATION_DEPTH (${confirmationDepth}); otherwise a reorganization that is still inside the confirmation window would halt the scanner instead of being corrected`,
    );
  }

  const host = text('API_HOST', '127.0.0.1');
  const adminEnabled = flag('ADMIN_ENABLED');
  const adminToken = env.ADMIN_TOKEN?.trim() || null;
  if (adminEnabled) {
    if (!isLoopback(host)) {
      problems.push(`ADMIN_ENABLED=true requires API_HOST to be a loopback address (127.0.0.1, ::1 or localhost), got ${JSON.stringify(host)}`);
    }
    if (adminToken === null || adminToken.length < 16) problems.push('ADMIN_ENABLED=true requires ADMIN_TOKEN of at least 16 characters');
  }

  const config: AppConfig = {
    databaseUrl,
    dbSchema,
    redisUrl: env.REDIS_URL?.trim() || null,
    redisKeyPrefix: text('REDIS_KEY_PREFIX', 'cers'),
    chainId: int('CHAIN_ID', 31337, 1),
    fixtureSeed: text('FIXTURE_SEED', 'cers-demo'),
    fixtureAutomineMs: int('FIXTURE_AUTOMINE_MS', 0, 0, 3_600_000),
    fixtureInitialBlocks: int('FIXTURE_INITIAL_BLOCKS', 30, 0, 100_000),
    watchlistFile: env.WATCHLIST_FILE?.trim() || null,
    consumerName: text('CONSUMER_NAME', 'consumer-1'),
    startBlock: int('START_BLOCK', 0, 0),
    batchSize: int('BATCH_SIZE', 20, 1, 1_000),
    confirmationDepth,
    maxReorgDepth,
    pollIntervalMs: int('POLL_INTERVAL_MS', 5_000, 0, 3_600_000),
    logLevel: text('LOG_LEVEL', 'info'),
    api: { host, port: int('API_PORT', 3000, 0, 65_535), adminEnabled, adminToken },
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
