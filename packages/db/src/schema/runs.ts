import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';

export interface RunPipeline {
  seams?: Array<{
    afterChunk: number;
    method: 'lcs' | 'hard-cut' | 'no-words' | 'empty';
    score: number;
    droppedWords: number;
    flagged: boolean;
  }>;
  warnings?: Array<{ code: string; message: string; chunk?: number; segment?: number }>;
  [key: string]: unknown;
}

/**
 * One attempt at transcribing a job.
 *
 * Runs are append-only. Re-transcribing creates a new run rather than deleting segments —
 * the old app did `DELETE FROM segments WHERE run_id` at `lib/queue.ts:110`, which throws
 * away a transcript a journalist may already have corrected.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    languageCode: text('language_code').notNull(),

    /**
     * Measured 2026-08-09 (spike S3): chunked parallel sync is faster than batch at every
     * duration, so `sync_chunked` is the default at any length and `batch` is an admin
     * cost choice rather than the long-file path.
     */
    mode: text('mode', { enum: ['sync', 'sync_chunked', 'batch'] }).notNull(),

    state: text('state', {
      enum: ['pending', 'running', 'done', 'failed', 'partial', 'cancelled'],
    })
      .notNull()
      .default('pending'),

    /** Seams, warnings and per-stage detail. Surfaced in the CLI JSON and Phase 12's UI. */
    pipeline: jsonb('pipeline').$type<RunPipeline>().notNull().default({}),
    progress: doublePrecision('progress').notNull().default(0),

    /** Computed from the response, never assumed. The minimum across chunks. */
    wordTimingQuality: text('word_timing_quality', { enum: ['full', 'partial', 'none'] }),

    /**
     * Phase 2 columns. They exist from migration 0000 so adding batch support is a code
     * change rather than a migration, and stay NULL until then.
     */
    operationName: text('operation_name'),
    stagingPrefix: text('staging_prefix'),

    costUsd: doublePrecision('cost_usd'),
    engineVersion: text('engine_version').notNull(),

    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    error: jsonb('error').$type<Record<string, unknown> | null>(),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('runs_job_created').on(t.jobId, t.createdAt),
    index('runs_state').on(t.state),
    check('runs_progress_range', sql`${t.progress} >= 0 and ${t.progress} <= 1`),
  ],
);

/**
 * The chunk plan.
 *
 * Rows are written **before any network call**, so a crash mid-run leaves a complete record
 * of what was meant to happen and Phase 9 can resume rather than restart.
 */
export const runChunks = pgTable(
  'run_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),

    /** Where the extracted audio starts: `contentStartMs - overlapLeadMs`. */
    offsetMs: integer('offset_ms').notNull(),
    /** The planned boundary — the seam this chunk owns from. */
    contentStartMs: integer('content_start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    /**
     * How much earlier than its boundary this chunk starts. 0 for chunk 0.
     *
     * Measured 2026-08-09: hard cuts lose 2-3 words at every seam (2.1% of words at 30
     * minutes, 3.4% at 2 hours). This lead is what the LCS merge de-duplicates against.
     */
    overlapLeadMs: integer('overlap_lead_ms').notNull().default(0),

    storageKey: text('storage_key'),
    /** The archived provider response for this chunk. */
    rawKey: text('raw_key'),

    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    error: jsonb('error').$type<Record<string, unknown> | null>(),
    bytes: bigint('bytes', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('run_chunks_run_idx').on(t.runId, t.idx),
    index('run_chunks_run_status').on(t.runId, t.status),
    check('run_chunks_interval', sql`${t.offsetMs} <= ${t.contentStartMs} and ${t.contentStartMs} <= ${t.endMs}`),
  ],
);
