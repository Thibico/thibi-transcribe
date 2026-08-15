import { sql } from 'drizzle-orm';
import {
  NotConfiguredError,
  UnsupportedMediaError,
  probe,
  type StepHandler,
} from '@thibi/engine';
import { fetchAsset, openStep } from './shared.js';

/**
 * `media.probe` — how long is this, and does it have audio at all?
 *
 * Cheap, and usually already done: `thibi ingest` probes what it uploads, so the common case
 * is a lookup that downloads nothing. It stays a step rather than a precondition because the
 * one path where it is *not* already done is the one that matters — a URL import has no
 * duration until the download finishes, which is exactly why the DAG is planned in two stages
 * rather than one.
 *
 * A file with no audio stream fails here, before anything has been normalized, chunked or
 * sent. That is the whole point of putting it first: `UnsupportedMediaError` is not retryable,
 * so the run dies in a second with a sentence naming the file rather than after eight chunks
 * of ffmpeg have failed in eight different ways.
 */
export const mediaProbe: StepHandler = async (parent, step, signal) => {
  const { run, ctx } = await openStep(parent, step, signal);

  if (run.asset.probed) {
    ctx.logger.info({ assetId: run.asset.id }, 'probe: already stored at ingest');
    return {
      state: 'done',
      output: { durationMs: run.asset.durationMs, cached: true },
    };
  }

  await using source = await fetchAsset(ctx, run);
  const probed = await probe(ctx, { path: source.path });

  /**
   * "ffprobe is not installed" and "this file has no audio" both arrive as `hasAudio: false`,
   * and they need opposite responses: one is an operator's problem with this container, the
   * other is a permanent fact about the file. Phase 8 added `failure` precisely so a caller
   * could tell them apart, and a handler that ignored it would report a misconfigured worker
   * as a bad recording — to the person who uploaded the recording.
   */
  if (probed.failure) {
    throw new NotConfiguredError(
      probed.failure.reason === 'ffprobe_missing'
        ? 'ffprobe is not on this worker. Set FFPROBE_PATH, or install ffmpeg in the image.'
        : `ffprobe could not read ${run.asset.filename}: ${probed.failure.detail}`,
    );
  }
  if (!probed.hasAudio) {
    throw new UnsupportedMediaError(`No audio stream in ${run.asset.filename}`);
  }

  /**
   * The whole ffprobe response, kept so a later question needs no re-probe.
   *
   * Written on the asset rather than the step because it is a fact about the *recording*, and
   * a second run of the same file must not pay for it again. `duration_ms` is only written
   * when the probe found one: a null is a legitimate answer and overwriting a stored duration
   * with it would lose information the ingest path had.
   */
  await ctx.db.execute(sql`
    update media_assets
    set    probe_raw = ${JSON.stringify(probed.raw ?? null)}::jsonb,
           duration_ms = coalesce(${probed.durationMs}::int, duration_ms)
    where  id = ${run.asset.id}::uuid
  `);

  ctx.logger.info(
    { durationMs: probed.durationMs, format: probed.formatName },
    'probe: complete',
  );

  return {
    state: 'done',
    output: {
      durationMs: probed.durationMs,
      formatName: probed.formatName,
      cached: false,
    },
  };
};
