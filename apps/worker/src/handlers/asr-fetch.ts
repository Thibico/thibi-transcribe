import { sql } from 'drizzle-orm';
import { rawResponseKey } from '@thibi/storage';
import {
  NonRetryableError,
  NotConfiguredError,
  loadOperation,
  loadRunChunks,
  readChunkResult,
  toChunkResult,
  writeChunkResult,
  type BatchPipelineRecord,
  type BatchStatus,
  type StepHandler,
} from '@thibi/engine';
import { openStep, type HandlerDeps } from './shared.js';

/**
 * `asr.fetch` — read the finished operation's output and turn it into the same artifact a
 * chunk leaves behind.
 *
 * **The design decision worth stating is what this step does *not* do: write segments.** It
 * writes `runs/{id}/results/0.json`, exactly as `asr.chunk` writes one per shard, and
 * `normalize.text` assembles it. That keeps one persistence path for both ASR shapes rather
 * than two that must be kept in agreement — the batch path gets the Zawgyi normalization, the
 * `text_raw` audit trail, the placeholder rule and the `usage_records` row for free, because
 * they all live in the step that consumes the artifact. The alternative, which the phase plan
 * implies by giving `asr.fetch` the word "persists", would have been a second copy of
 * `normalize.text` that only batch runs exercise and that nothing would notice going stale.
 *
 * `idx: 0` because `plan.chunks` writes exactly one `run_chunks` row on the batch path. A batch
 * run is one whole-file request, so there are no seams and the stitch is a pass-through.
 */
export const createAsrFetch =
  (deps: HandlerDeps): StepHandler =>
  async (parent, step, signal) => {
    const { run, ctx } = await openStep(parent, step, signal);

    /**
     * The re-billing guard, in the shape `asr.chunk` established.
     *
     * A fetch is a bucket read rather than a paid request, so the money argument is weaker
     * here — but the *ordering* argument is not: this step archives the raw response before
     * writing the parsed one, and a reclaimed step that redid both would overwrite an archive
     * a human may already have been shown. The artifact's existence is the evidence the work
     * happened, checked before anything is done again.
     */
    const existing = await readChunkResult(ctx, run.runId, 0);
    if (existing) {
      ctx.logger.info({}, 'asr: batch result already fetched; not re-reading');
      return { state: 'done', costUsd: existing.costUsd, output: { reused: true } };
    }

    const staging = ctx.staging;
    if (!staging) {
      throw new NotConfiguredError(
        `Run ${run.runId} is mode=batch, but this worker has no staging bucket to read the ` +
          `operation's output from.`,
        { hint: 'Set GOOGLE_GCS_STAGING_BUCKET on the worker.' },
      );
    }

    const stored = await loadOperation(ctx, run.runId);
    const op = stored?.op ?? null;
    if (!op) {
      throw new NonRetryableError(
        `Run ${run.runId} has no stored batch operation, so there is no output to fetch.`,
        { code: 'BATCH_OPERATION_MISSING', runId: run.runId },
      );
    }

    /**
     * The status is rebuilt from `runs.pipeline.batch` rather than carried on the step.
     *
     * `asr.poll` wrote `outputUri`, `totalBilledDuration` and `doneAtMs` there when the
     * operation finished, and this step runs in a different process — possibly on a different
     * container. Reading it back from the row is what makes the two steps independent of each
     * other's memory, which is the same property that lets a poll survive a redeploy.
     */
    const record = (run.pipeline as { batch?: BatchPipelineRecord }).batch;
    const status: BatchStatus = {
      state: 'succeeded',
      ...(record?.outputUri !== undefined ? { outputUri: record.outputUri } : {}),
      ...(record?.totalBilledDuration !== undefined
        ? { totalBilledDuration: record.totalBilledDuration }
        : {}),
      ...(record?.doneAtMs !== undefined ? { doneAtMs: record.doneAtMs } : {}),
    };

    const chunk = (await loadRunChunks(ctx, run.runId))[0];
    if (!chunk) {
      throw new Error(
        `Run ${run.runId} has no run_chunks row, so plan.chunks either did not run or did not ` +
          `commit. The DAG and the database disagree.`,
      );
    }
    const durationMs = chunk.endMs - chunk.offsetMs;

    const built = await deps.providerFor(ctx, run);
    if (!built.provider.fetchBatchResult) {
      throw new NotConfiguredError(
        `Provider ${built.provider.id} has no batch surface, but run ${run.runId} has a batch ` +
          `result to fetch.`,
      );
    }

    // `read` and `list` are the staging port's methods handed in rather than imported, which is
    // what stops a provider from ever learning what GCS is.
    const result = await built.provider.fetchBatchResult(built.config, op, {
      status,
      durationMs,
      read: staging.readJson.bind(staging),
      list: staging.list.bind(staging),
    });

    /**
     * An estimate, and on the batch path a knowingly high one.
     *
     * `costModel` takes a `RunMode` and Google's implementation ignores it: every mode gets the
     * sync Recognition list price of $0.016/min, where a Dynamic Batch minute is $0.003. So
     * this number is 5.3× the truth on this path — measured on the first real batch run, where
     * it put $0.2658 beside a ledger row saying $0.0499 for the same audio. It is kept because
     * the step's `cost_usd` is what `/admin/queue` shows per step and a blank there is worse
     * than a labelled estimate, and because the artifact's `costUsd` is what a chunked run
     * stores too. **The run's total does not come from here** — `normalize.text` overwrites
     * `runs.cost_usd` with what `recordUsage` resolved from the `rates` table, which is the
     * number with a SKU and a provenance date attached.
     */
    const costUsd =
      (result.usage.audioMs / 60_000) * built.provider.costModel(run.mode).usdPerMinute;

    /**
     * Archive the untouched provider response before anything derived from it.
     *
     * A disputed transcript is checked against what the provider actually said, and the raw
     * bytes are written first so a crash cannot leave a parsed result with no original.
     */
    const rawKey = rawResponseKey(run.runId, 0);
    await ctx.store.put(rawKey, Buffer.from(JSON.stringify(result.raw ?? null)), {
      contentType: 'application/json',
    });

    await writeChunkResult(
      ctx,
      run.runId,
      toChunkResult(0, result, {
        providerId: run.providerId,
        model: run.model,
        costUsd: Number(costUsd.toFixed(6)),
      }),
    );

    await ctx.db.execute(sql`
      update run_chunks set status = 'done', raw_key = ${rawKey}
      where run_id = ${run.runId}::uuid and idx = 0
    `);

    await ctx.events.emit({
      runId: run.runId,
      kind: 'chunk.done',
      data: { idx: 0, failed: false },
    });

    ctx.logger.info(
      { segments: result.segments.length, audioMs: result.usage.audioMs },
      'asr: batch result fetched',
    );

    return {
      state: 'done',
      costUsd: Number(costUsd.toFixed(6)),
      output: {
        segments: result.segments.length,
        audioMs: result.usage.audioMs,
        wordTimingQuality: result.wordTimingQuality,
      },
    };
  };
