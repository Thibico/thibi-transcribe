import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/**
 * Our own migration runner, ~80 lines.
 *
 * Not `drizzle-kit migrate`, because Phase 15 runs this as the compose one-shot that every
 * other service `depends_on: service_completed_successfully`, and that wants a plain Node
 * entry point with no dev tooling in the production image.
 *
 * Properties that matter:
 *  - an advisory lock, so two containers starting at once do not both apply 0000
 *  - one transaction per file, so a failure leaves a consistent database
 *  - a recorded checksum, so editing an applied migration is caught rather than ignored
 */

const ADVISORY_LOCK_KEY = 0x7468_6962; // 'thib'

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

async function ensureTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);
}

export async function readMigrations(
  dir: string,
): Promise<Array<{ name: string; sql: string; checksum: string }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    }),
  );
}

export async function migrate(pool: pg.Pool, dir: string): Promise<MigrationResult> {
  const migrations = await readMigrations(dir);
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  try {
    // Session-level, released explicitly: a second container blocks here rather than
    // racing to apply the same file.
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureTable(client);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const migration of migrations) {
      const recorded = seen.get(migration.name);
      if (recorded !== undefined) {
        if (recorded !== migration.checksum) {
          // Migrations are forward-only and never edited after being pushed. If this
          // fires, someone changed history and the database no longer matches the code.
          throw new Error(
            `Migration ${migration.name} has changed since it was applied ` +
              `(recorded ${recorded}, now ${migration.checksum}). Migrations are ` +
              `forward-only: add a new one instead of editing this.`,
          );
        }
        result.alreadyApplied.push(migration.name);
        continue;
      }

      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('commit');
        result.applied.push(migration.name);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${migration.name} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
    return result;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export interface MigrationStatus {
  name: string;
  appliedAt: Date | null;
  changed: boolean;
}

export async function migrationStatus(pool: pg.Pool, dir: string): Promise<MigrationStatus[]> {
  const migrations = await readMigrations(dir);
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const { rows } = await client.query<{ name: string; checksum: string; applied_at: Date }>(
      'select name, checksum, applied_at from schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.name, r]));
    return migrations.map((m) => {
      const row = seen.get(m.name);
      return {
        name: m.name,
        appliedAt: row?.applied_at ?? null,
        changed: row !== undefined && row.checksum !== m.checksum,
      };
    });
  } finally {
    client.release();
  }
}
