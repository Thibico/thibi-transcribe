import { ensureNormalized, type StepHandler } from '@thibi/engine';
import { fetchAsset, openStep } from './shared.js';

/**
 * `media.normalize` — one 16 kHz mono FLAC that every later step shares.
 *
 * The heaviest step before ASR (weight 8) and the one whose output makes the rest of the
 * pipeline coherent: ASR and diarization consume the *same bytes on the same timeline*, which
 * is the precondition for reconciling words against speaker turns at all. The old app
 * normalized inside the chunker, so the two could not have agreed even in principle.
 *
 * Almost all of the work is `ensureNormalized`'s, including the part that matters here: the
 * cache is keyed by `(asset, kind, recipe_version)` with `ON CONFLICT DO NOTHING`, so two runs
 * of the same recording normalizing concurrently produce one derivative and the loser deletes
 * its own blob rather than orphaning it. That was written for two CLI processes; it is what
 * makes this safe with two workers, which is a stronger claim than it was asked for.
 */
export const mediaNormalize: StepHandler = async (parent, step, signal) => {
  const { run, ctx } = await openStep(parent, step, signal);

  await using work = await ctx.tmp.dir('thibi-norm-');
  await using source = await fetchAsset(ctx, run);

  const normalized = await ensureNormalized(ctx, {
    assetId: run.asset.id,
    sourcePath: source.path,
    workDir: work.path,
  });

  // A cache hit downloads the derivative to a temp file to hand back a path. Nothing here
  // needs the bytes — the steps that do fetch their own copy — so release it immediately.
  await normalized.dispose?.();

  return {
    state: 'done',
    output: {
      storageKey: normalized.storageKey,
      bytes: normalized.bytes,
      cached: normalized.cached,
    },
  };
};
