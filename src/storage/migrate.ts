import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSchemaName } from './db.js';

export interface MigrateOptions {
  connectionString: string;
  schema: string;
  dir?: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

/**
 * Applies `migrations/NNN_*.sql` in order, each in its own transaction, recording a checksum.
 * A migration that was edited after being applied is an error, not a silent no-op.
 */
export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  assertSchemaName(opts.schema);
  const dir = opts.dir ?? defaultMigrationsDir();
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    // One migrator at a time per schema (two services starting together must not race on DDL).
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`cers:migrate:${opts.schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
    await client.query(`SET search_path TO "${opts.schema}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         checksum   text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(file);
      if (prior !== undefined) {
        if (prior !== checksum) throw new Error(`migration ${file} was modified after it was applied`);
        alreadyApplied.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
  } finally {
    await client.end(); // also releases the advisory lock
  }
  return { applied, alreadyApplied };
}

/** Drops a schema created for a test or scenario run. Refuses to touch `public`. */
export async function dropSchema(connectionString: string, schema: string): Promise<void> {
  assertSchemaName(schema);
  if (schema === 'public') throw new Error('refusing to drop the public schema');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}
