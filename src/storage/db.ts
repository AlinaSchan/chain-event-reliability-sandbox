import pg from 'pg';

/** Anything that can run a query: the pool, or the client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export type Tx = Queryable;

export interface DbOptions {
  connectionString: string;
  /** PostgreSQL schema to work in. Tests and scenario runs each get their own. */
  schema?: string;
  max?: number;
  applicationName?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertSchemaName(schema: string): void {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
}

/**
 * bigint columns (block numbers, ids, chain ids) come back as JS numbers: every value this project
 * stores there is far below 2^53. `numeric` columns stay strings and are converted with BigInt at the
 * call site, so on-chain amounts never pass through a float.
 */
const typeParsers = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') => {
    if (oid === 20) return (value: string) => Number(value);
    return pg.types.getTypeParser(oid, format);
  },
};

export class Db implements Queryable {
  readonly pool: pg.Pool;
  readonly schema: string;

  constructor(opts: DbOptions) {
    this.schema = opts.schema ?? 'public';
    assertSchemaName(this.schema);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 8,
      application_name: opts.applicationName ?? 'chain-event-sandbox',
      // A writer waiting on a checkpoint lock for this long is stuck, not slow. A transaction left idle
      // by a dead caller is rolled back by the server instead of holding locks forever.
      options: `-c search_path=${this.schema} -c lock_timeout=15000 -c idle_in_transaction_session_timeout=60000`,
      types: typeParsers,
    });
    // An idle client erroring (server restart) must not crash the process; the next checkout reconnects.
    this.pool.on('error', () => undefined);
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /**
   * Runs `fn` in one READ COMMITTED transaction. Correctness does not depend on the isolation level:
   * writers serialize on an explicit row lock (see storage/checkpoint.ts), not on snapshot behavior.
   */
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // connection is gone; the server aborts the transaction, we drop the client
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
