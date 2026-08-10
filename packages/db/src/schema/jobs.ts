import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { mediaAssets } from './media.js';

/**
 * No `orgs` table: one instance per newsroom is a confirmed decision. `projects` gives the
 * grouping newsrooms actually want ("Election 2026") and is the scoping unit for
 * glossaries. If multi-tenancy ever arrives it is one migration.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    defaultLanguageCode: text('default_language_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_slug').on(t.slug)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),

    /**
     * The language of this job's audio.
     *
     * This column is the replacement for `languageCode: "my-MM"` hardcoded at
     * `lib/queue.ts:118` in the old app. It is a registry code, resolved through
     * `@thibi/languages`; the provider maps it to its own wire code.
     */
    languageCode: text('language_code').notNull(),

    status: text('status', {
      enum: ['pending', 'running', 'done', 'failed', 'partial', 'cancelled'],
    })
      .notNull()
      .default('pending'),

    /** The run whose transcript this job currently presents. Re-transcribing repoints it. */
    primaryRunId: uuid('primary_run_id'),

    /**
     * The client-generated key of the batch that created this job, or null for a single
     * ingest. Makes `POST /api/ingest/batch` idempotent.
     *
     * A column rather than a table because the only question ever asked of it is "did this
     * batch already create a job for this asset in this project", which the unique index below
     * answers by refusing the insert. Without it, a flaky connection at the confirm step
     * creates twenty duplicate jobs and twenty duplicate bills.
     */
    sourceBatchKey: text('source_batch_key'),

    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('jobs_project_created').on(t.projectId, t.createdAt),
    index('jobs_status').on(t.status),
    index('jobs_asset').on(t.assetId),
    // Partial, so the millions of single-ingest jobs with a null key do not all collide —
    // and because NULLs do not compare equal, an unfiltered unique index would silently
    // enforce nothing at all here rather than what it appears to.
    uniqueIndex('jobs_batch_uniq')
      .on(t.projectId, t.sourceBatchKey, t.assetId)
      .where(sql`${t.sourceBatchKey} is not null`),
  ],
);
