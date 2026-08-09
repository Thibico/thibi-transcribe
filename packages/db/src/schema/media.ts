import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Uploaded source media, content-addressed.
 *
 * `sha256` is UNIQUE, so re-uploading the same recording costs one row lookup rather than
 * a second copy of a 2 GB file. The hash is computed during the upload stream by
 * `ObjectStore.putStream`, never by reading the object back.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime'),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),

    /** Null is a legitimate answer from ffprobe, not an error — see audio/probe.ts. */
    durationMs: integer('duration_ms'),

    source: text('source', { enum: ['upload', 'url', 'batch', 'api'] })
      .notNull()
      .default('upload'),
    sourceMeta: jsonb('source_meta').$type<Record<string, unknown>>().notNull().default({}),
    /** The whole ffprobe response, kept so a later question needs no re-probe. */
    probeRaw: jsonb('probe_raw').$type<unknown>(),

    /** Phase 15 retention. Deleting audio keeps the row so the UI can say why it is gone. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedReason: text('deleted_reason'),
    legalHold: timestamp('legal_hold', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('media_assets_sha256').on(t.sha256)],
);

/**
 * Cached products of an asset: the normalized FLAC and the waveform peaks.
 *
 * The unique key includes `recipe_version`, which is derived from the ffmpeg arguments
 * themselves. Changing the loudnorm parameters therefore invalidates every cached
 * derivative automatically — nobody has to remember to bump a number.
 */
export const mediaDerivatives = pgTable(
  'media_derivatives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['norm_16k_mono_flac', 'waveform_peaks'] }).notNull(),
    recipeVersion: text('recipe_version').notNull(),
    storageKey: text('storage_key').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    durationMs: integer('duration_ms'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The cache key. `ON CONFLICT DO NOTHING` against this is what makes two runs
    // normalizing the same asset concurrently safe.
    uniqueIndex('media_derivatives_key').on(t.assetId, t.kind, t.recipeVersion),
    index('media_derivatives_asset').on(t.assetId),
  ],
);

export const mediaAccessLog = pgTable(
  'media_access_log',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    action: text('action').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('media_access_log_asset_at').on(t.assetId, sql`${t.at} desc`)],
);
