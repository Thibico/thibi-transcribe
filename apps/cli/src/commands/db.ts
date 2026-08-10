import { Command } from 'commander';
import pg from 'pg';
import {
  closeDb,
  createDb,
  DEFAULT_RATES,
  migrate,
  migrationStatus,
  seedRates,
  MIGRATIONS_DIR,
} from '@thibi/db';
import { readEnvironment } from '../context.js';
import { EXIT } from '../output.js';

function requireDatabaseUrl(): string {
  const url = readEnvironment().DATABASE_URL;
  if (!url) {
    process.stderr.write(
      'DATABASE_URL is not set. Start the dev stack with\n' +
        '  docker compose -f infra/compose.dev.yml up -d\n',
    );
    process.exitCode = EXIT.notConfigured;
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}

export function dbCommand(): Command {
  const db = new Command('db').description('Database migrations');

  db.command('migrate')
    .description('Apply pending migrations')
    .action(async () => {
      const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
      try {
        const result = await migrate(pool, MIGRATIONS_DIR);
        if (result.applied.length === 0) {
          process.stdout.write(`nothing to apply (${result.alreadyApplied.length} already up)\n`);
        }
        for (const name of result.applied) process.stdout.write(`applied ${name}\n`);
      } finally {
        await pool.end();
      }
    });

  db.command('status')
    .description('Show which migrations have been applied')
    .action(async () => {
      const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
      try {
        const rows = await migrationStatus(pool, MIGRATIONS_DIR);
        for (const row of rows) {
          const state = row.changed
            ? 'CHANGED SINCE APPLIED'
            : row.appliedAt
              ? row.appliedAt.toISOString().slice(0, 19).replace('T', ' ')
              : 'pending';
          process.stdout.write(`${row.name.padEnd(40)} ${state}\n`);
        }
        // Migrations are forward-only and never edited after being pushed; a changed
        // checksum means the database no longer matches the code that built it.
        if (rows.some((r) => r.changed)) process.exitCode = EXIT.usage;
      } finally {
        await pool.end();
      }
    });

  db.command('seed')
    .description('Insert or refresh the default provider rates. Never overwrites an override.')
    .action(async () => {
      const client = createDb({ url: requireDatabaseUrl(), max: 2 });
      try {
        const result = await seedRates(client);
        process.stdout.write(
          `rates: ${result.inserted} inserted, ${result.updated} updated, ` +
            `${result.skippedOverrides} left alone (source=override)\n`,
        );
        // The numbers came from a dated catalog read, and a stale price is the kind of
        // wrong that nobody notices. Say where they are from every time.
        for (const rate of DEFAULT_RATES) {
          process.stdout.write(
            `  ${rate.providerId}/${rate.model}/${rate.unit}`.padEnd(34) +
              `$${rate.usdPerUnit}\n`,
          );
        }
      } finally {
        await closeDb(client);
      }
    });

  db.command('reset')
    .description('Drop every table and re-apply migrations. Destroys all data.')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (opts) => {
      if (!opts.yes) {
        process.stderr.write(
          'This drops every table in the database and destroys all transcripts.\n' +
            'Re-run with --yes if that is what you want.\n',
        );
        process.exitCode = EXIT.usage;
        return;
      }
      const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
      try {
        await pool.query('drop schema public cascade; create schema public;');
        const result = await migrate(pool, MIGRATIONS_DIR);
        process.stdout.write(`reset; applied ${result.applied.length} migration(s)\n`);
      } finally {
        await pool.end();
      }
    });

  return db;
}
