import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { runs } from './runs.js';

/**
 * Speakers are scoped to the **job**, not the run.
 *
 * This is the decision in Phase 3 most worth defending. A re-transcription creates a new
 * `runs` row and a new `diarization_runs` row, but *"Speaker 01 is Daw Khin"* is a fact
 * about the recording, not about a run. Scoping speakers to a run would discard the name
 * on every re-transcription — the most annoying possible bug in this feature, and one that
 * only appears after a user has already done real work. `diarize/identity.ts` is what
 * carries the mapping across, by Hungarian assignment over attributed time.
 */
export const speakers = pgTable(
  'speakers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    /** Our stable label, `speaker-00`. Not the diarizer's — see `speaker_turns.raw_key`. */
    key: text('key').notNull(),
    /** NULL until a human names them. The whole point of this table. */
    displayName: text('display_name'),
    colorIdx: smallint('color_idx').notNull().default(0),

    /**
     * Set when a human merges two speakers the diarizer split. The losing row is kept
     * rather than deleted so the merge is reversible and so old `speaker_turns` rows still
     * resolve.
     */
    isMergedInto: uuid('is_merged_into'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('speakers_job_key').on(t.jobId, t.key)],
);

/**
 * One diarization attempt. Carries what it cost and how fast it ran, because the estimate
 * shown to a user before they start a run is computed from the measured `realtime_factor`
 * of the last few runs on this instance rather than from a constant — S6's ~0.6× is a
 * 2018 laptop's number and the deployment figure has to come from the deployment.
 */
export const diarizationRuns = pgTable('diarization_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),

  /** `pyannote` | `elevenlabs-scribe`. One source per run: mixing two makes purity meaningless. */
  source: text('source').notNull(),
  model: text('model').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),

  state: text('state', {
    enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
  }).notNull(),
  /** The sidecar's `uuid5(NAMESPACE_URL, run_step_id)`, reconstructible without this row. */
  taskId: text('task_id'),

  speakersFound: smallint('speakers_found'),
  audioDurationMs: integer('audio_duration_ms'),
  computeMs: integer('compute_ms'),
  realtimeFactor: real('realtime_factor'),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
  error: jsonb('error').$type<Record<string, unknown>>(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

/**
 * The turns a diarizer emitted, before reconciliation touched them.
 *
 * **`raw_key` is kept alongside `speaker_id`** so a mis-mapping is diagnosable months
 * later: without it, "the transcript says Daw Khin and she never said that" is
 * uninvestigable, because the evidence has been overwritten by the conclusion.
 *
 * Turns **may overlap**, including two from the same speaker — pyannote 3.1 emits
 * overlapping speech — so there is no exclusion constraint here and nothing downstream may
 * assume disjointness.
 */
export const speakerTurns = pgTable(
  'speaker_turns',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    diarizationRunId: uuid('diarization_run_id')
      .notNull()
      .references(() => diarizationRuns.id, { onDelete: 'cascade' }),
    /** NULL until reconcile maps this raw key onto a durable speaker. */
    speakerId: uuid('speaker_id').references(() => speakers.id, { onDelete: 'set null' }),
    /** `SPEAKER_00` exactly as emitted. */
    rawKey: text('raw_key').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
  },
  (t) => [
    index('speaker_turns_run_start').on(t.diarizationRunId, t.startMs),
    check('speaker_turns_interval', sql`${t.startMs} <= ${t.endMs}`),
  ],
);
