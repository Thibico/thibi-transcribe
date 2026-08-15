import { minWordTimingQuality, type Segment, type WordTimingQuality } from '@thibi/core';
import {
  loadRunChunks,
  mergePipeline,
  normalizeSegments,
  readChunkResult,
  recordUsage,
  stitch,
  writeTranscript,
  type ChunkOutcome,
  type ChunkResult,
  type StepHandler,
} from '@thibi/engine';
import { openStep } from './shared.js';

/**
 * `normalize.text` — assemble the transcript from the chunks and write it down, once.
 *
 * This step does four things the overview's pipeline diagram lists separately (`ASR →
 * reconcile → normalize-text → persist`), and they are together here because they are one
 * decision each about the *whole* timeline rather than about any one chunk:
 *
 *  1. **Stitch.** Adjacent chunks overlap by 1200 ms so the LCS merge can drop the words said
 *     twice; a seam needs both sides, so it cannot happen in either chunk's own step.
 *  2. **Placeholders.** A chunk that died leaves an empty segment spanning its interval rather
 *     than a hole. Every downstream consumer — subtitle reflow, export, the editor's
 *     virtualiser, speaker reconciliation — iterates segments in order, and a hole would make
 *     each of them grow a special case.
 *  3. **Normalize.** The registry normalizer chain, applied **per word** with the segment text
 *     re-derived, because Zawgyi conversion is not length-preserving and doing it at segment
 *     level desynchronises word alignment. `text_raw` keeps the provider's exact bytes; the
 *     old app normalized in place at `lib/queue.ts:126` and destroyed that audit trail.
 *  4. **Persist.** Segments, words and the verbatim text layer, in one transaction.
 *
 * What it deliberately does **not** do is set `runs.state`. `reconcile` is the only writer of
 * that column, and it has information this step does not: whether an optional `media.peaks` or
 * `reconcile.speakers` step is still running, and whether a dead chunk leaves the run `partial`
 * or `failed`. A handler that declared the run done here would be right most of the time, which
 * is the worst available property for a second writer.
 */
