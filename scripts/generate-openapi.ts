import { writeFileSync } from 'node:fs';
import { buildServer } from '../src/api/server.js';
import { buildWatchIndex } from '../src/domain/watchlist.js';
import { FIXTURE_WATCHLIST } from '../src/fixtures/accounts.js';
import { Db } from '../src/storage/db.js';
import { Metrics } from '../src/observability/metrics.js';
import { silentLogger } from '../src/observability/logger.js';
import { SCENARIOS, toCatalog } from '../scenarios/index.js';
import type { ApiContext } from '../src/api/context.js';

/**
 * Writes docs/openapi.json from the route schemas the server actually validates with, so the
 * documentation cannot drift from the code (tests/unit/openapi.test.ts fails if it does).
 * No database connection is made; the admin routes are included so they are documented too.
 *
 *   npm run openapi            regenerate
 *   npm run openapi -- --check exit 1 if the committed file is stale
 */
export async function generateOpenApi(): Promise<string> {
  const never = new Db({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused', max: 1 });
  const stub = { query: () => Promise.reject(new Error('not used')) };
  const ctx: ApiContext = {
    db: never,
    chainId: 31337,
    confirmationDepth: 12,
    maxReorgDepth: 64,
    watch: buildWatchIndex(FIXTURE_WATCHLIST),
    logger: silentLogger(),
    metrics: new Metrics(),
    provider: { chainId: 31337, getHead: () => stub.query(), getHeader: () => stub.query(), getLogs: () => stub.query() },
    worker: null,
    pipeline: null,
    queue: null,
    scenarios: SCENARIOS.map(toCatalog),
    host: '127.0.0.1',
    admin: {
      enabled: true,
      token: 'documentation-only-token',
      controls: { chain: {} as never, provider: {} as never, notifier: {} as never, scanner: {} as never },
    },
  };
  const app = await buildServer(ctx);
  try {
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
    await never.close();
  }
}

if (process.argv[1]?.endsWith('generate-openapi.ts')) {
  const target = new URL('../docs/openapi.json', import.meta.url);
  const fresh = await generateOpenApi();
  if (process.argv.includes('--check')) {
    const { readFileSync } = await import('node:fs');
    const current = readFileSync(target, 'utf8');
    if (current !== fresh) {
      console.error('docs/openapi.json is stale; run: npm run openapi');
      process.exit(1);
    }
    console.log('docs/openapi.json is up to date');
  } else {
    writeFileSync(target, fresh);
    console.log('wrote docs/openapi.json');
  }
}
