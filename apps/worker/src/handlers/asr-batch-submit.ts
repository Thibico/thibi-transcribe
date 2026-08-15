import {
  NotConfiguredError,
  claimStagingPrefix,
  ensureStageable,
  loadOperation,
  loadRunChunks,
  persistOperation,
  providerCodeFor,
  stagingPrefixFor,
  type BatchRequest,
  type StepHandler,
} from '@thibi/engine';
import { openStep, fetchNormalized, regionOf, type HandlerDeps } from './shared.js';

/**
 * `asr.batch.submit` — stage the audio and hand Google the job.
 *
 * The first half of the pair that `runBatch`'s in-process poll loop becomes when it is pulled
 * apart across a queue. Nothing in the provider changes: this calls the same `submitBatch` with
 * the same `BatchRequest`, and `BatchOp` is plain JSON precisely so the *next* step — running
 * in a different process, possibly after a redeploy — can rehydrate it and poll.
 *
 * ## It ends `done`, not `awaiting_external`, and the plan said otherwise
 *
 * §7 of the phase document has this handler return `awaiting_external` with the operation name
 * on `external_ref`. That cannot work beside a separate `asr.poll` step, and the reason is the
 * dependency rule rather than anything about batching: `asr.poll` depends on this step, and only
 * `done` or `skipped` satisfies a dependency. A submit that parked in `awaiting_external` would
 * be re-claimed by its own re-ring, hit its idempotence guard, return `awaiting_external` again,
 * and poll nothing forever while `asr.poll` sat `pending` behind it. The sketch was written
 * before `StepResult` and the reconciler existed and it quietly assumed one step, not three.
 *
 * So the waiting lives on `asr.poll`, which is also where it belongs operationally — that step
 * is routed to the `asr.poll` queue so a sub-second poll can never queue behind a forty-minute
 * diarize, and a submit that held the wait would have done it from `asr.cloud`. Amendment 97.
 *
 * ## The guard is the persisted operation, not the step's state
 *
 * A worker can die between `batchRecognize` returning a name and the step row being marked
 * done, and the reclaimed step would otherwise submit the same two hours of audio a second
 * time. `persistOperation` is committed before the handler returns, so the stored `BatchOp`
 * is the evidence that the money is already committed — the same shape as `asr.chunk`'s
 * artifact check, and for the same reason: *what is durable is what proves the spend*, and the
 * step's own state is not durable at the moment it matters.
 *
 * One window stays open, one statement wide: a crash between `submitBatch` returning and
 * `persistOperation` committing. `resumeBatchRun` closes it by matching the operation at Google
 * on its input URI, and `thibi runs resume` is the way to reach it; it is not wired in here
 * because it needs Google-specific `BatchDeps` that this handler deliberately does not have.
 */