export const normalizeText: StepHandler = async (parent, step, signal) => {
  const { run, ctx } = await openStep(parent, step, signal);

  const language = ctx.languages.get(run.languageCode);
  if (!language) {
    throw new Error(
      `Run ${run.runId} names language ${run.languageCode}, which is not in the registry.`,
    );
  }

  const chunks = await loadRunChunks(ctx, run.runId);
  const results = await Promise.all(
    chunks.map((c) => readChunkResult(ctx, run.runId, c.idx)),
  );

  /**
   * `stitch` speaks `ChunkOutcome`, the shape the single-process path produces. A null result
   * is exactly how it already represents a chunk that failed: it breaks the merge chain, so the
   * next chunk is appended rather than aligned against a neighbour that is not there.
   */
  const outcomes: ChunkOutcome[] = chunks.map((chunk, i) => {
    const result = results[i] ?? null;
    return {
      plan: {
        idx: chunk.idx,
        offsetMs: chunk.offsetMs,
        contentStartMs: chunk.contentStartMs,
        endMs: chunk.endMs,
        overlapLeadMs: chunk.overlapLeadMs,
      },
      result: result
        ? {
            segments: result.segments,
            wordTimingQuality: result.wordTimingQuality,
            usage: result.usage,
            raw: null,
            warnings: result.warnings,
          }
        : null,
      error: result ? null : new Error(`chunk ${chunk.idx} produced no result`),
    };
  });

  /**
   * The overlap that was actually planned, read back from the rows rather than from a constant.
   *
   * `stitch` only uses this as an on/off gate — the per-chunk lead it aligns against comes from
   * each plan — but reading it from the chunks is what keeps a run planned with `--overlap-ms 0`
   * assembling with the merge off, even when this step runs in a process whose default has since
   * changed.
   */
  const overlapMs = chunks.reduce((max, c) => Math.max(max, c.overlapLeadMs), 0);
  const stitched = stitch(outcomes, language, overlapMs);

  const { segments: normalized, convertedCount } = normalizeSegments(
    stitched.segments,
    language,
  );
  if (convertedCount > 0) {
    ctx.logger.info({ segments: convertedCount }, 'normalize-text: converted Zawgyi');
  }

  const casualties = chunks.filter((_, i) => results[i] == null);
  const segments = withPlaceholders(normalized, casualties, run.cancelRequestedAt !== null);

  const present = results.filter((r): r is ChunkResult => r != null);
  const wordTimingQuality: WordTimingQuality = present.length
    ? present
        .map((r) => r.wordTimingQuality)
        .reduce((a, b) => minWordTimingQuality(a, b))
    : 'none';
  const audioMs = present.reduce((n, r) => n + r.usage.audioMs, 0);
  const costUsd = present.reduce((n, r) => n + r.costUsd, 0);

  const client = await ctx.db.$client.connect();
  try {
    await client.query('begin');
    const written = await writeTranscript(client, {
      runId: run.runId,
      segments,
      failedChunks: new Set(casualties.map((c) => c.idx)),
    });
    await client.query(
      `update runs set word_timing_quality = $2, cost_usd = $3 where id = $1`,
      [run.runId, wordTimingQuality, Number(costUsd.toFixed(6))],
    );
    await client.query('commit');
    ctx.logger.info(
      { segments: written.segmentsInserted, words: written.wordsInserted },
      'persist: written',
    );
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await mergePipeline(ctx.db, run.runId, {
    seams: stitched.seams,
    warnings: [
      ...present.flatMap((r) => r.warnings.map((w) => ({ ...w, chunk: r.idx }))),
      ...casualties.map((c) => ({
        code: 'chunk_failed',
        chunk: c.idx,
        message: `Chunk ${c.idx} was not transcribed; its interval is a placeholder segment.`,
      })),
    ],
  });

  /**
   * Usage is recorded here rather than per chunk, on purpose: `usage_records` answers "what did
   * this run cost", and one row per run is what the rates table and the spend report expect. A
   * row per chunk would multiply a 180-chunk run into 180 rows saying the same thing.
   *
   * On a batch run the quantity comes from Google's `totalBilledDuration` instead of our probe,
   * because the point of the row is to be checkable against an invoice rather than to agree
   * with our own estimate — and when the two disagree it is the provider's number that appears
   * on the bill. `asr.poll` put it in `runs.pipeline.batch` when the operation finished; the
   * chunked path has no such number and falls through to `audioMs`, which is why this is a
   * spread rather than a branch.
   */
  const billed = (run.pipeline as { batch?: { totalBilledDuration?: string } }).batch
    ?.totalBilledDuration;
  await recordUsage(ctx, {
    runId: run.runId,
    providerId: run.providerId,
    model: run.model,
    mode: run.mode,
    audioMs,
    ...(billed !== undefined ? { status: { totalBilledDuration: billed } } : {}),
  });

  return {
    state: 'done',
    output: {
      segments: segments.length,
      placeholders: casualties.length,
      wordTimingQuality,
    },
  };
};

/**
 * Splice an empty segment into each gap a dead chunk left, and renumber.
 *
 * `idx` is reassigned across the whole list because `segments.idx` is unique per run and is the
 * order every reader uses. Sorting by `startMs` rather than by chunk index is what makes that
 * order right even when the merge dropped a chunk's leading words: the placeholder lands where
 * the silence is, not where the arithmetic says it should be.
 */
function withPlaceholders(
  segments: readonly Segment[],
  casualties: ReadonlyArray<{ idx: number; contentStartMs: number; endMs: number }>,
  cancelled: boolean,
): Segment[] {
  if (casualties.length === 0) {
    return segments.map((s, idx) => ({ ...s, idx }));
  }

  const placeholders: Segment[] = casualties.map((c) => ({
    idx: 0,
    startMs: c.contentStartMs,
    endMs: c.endMs,
    text: '',
    textRaw: '',
    confidence: null,
    hasWords: false,
    words: [],
    chunkIdx: c.idx,
    placeholderReason: cancelled ? 'chunk_cancelled' : 'chunk_failed',
  }));

  return [...segments, ...placeholders]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((s, idx) => ({ ...s, idx }));
}
