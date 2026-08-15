import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { derivativeKey, toTempFile } from '@thibi/storage';
import type { EngineContext } from '../context.js';
import { NORMALIZE, RECIPE_VERSION, runNormalize } from './normalize.js';

/**
 * The normalize cache.
 *
 * Decoupling normalization from chunking is what lets Phase 3's diarization and Phase 4's
 * local ASR consume the *same bytes* on the *same timeline* — the precondition for
 * reconciliation working at all. Caching it means a re-transcription, a re-run with a
 * different provider, or a diarization pass added later all skip the expensive decode.
 *
 * The cache key includes `recipe_version`, which is derived from the ffmpeg arguments
 * themselves, so changing the loudnorm parameters invalidates every cached derivative
 * automatically. Nobody has to remember to bump a number, and nobody can forget.
 */

export interface EnsureNormalizedInput {
  assetId: string;
  /** Local path to the source media. */
  sourcePath: string;
  /** Where to put the normalized file if it has to be produced. */
  workDir: string;
}

export interface NormalizedDerivative {
  /** A local path to the normalized FLAC, ready for ffmpeg. */
  flacPath: string;
  storageKey: string;
  bytes: number;
  cached: boolean;
  /** Present only when this call produced it; a cache hit does not re-derive peaks. */
  peaks: Int8Array | null;
  /** Set on a cache hit so the caller disposes the downloaded copy. */
  dispose?: () => Promise<void>;
}

interface DerivativeRow {
  id: string;
  storage_key: string;
  bytes: string | number;
}

async function selectDerivative(
  ctx: EngineContext,
  assetId: string,
): Promise<DerivativeRow | null> {
  const client = await ctx.db.$client.connect();
  try {
    const { rows } = await client.query<DerivativeRow>(
      `select id, storage_key, bytes from media_derivatives
        where asset_id = $1 and kind = $2 and recipe_version = $3`,
      [assetId, NORMALIZE.kind, RECIPE_VERSION],
    );
    return rows[0] ?? null;
  } finally {
    client.release();
  }
}

/**
 * Where this asset's normalized FLAC lives, or null if it has not been produced.
 *
 * The read half of the cache, exposed because Phase 9 split producing the derivative
 * (`media.normalize`) from consuming it (`plan.chunks`, `asr.chunk`, `diarize`) into separate
 * steps in separate processes. The consumers must not re-derive on a miss: that would turn a
 * violated dependency into eight concurrent ffmpeg runs of the same hour of audio, which looks
 * like slowness rather than like the DAG error it is.
 */
export async function normalizedKeyFor(
  ctx: EngineContext,
  assetId: string,
): Promise<string | null> {
  const hit = await selectDerivative(ctx, assetId);
  return hit?.storage_key ?? null;
}

export async function ensureNormalized(
  ctx: EngineContext,
  input: EnsureNormalizedInput,
): Promise<NormalizedDerivative> {
  const hit = await selectDerivative(ctx, input.assetId);
  if (hit) {
    ctx.logger.info({ recipe: RECIPE_VERSION }, 'normalize: cached');
    const local = await toTempFile(ctx.store, ctx.tmp, hit.storage_key, '.flac');
    return {
      flacPath: local.path,
      storageKey: hit.storage_key,
      bytes: Number(hit.bytes),
      cached: true,
      peaks: null,
      dispose: async () => {
        await local[Symbol.asyncDispose]();
      },
    };
  }

  const produced = await runNormalize(ctx, input.sourcePath, input.workDir);
  const bytes = (await stat(produced.flacPath)).size;
  const key = derivativeKey(input.assetId, NORMALIZE.kind, RECIPE_VERSION, '.flac');
  await ctx.store.putStream(key, createReadStream(produced.flacPath), {
    contentType: 'audio/flac',
  });

  const client = await ctx.db.$client.connect();
  try {
    const inserted = await client.query<{ id: string }>(
      `insert into media_derivatives (asset_id, kind, recipe_version, storage_key, bytes)
       values ($1,$2,$3,$4,$5)
       on conflict (asset_id, kind, recipe_version) do nothing
       returning id`,
      [input.assetId, NORMALIZE.kind, RECIPE_VERSION, key, bytes],
    );

    if (inserted.rowCount === 0) {
      // Another run normalized the same asset concurrently and won the unique index. Use
      // its object and delete ours — otherwise the loser's blob is orphaned forever, and
      // nothing else will ever reference it to clean it up.
      const winner = (await selectDerivative(ctx, input.assetId))!;
      if (winner.storage_key !== key) await ctx.store.delete(key);
      ctx.logger.info({ recipe: RECIPE_VERSION }, 'normalize: lost a concurrent race, using theirs');
      const local = await toTempFile(ctx.store, ctx.tmp, winner.storage_key, '.flac');
      return {
        flacPath: local.path,
        storageKey: winner.storage_key,
        bytes: Number(winner.bytes),
        cached: true,
        peaks: null,
        dispose: async () => {
        await local[Symbol.asyncDispose]();
      },
      };
    }
  } finally {
    client.release();
  }

  ctx.logger.info(
    { recipe: RECIPE_VERSION, bytes, kind: NORMALIZE.kind },
    'normalize: computed',
  );
  return {
    flacPath: produced.flacPath,
    storageKey: key,
    bytes,
    cached: false,
    peaks: produced.peaks,
  };
}

/** The `--no-db` path: normalize into the work directory and cache nothing. */
export async function normalizeUncached(
  ctx: EngineContext,
  input: { sourcePath: string; workDir: string },
): Promise<NormalizedDerivative> {
  const produced = await runNormalize(ctx, input.sourcePath, input.workDir);
  const bytes = (await stat(produced.flacPath)).size;
  ctx.logger.info({ recipe: RECIPE_VERSION, bytes, kind: NORMALIZE.kind }, 'normalize: computed');
  return {
    flacPath: produced.flacPath,
    storageKey: join(input.workDir, 'normalized.flac'),
    bytes,
    cached: false,
    peaks: produced.peaks,
  };
}
