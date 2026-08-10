import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` only. **`drizzle-kit push` is banned** and appears in no script:
 * it is the fastest way to make a production database and the migration history disagree,
 * and the disagreement is invisible until a restore.
 *
 * Migrations are forward-only and never edited after being pushed. Rollback is
 * restore-from-backup; destructive changes use expand/contract across two releases.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
