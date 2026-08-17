import { sql } from 'drizzle-orm';
import { rawResponseKey } from '@thibi/storage';
import {
  AbortedError,
  SidecarBusyError,
  cutChunk,
  loadRunChunks,
  readChunkResult,
  toChunkResult,
  writeChunkResult,
  type StepHandler,
} from '@thibi/engine';
import { openStep, fetchNormalized, type HandlerDeps } from './shared.js';

/**
 * `asr.chunk` — recognise one chunk. The bulk of a chunked run, one shard at a time.
 *
 * Weight 10 each, five attempts, and the only kind whose death the run survives: a
 * three-hour transcript with one bad 55-second chunk is still worth having, and losing it
 * because chunk 94 of 180 hit five consecutive 500s is the behaviour that makes people stop
 * trusting the tool.
 *
 * **No retry loop here.** The old `runAsr` wrapped each chunk in `withRetry`, which is right
 * for a single process and wrong for this one: the step *is* the retry, with its backoff in
 * `poll_after` where an admin can see it, and a second mechanism inside the first is how a
 * chunk runs six times while the UI says three.
 *
 * **Committed per chunk rather than at the end.** `lib/queue.ts:112-113` in the old app:
 * *"Insert per chunk rather than at the end, so a long file shows partial results as it goes
 * and a late failure doesn't discard earlier work."* The second half survives exactly — a
 * chunk's result is durable the moment it lands, so a failure at chunk 179 discards nothing
 * and a retry re-bills only its own chunk. The first half could not survive the seam merge
 * that the old app did not have: chunks overlap by 1200 ms, so a chunk's leading words are
 * not final until its predecessor's are known, and rows written early would have to be
 * rewritten and renumbered later. The result goes to object storage instead, and
 * `normalize.text` writes the segments once, in order.
 */
export const createAsrChunk = (deps: HandlerDeps): StepHandler => async (parent, step, signal) => {
  const { run, ctx } = await openStep(parent, step, signal);

  const idx = typeof step.input['chunkIdx'] === 'number' ? step.input['chunkIdx'] : step.shard;
  const chunk = (await loadRunChunks(ctx, run.runId)).find((c) => c.idx === idx);
  if (!chunk) {
    throw new Error(
      `Chunk ${idx} of run ${run.runId} has no run_chunks row. plan.chunks and the DAG ` +
        `disagree about how many chunks this run has.`,
    );
  }

  /**
   * The re-billing guard, and the reason it is a storage `head` rather than a state check.
   *
   * A worker can die between "the provider answered" and "the step was marked done" — that is
   * the window the whole recovery sweep exists for — and the reclaimed step would otherwise
   * send the same 55 seconds of audio to the same provider a second time. The artifact's
   * existence is the evidence that the money was already spent, and it is committed before the
   * step row is.
   */
  const existing = await readChunkResult(ctx, run.runId, idx);
  if (existing) {
    ctx.logger.info({ chunk: idx }, 'asr: chunk already transcribed; not re-sending');
    return { state: 'done', costUsd: existing.costUsd, output: { idx, reused: true } };
  }

  const built = await deps.providerFor(ctx, run);
  const language = ctx.languages.get(run.languageCode);
  if (!language) {
    throw new Error(`Run ${run.runId} names language ${run.languageCode}, which is not in the registry.`);
  }

  await using work = await ctx.tmp.dir('thibi-chunk-');
  await using normalized = await fetchNormalized(ctx, run);

  const plan = {
    idx: chunk.idx,
    offsetMs: chunk.offsetMs,
    contentStartMs: chunk.contentStartMs,
    endMs: chunk.endMs,
    overlapLeadMs: chunk.overlapLeadMs,
  };
  const cut = await cutChunk(ctx, { path: normalized.path, outDir: work.path, plan });

  // Checked between the cut and the request rather than only inside `fetch`: a provider call
  // that has not been made yet is the cheapest thing in the pipeline to abandon.
  if (signal.aborted) throw new AbortedError('cancelled before the provider request');

  await ctx.db.execute(sql`
    update run_chunks set status = 'running', attempts = attempts + 1
    where run_id = ${run.runId}::uuid and idx = ${idx}
  `);

  /**
   * A busy local sidecar is scheduling, not failure — and until now it was spending a retry.
   *
   * `SidecarBusyError` is a `RateLimitedError`, so `isRetryable` said yes and `onStepError`
   * burned one of this step's five attempts on every 429. The sidecar holds **one** slot for
   * both faster-whisper and pyannote, and its own comment says the likely holder is "a
   * diarization of this same file" — so a `--provider faster-whisper --diarize` run contends
   * with itself, twenty chunks at a time, and after five refusals apiece the shards start
   * landing `dead`. That is exactly the "a busy hour marks half the steps dead" failure the
   * `no_slot` result exists to prevent, arrived at from the other direction.
   *
   * Same treatment `diarize` gives `DiarizerBusyError`: back to `pending` with the provider's
   * own `Retry-After`, and **`attempt` untouched**. The one authority on the sidecar's capacity
   * is the sidecar.
   */
  let result;
  try {
    result = await built.provider.transcribe(built.config, {
      audio: { path: cut.path },
      languageCode: language.code,
      offsetMs: plan.offsetMs,
      durationMs: plan.endMs - plan.offsetMs,
      model: run.model,
      signal,
      logger: ctx.logger.child({ chunk: idx }),
    });
  } catch (err) {
    if (err instanceof SidecarBusyError) {
      const waitMs = err.retryAfterMs ?? 60_000;
      ctx.logger.info(
        { chunk: idx, waitMs },
        'asr: the local sidecar is busy; requeueing without an attempt',
      );
      await ctx.db.execute(sql`
        update run_chunks set status = 'pending', attempts = greatest(attempts - 1, 0)
        where run_id = ${run.runId}::uuid and idx = ${idx}
      `);
      return { state: 'no_slot', retryAfter: new Date(ctx.clock.now().getTime() + waitMs) };
    }
    throw err;
  }

  const costUsd =
    (result.usage.audioMs / 60_000) * built.provider.costModel(run.mode).usdPerMinute;

  /**
   * Archive the untouched provider response before anything derived from it.
   *
   * A disputed transcript is checked against what the provider actually said, not against what
   * we concluded — so the raw bytes are written even when parsing them went on to succeed, and
   * they are written first so a crash cannot leave a parsed result with no original.
   */
  const rawKey = rawResponseKey(run.runId, idx);
  await ctx.store.put(rawKey, Buffer.from(JSON.stringify(result.raw ?? null)), {
    contentType: 'application/json',
  });

  await writeChunkResult(
    ctx,
    run.runId,
    toChunkResult(idx, result, {
      providerId: run.providerId,
      model: run.model,
      costUsd: Number(costUsd.toFixed(6)),
    }),
  );

  await ctx.db.execute(sql`
    update run_chunks set status = 'done', raw_key = ${rawKey}
    where run_id = ${run.runId}::uuid and idx = ${idx}
  `);

  await ctx.events.emit({
    runId: run.runId,
    kind: 'chunk.done',
    data: { idx, failed: false },
  });

  ctx.logger.info(
    { chunk: idx, segments: result.segments.length, audioMs: result.usage.audioMs },
    'asr: chunk complete',
  );

  return {
    state: 'done',
    costUsd: Number(costUsd.toFixed(6)),
    output: { idx, segments: result.segments.length, audioMs: result.usage.audioMs },
  };
};