export const createAsrBatchSubmit =
  (deps: HandlerDeps): StepHandler =>
  async (parent, step, signal) => {
    const { run, ctx } = await openStep(parent, step, signal);

    /**
     * Already submitted. Say so, spend nothing, and let `asr.poll` take it from here.
     *
     * The log line is deliberately the same shape as `asr.chunk`'s: it is the sentence an
     * operator greps for after a crash to confirm they were not billed twice.
     */
    const stored = await loadOperation(ctx, run.runId);
    if (stored?.op) {
      ctx.logger.info(
        { operation: stored.op.name },
        'asr: batch already submitted; not re-sending',
      );
      return { state: 'done', output: { operationName: stored.op.name, reused: true } };
    }

    const staging = ctx.staging;
    if (!staging) {
      throw new NotConfiguredError(
        `Run ${run.runId} is mode=batch, but this worker has no staging bucket to put the ` +
          `audio in.`,
        {
          hint:
            'Set GOOGLE_GCS_STAGING_BUCKET (or the google.gcs_staging_bucket setting) on the ' +
            'worker, or re-run the job with --mode sync_chunked.',
        },
      );
    }

    const language = ctx.languages.get(run.languageCode);
    if (!language) {
      throw new Error(
        `Run ${run.runId} names language ${run.languageCode}, which is not in the registry.`,
      );
    }

    const built = await deps.providerFor(ctx, run);
    const { provider, config } = built;
    if (!provider.submitBatch) {
      throw new NotConfiguredError(
        `Provider ${provider.id} has no batch surface, but run ${run.runId} was planned as a ` +
          `batch run.`,
        { hint: 'Re-run the job with --mode sync_chunked, or with -p google.' },
      );
    }

    /**
     * The whole-file span, read from the chunk row rather than re-probed.
     *
     * `plan.chunks` writes exactly one `run_chunks` row on the batch path — not a degenerate
     * case to be special-cased away, but what lets `segments.chunk_id` be populated on every
     * path. Its `endMs` is the duration this run was planned around, including any
     * `--max-duration` truncation, so taking it from anywhere else would mean submitting a
     * different span than the DAG describes.
     */
    const chunk = (await loadRunChunks(ctx, run.runId))[0];
    if (!chunk) {
      throw new Error(
        `Run ${run.runId} has no run_chunks row, so plan.chunks either did not run or did not ` +
          `commit. The DAG and the database disagree.`,
      );
    }

    /**
     * Refuse before doing anything expensive — the same ordering `runBatch` uses.
     *
     * Deliberately the first network call: everything below it is a download, a 60 MB upload
     * and an operation we do not want to submit twice, and the lifecycle assertion is precisely
     * the thing we must not discover afterwards.
     */
    await ensureStageable(staging, regionOf(provider.id, config));

    const prefix = stagingPrefixFor(run.runId);
    const audioKey = `${prefix}audio.flac`;

    // Claimed before the upload, not after the submit. `mode='batch' AND operation_name IS
    // NULL` is only a meaningful query — the one `thibi runs resume` searches on — if a run
    // that died between the upload and the submit still carries its prefix.
    await claimStagingPrefix(ctx, run.runId, prefix);

    await using normalized = await fetchNormalized(ctx, run);
    const staged = await staging.put(audioKey, { path: normalized.path }, {
      contentType: 'audio/flac',
    });
    ctx.logger.info({ uri: staged.uri, bytes: staged.bytes }, 'asr: staged');

    const request: BatchRequest = {
      runId: run.runId,
      audioUri: staged.uri,
      outputUri: staging.uri(`${prefix}out`),
      languageCode: providerCodeFor(provider, language),
      model: run.model,
      durationMs: chunk.endMs - chunk.offsetMs,
    };

    const op = await provider.submitBatch(config, request);

    /**
     * Durable before anything can poll, and before this step is marked done.
     *
     * The whole `BatchOp` rather than just the name: `region` and `inputUri` travel with it
     * because a poll URL cannot be rebuilt without the region, and polling the wrong regional
     * host 404s in a way that reads like "the operation is gone".
     */
    await persistOperation(ctx, run.runId, op);
    await ctx.events.emit({
      runId: run.runId,
      kind: 'asr.batch.submitted',
      data: { name: op.name, dynamicBatching: op.dynamicBatching },
    });

    if (!op.dynamicBatching) {
      // Risk 1. The run still happens; `usage_records` records what it actually cost, so the
      // truth comes from the ledger rather than from the estimate.
      ctx.logger.warn(
        {},
        'processingStrategy=DYNAMIC_BATCHING was rejected; submitted without it. This run is ' +
          'billed at the Recognition rate, not the Dynamic Batch rate.',
      );
    }

    ctx.logger.info({ operation: op.name }, 'asr: batch submitted [persisted]');

    return {
      state: 'done',
      output: {
        operationName: op.name,
        submittedAtMs: op.submittedAtMs,
        dynamicBatching: op.dynamicBatching,
        inputUri: op.inputUri,
      },
    };
  };
