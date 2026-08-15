import {
  DEFAULT_OVERLAP_MS,
  NotConfiguredError,
  detectSilences,
  durationBudgetMs,
  insertChunks,
  materialisePlan,
  mergePipeline,
  planChunks,
  planRun,
  probe,
  type ChunkPlan,
  type StepHandler,
} from '@thibi/engine';
import { openStep, fetchNormalized, type HandlerDeps } from './shared.js';

/**
 * `plan.chunks` — decide where the cuts go, and grow the DAG to match.
 *
 * The interesting ordering problem in this phase. The number of `asr.chunk` shards is not known
 * until this step has run, and it cannot be guessed at run creation: duration comes from
 * `media.probe`, and a URL import has no duration at all until its download finishes. So the
 * run is planned twice — once through `plan.chunks` with `chunkCount = 0`, and again here with
 * the real count. `materialisePlan`'s `ON CONFLICT DO NOTHING` insert makes the second call a
 * pure extension of the first rather than a special case.
 *
 * **The chunk rows and the steps that consume them commit together**, in one transaction. Both
 * orderings of two separate commits are reachable, and only one of them is survivable: a worker
 * that saw the `asr.chunk` steps first would find no chunk row to cut and fail a step for a
 * reason that has already stopped being true. A transaction removes the question rather than
 * answering it.
 *
 * **The mode is not re-decided here.** `runs.mode` and `pipeline.asr.mode` were settled at run
 * creation, where a user could still be shown the cost both ways. Re-running `planMode` against
 * the normalized bytes would occasionally disagree with the DAG that has already been planned
 * around it — a `batch` run growing `asr.chunk` shards — so this step honours the decision and
 * only computes the boundaries it implies.
 */
export const createPlanChunks = (deps: HandlerDeps): StepHandler => async (parent, step, signal) => {
  const { run, ctx } = await openStep(parent, step, signal);

  const spec = run.spec;
  if (!spec) {
    throw new NotConfiguredError(
      `Run ${run.runId} has no pipeline spec, so there is nothing to plan.`,
      { hint: 'Runs driven by the queue are created with a spec by `thibi run start`.' },
    );
  }

  await using normalized = await fetchNormalized(ctx, run);
  const probed = await probe(ctx, { path: normalized.path });
  const durationMs = probed.durationMs ?? run.asset.durationMs ?? 0;
  if (durationMs <= 0) {
    throw new NotConfiguredError(
      `Neither ffprobe nor the asset row gives a duration for ${run.asset.filename}, so it ` +
        `cannot be chunked.`,
    );
  }

  const built = await deps.providerFor(ctx, run);
  const capabilities = built.provider.capabilities(run.model);
  const overlapMs = spec.asr.overlapMs ?? DEFAULT_OVERLAP_MS;

  let plans: ChunkPlan[];
  if (spec.asr.mode === 'sync_chunked') {
    const budgetMs = durationBudgetMs(probed.bytes ?? 0, durationMs, {
      maxBytes: capabilities.limits.syncMaxBytes,
      maxMs: capabilities.limits.syncMaxSeconds * 1000,
    });
    const silences = await detectSilences(ctx, { path: normalized.path });
    plans = planChunks(durationMs, silences, {
      maxMs: budgetMs,
      overlapLeadMs: overlapMs,
      minMs: 100,
    });
  } else {
    /**
     * One row for `sync` and for `batch` alike.
     *
     * Not a degenerate case to be special-cased away: it is what lets `segments.chunk_id` be
     * populated on every path rather than nullable on two of them, so "which request produced
     * this segment" has an answer for every segment in the database.
     */
    plans = [{ idx: 0, offsetMs: 0, contentStartMs: 0, endMs: durationMs, overlapLeadMs: 0 }];
  }

  await ctx.db.transaction(async (tx) => {
    await insertChunks(tx, run.runId, plans);
    await materialisePlan(tx, run.runId, planRun(spec, plans.length));
    await mergePipeline(tx, run.runId, {
      chunkCount: plans.length,
      overlapMs,
      normalizedDurationMs: durationMs,
    });
  });

  ctx.logger.info(
    { chunks: plans.length, mode: spec.asr.mode, overlapMs },
    'plan: chunks recorded before any provider request',
  );

  return { state: 'done', output: { chunks: plans.length, mode: spec.asr.mode, durationMs } };
};
