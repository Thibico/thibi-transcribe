import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { closeDb, createDb, type Db } from './client.js';
import { migrate } from './migrate.js';

/**
 * Test-database helper.
 *
 * One migrated template per test *run*, then `CREATE DATABASE … TEMPLATE` per test file.
 * That buys real isolation — a test can truncate anything it likes — without paying the
 * migration cost thirty times.
 *
 * The fallback if a CI role cannot create databases is one schema per file with a
 * `search_path`; this is decided up front rather than after forty tests assume templates.
 */

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const TEMPLATE = 'thibi_test_template';

function adminUrl(url: string): string {
  // Connect to `postgres` to issue CREATE DATABASE — you cannot drop or template a
  // database you are connected to.
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/** Is a Postgres reachable at this URL? Used to skip DB suites on a clone with no Docker. */
export async function postgresReachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: adminUrl(url), connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

let templatePromise: Promise<void> | null = null;

/** Build the migrated template once per process, coalescing concurrent callers. */
async function ensureTemplate(baseUrl: string): Promise<void> {
  templatePromise ??= (async () => {
    const admin = new pg.Client({ connectionString: adminUrl(baseUrl) });
    await admin.connect();
    try {
      await admin.query(`drop database if exists ${TEMPLATE}`);
      await admin.query(`create database ${TEMPLATE}`);
    } finally {
      await admin.end();
    }

    const pool = new pg.Pool({ connectionString: withDatabase(baseUrl, TEMPLATE) });
    try {
      await migrate(pool, MIGRATIONS_DIR);
    } finally {
      await pool.end();
    }
  })();
  return templatePromise;
}

export interface TestDb {
  db: Db;
  url: string;
  name: string;
  drop: () => Promise<void>;
}

let counter = 0;

/**
 * Create a fresh migrated database. Call `drop()` in `afterAll`.
 *
 * `TEST_DATABASE_URL` points at the dev Postgres from `infra/compose.dev.yml`, which
 * listens on 5433 so it cannot collide with a Homebrew Postgres on 5432.
 */
export async function createTestDb(baseUrl: string): Promise<TestDb> {
  await ensureTemplate(baseUrl);

  const name = `thibi_test_${process.pid}_${counter++}`;
  const admin = new pg.Client({ connectionString: adminUrl(baseUrl) });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name} template ${TEMPLATE}`);
  } finally {
    await admin.end();
  }

  const url = withDatabase(baseUrl, name);
  const db = createDb({ url, max: 4, applicationName: 'thibi-test' });

  return {
    db,
    url,
    name,
    async drop() {
      await closeDb(db);
      const cleanup = new pg.Client({ connectionString: adminUrl(baseUrl) });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists ${name} with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export const DEFAULT_TEST_DATABASE_URL = 'postgres://thibi:thibi@localhost:5433/thibi';
