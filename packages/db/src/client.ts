import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export interface CreateDbOptions {
  url: string;
  /** Default 10. The worker sizes this to its concurrency; the CLI needs very few. */
  max?: number;
  /** Log every statement. `LOG_LEVEL=debug` in the CLI turns this on. */
  logger?: boolean;
  applicationName?: string;
}

/**
 * Integer milliseconds arrive from Postgres as numbers, but `bigint` columns come back as
 * strings by default because a 64-bit integer does not fit a JS number. `words.id` is the
 * only bigint we read back and it is always well within Number.MAX_SAFE_INTEGER, so parse
 * it — a string primary key would silently break every comparison downstream.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export function createDb(options: CreateDbOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'thibi',
    // A stuck connection must not hold a chunk's transaction open indefinitely.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // An idle-client error (server restart, network blip) is emitted on the pool, and an
  // unhandled 'error' event takes the process down. Log and let the pool replace it.
  pool.on('error', (err) => {
    process.emitWarning(`postgres idle client error: ${err.message}`, 'ThibiDbWarning');
  });

  return drizzle(pool, { schema, logger: options.logger ?? false });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}

/**
 * Run `fn` in a transaction.
 *
 * Thin wrapper over Drizzle's own, present so callers depend on our name rather than
 * Drizzle's shape — Phase 9's `run_steps` reconciler needs to add advisory locking here
 * and should not have to touch every call site to do it.
 */
export async function withTransaction<T>(
  db: Db,
  fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}
