import pg from 'pg';
import { databaseUrl } from '../../scenarios/harness.js';

/**
 * Integration tests need a real PostgreSQL. Fail early with instructions instead of letting every
 * test time out on a refused connection. (Skipping would turn a missing dependency into a green run.)
 */
export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 4_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (err) {
    throw new Error(
      `Integration tests need PostgreSQL at DATABASE_URL (${databaseUrl().replace(/:[^:@/]*@/, ':***@')}).\n` +
        `Start the services with:  docker compose up -d --wait\n` +
        `Original error: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
