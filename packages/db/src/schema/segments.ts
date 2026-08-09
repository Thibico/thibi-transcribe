import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import { runChunks, runs } from './runs.js';

export const segments = pgTable(
  'segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),

    /** Integer milliseconds everywhere. Float seconds is where frame-off errors live. */
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),

    /** Normalized verbatim ASR output. IMMUTABLE — human edits land in segment_texts. */
    text: text('text').notNull(),
    /**
     * Exactly what the provider returned, pre-normalizer.
     *
     * The audit trail the old app destroyed by normalizing in place at `lib/queue.ts:126`.
     * Never re-derived, not even when the seam merge drops words from `text`: what was said
     * to us and what we concluded are different facts.
     */
    textRaw: text('text_raw').notNull(),

    /** Provider segment confidence. NULL when the provider has none — never 0 as a stand-in. */
    confidence: doublePrecision('confidence'),
    chunkId: uuid('chunk_id').references(() => runChunks.id, { onDelete: 'set null' }),

    /** false ⇒ every consumer must use the interpolation fallback, and say that it did. */
    hasWords: boolean('has_words').notNull().default(false),

    speakerId: uuid('speaker_id'), // FK added in Phase 3
    speakerPurity: doublePrecision('speaker_purity'),
    needsSpeakerReview: boolean('needs_speaker_review').notNull().default(false),

    /**
     * Human-split lineage. A human — never an LLM, never a pipeline stage — may split a
     * segment at an existing word boundary. The invariant is "the machine's output is never
     * overwritten", and lineage preserves that better than a hard no-split rule.
     */
    splitOf: uuid('split_of'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Partial unique: superseded rows are history, so they must not collide with live ones. */
    uniqueIndex('segments_run_idx_live')
      .on(t.runId, t.idx)
      .where(sql`${t.supersededAt} is null`),
    index('segments_run_start').on(t.runId, t.startMs),
    check('segments_interval', sql`${t.startMs} <= ${t.endMs}`),
  ],
);

export const words = pgTable(
  'words',
  {
    /**
     * bigint identity, not uuid. ~10k words per audio-hour means 10M rows at 1,000 hours;
     * a random uuid primary key doubles the index size and destroys the insert locality
     * that makes COPY fast.
     */
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => segments.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),

    /** Position within the segment. */
    idx: integer('idx').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    text: text('text').notNull(),

    /**
     * NULL means "this provider does not measure word confidence".
     *
     * It must never be written as 0, or every word from such a provider sorts as maximally
     * uncertain and the QA query below returns the whole transcript. Measured 2026-08-09
     * (spike S2): Google chirp_2 does populate this, with genuine per-word variance.
     */
    confidence: doublePrecision('confidence'),
    speakerId: uuid('speaker_id'),

    /**
     * True only when a provider gave coarse real timings we refined (Phase 4). Phase 1
     * never persists an estimated word — interpolation happens at read time, so these rows
     * cannot poison the low-confidence query or the Phase 3 reconciler.
     */
    isEstimated: boolean('is_estimated').notNull().default(false),
  },
  (t) => [
    uniqueIndex('words_segment_idx').on(t.segmentId, t.idx),
    index('words_run_start').on(t.runId, t.startMs),
    /** Risk-based QA: "38 uncertain words" must not be a sequential scan of 10M rows. */
    index('words_low_conf')
      .on(t.runId, t.startMs)
      .where(sql`${t.confidence} < 0.5`),
    check('words_interval', sql`${t.startMs} <= ${t.endMs}`),
  ],
);

export const segmentTexts = pgTable(
  'segment_texts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => segments.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),

    layer: text('layer', {
      enum: ['verbatim', 'cleaned', 'translated', 'entity_corrected'],
    }).notNull(),

    /**
     * `''` for everything except translations.
     *
     * NOT NULL with a `''` default is load-bearing: a partial unique index over a NULLable
     * column enforces nothing, because `NULL <> NULL` in Postgres. This would not show up
     * in any test that only ever inserts translations.
     */
    targetLang: text('target_lang').notNull().default(''),

    origin: text('origin', { enum: ['asr', 'llm', 'human', 'rule'] }).notNull(),
    text: text('text').notNull(),

    passId: uuid('pass_id'), // → editorial_passes, Phase 6. Provenance is free.
    authorId: uuid('author_id'), // → users, Phase 10
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by'),
  },
  (t) => [
    uniqueIndex('segment_texts_live')
      .on(t.segmentId, t.layer, t.targetLang)
      .where(sql`${t.supersededAt} is null`),
    index('segment_texts_run_layer')
      .on(t.runId, t.layer, t.targetLang)
      .where(sql`${t.supersededAt} is null`),
    /** A translation must name its target, and nothing else may. */
    check(
      'segment_texts_lang',
      sql`(${t.layer} = 'translated') = (${t.targetLang} <> '')`,
    ),
  ],
);
