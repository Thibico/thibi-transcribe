import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { closeDb, createDb, type Db } from './client.js';
import { migrate } from './migrate.js';

/**
 * Test-database helper.
 *
 * One migrated template per worker *process*, then `CREATE DATABASE … TEMPLATE` per test
 * file. That buys real isolation — a test can truncate anything it likes — without paying
 * the migration cost thirty times.
 *
 * The fallback if a CI role cannot create databases is one schema per file with a
 * `search_path`; this is decided up front rather than after forty tests assume templates.
 */

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const TEMPLATE_PREFIX = 'thibi_test_template_';

// Scoped to the process, which is the unit `templatePromise` below can actually coalesce.
// This said "one template per run" and used a single shared name until 2026-08-10, when CI
// failed with `23505 … Key (datname)=(thibi_test_template) already exists`: two test files
// in different vitest projects call createTestDb, vitest runs projects in separate worker
// processes, and a module-level promise cannot coalesce across them. Both raced on the same
// drop-then-create. It had only ever passed on timing luck — the window is a few
// milliseconds — and the same race can lose a template out from under a running suite,
// which is the worse and quieter half of the bug.
//
// Per-process names remove the race by construction rather than by locking. The cost is one
// migration per worker instead of one per run: two or three, against the thirty this
// template exists to avoid.
const TEMPLATE = `${TEMPLATE_PREFIX}${process.pid}`;

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

/** Is this process still running? EPERM means alive and owned by someone else. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Drop templates left by processes that have since exited.
 *
 * Per-process naming means nothing reclaims the previous run's template, so without this a
 * developer's Postgres collects one database per worker per run indefinitely. Liveness is
 * the safe discriminator: a concurrent worker's template belongs to a live pid and is left
 * alone, so this cannot reintroduce the cross-process interference the naming just removed.
 *
 * Best-effort throughout. A drop fails while another connection holds the database, which
 * is a reason to move on rather than to fail a test run that has not started yet.
 */
async function sweepStaleTemplates(admin: pg.Client): Promise<void> {
  try {
    // Matched in JS rather than with LIKE: `_` is a single-character wildcard there, so the
    // obvious `like 'thibi_test_template_%'` is a wider net than it reads as.
    const { rows } = await admin.query<{ datname: string }>(`select datname from pg_database`);
    for (const { datname } of rows) {
      // The pre-2026-08-10 shared name. Nothing creates it any more; drop it once so the
      // rename does not strand a database on every machine that ran the old helper.
      const legacy = datname === TEMPLATE_PREFIX.slice(0, -1);
      if (!legacy) {
        if (!datname.startsWith(TEMPLATE_PREFIX)) continue;
        const pid = Number(datname.slice(TEMPLATE_PREFIX.length));
        if (!Number.isInteger(pid) || pid === process.pid || pidAlive(pid)) continue;
      }
      try {
        await admin.query(`drop database if exists ${datname} with (force)`);
      } catch {
        // Someone else's, still in use, or dropped underneath us. Not ours to insist on.
      }
    }
  } catch {
    // A role that cannot read pg_database can still run its own tests.
  }
}

/** Build the migrated template once per process, coalescing concurrent callers. */
async function ensureTemplate(baseUrl: string): Promise<void> {
  templatePromise ??= (async () => {
    const admin = new pg.Client({ connectionString: adminUrl(baseUrl) });
    await admin.connect();
    try {
      await sweepStaleTemplates(admin);
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
