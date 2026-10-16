import { ConfigError, loadConfig, loadDotEnv } from '../src/app/config.js';
import { migrate } from '../src/storage/migrate.js';

loadDotEnv();
try {
  const config = loadConfig();
  const result = await migrate({ connectionString: config.databaseUrl, schema: config.dbSchema });
  console.log(JSON.stringify({ event: 'migrate.done', schema: config.dbSchema, applied: result.applied, alreadyApplied: result.alreadyApplied }));
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `migration failed: ${(err as Error).message}`);
  process.exit(1);
}
