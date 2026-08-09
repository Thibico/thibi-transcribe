// @thibi/db — Drizzle schema and committed SQL migrations.
//
// Drizzle because the schema is the shared type surface between db, engine and web.
// `drizzle-kit generate` emits plain .sql which is committed and applied by our own runner,
// so Phase 15 can run migrations as a compose one-shot with no dev tooling in the image.
//
// `drizzle-kit push` is banned and appears in no script.

export * from './schema/index.js';
export { closeDb, createDb, withTransaction, type CreateDbOptions, type Db } from './client.js';
export {
  migrate,
  migrationStatus,
  readMigrations,
  type MigrationResult,
  type MigrationStatus,
} from './migrate.js';
export { copyWords, wordRowToCopyLine, type WordRow } from './copy.js';
export {
  createTestDb,
  postgresReachable,
  DEFAULT_TEST_DATABASE_URL,
  MIGRATIONS_DIR,
  type TestDb,
} from './testing.js';
