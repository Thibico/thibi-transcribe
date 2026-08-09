import type { Segment, WordTimingQuality } from '@thibi/core';
import { minWordTimingQuality } from '@thibi/core';
import type { ResolvedLanguage } from '@thibi/languages';
import type { EngineContext } from '../context.js';
import { isReplannable, isRetryable } from '../errors.js';
import { RETRY_POLICIES, withRetry } from '../retry.js';
import type { ChunkPlan } from '../audio/plan.js';
import { applySeam, mergeSeam, mergeSeamNoWords } from '../audio/merge/seam.js';
import type { ProviderConfig, TranscribeResult, TranscriptionProvider } from '../providers/types.js';

/**
 * Recognise every chunk, then stitch the results.
 *
 * Replaces the serial chunk loop at `lib/queue.ts:113-136` with a bounded parallel pool.
 * The *reason* for committing per chunk rather than at the end (`:112-113`) is correct and
 * survives: a three-hour transcription that fails on its last chunk must not discard the
 * ninety minutes that succeeded.
 */

export interface ChunkOutcome {
  plan: ChunkPlan;
  result: TranscribeResult | null;
  /** Set when the chunk exhausted its retries. The run becomes `partial`, not `failed`. */
  error: Error | null;
}

export interface SeamRecord {
  afterChunk: number;
  method: 'lcs' | 'hard-cut' | 'no-words' | 'empty';
  score: number;
  droppedWords: number;
  flagged: boolean;
}

export interface AsrInput {
  provider: TranscriptionProvider;
  providerConfig: ProviderConfig;
  language: ResolvedLanguage;
  model: string;
  chunks: Array<{ plan: ChunkPlan; path: string }>;
  /** 0 disables the seam merge entirely, restoring the pre-overlap behaviour exactly. */
  overlapMs: number;
  onChunkDone?: (outcome: ChunkOutcome) => void | Promise<void>;
}

export interface AsrOutput {
  segments: Segment[];
  seams: SeamRecord[];
  wordTimingQuality: WordTimingQuality;
  outcomes: ChunkOutcome[];
  warnings: Array<{ code: string; message: string; chunk?: number }>;
  usage: { audioMs: number; requests: number };
}

/** Recognise one chunk, with retries and one re-plan attempt if it comes back too large. */
async function transcribeChunk(
  ctx: EngineContext,
  input: AsrInput,
  chunk: { plan: ChunkPlan; path: string },
): Promise<ChunkOutcome> {
  const logger = ctx.logger.child({ chunk: chunk.plan.idx });

  try {
    const result = await withRetry(
      () =>
        input.provider.transcribe(input.providerConfig, {
          audio: { path: chunk.path },
          languageCode: input.language.code,
          offsetMs: chunk.plan.offsetMs,
          durationMs: chunk.plan.endMs - chunk.plan.offsetMs,
          model: input.model,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          logger,
        }),
      {
        policy: RETRY_POLICIES['asr.chunk'],
        clock: ctx.clock,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onRetry: ({ attempt, delayMs, error }) =>
          logger.warn({ attempt, delayMs, err: error }, 'asr: retrying chunk'),
      },
    );
    return { plan: chunk.plan, result, error: null };
  } catch (err) {
    if (isReplannable(err)) {
      // The provider says this one chunk is too big. Re-cutting it is the planner's job;
      // Phase 9 owns that path. Here it fails the chunk without failing the run.
      logger.warn({ err }, 'asr: chunk rejected as too large');
    }
    logger.error({ err }, 'asr: chunk failed');
    return { plan: chunk.plan, result: null, error: err as Error };
  }
}

/**
 * Stitch consecutive chunk results, de-duplicating each seam.
 *
 * Runs after all chunks complete because a seam needs both sides. Chunks that failed leave
 * a hole: the seam either side of them is skipped rather than merged against nothing.
 */
export function stitch(
  outcomes: readonly ChunkOutcome[],
  language: ResolvedLanguage,
  overlapMs: number,
): { segments: Segment[]; seams: SeamRecord[] } {
  const seams: SeamRecord[] = [];
  let accumulated: Segment[] = [];
  let previousPlan: ChunkPlan | null = null;

  for (const outcome of outcomes) {
    if (!outcome.result) {
      // A failed chunk breaks the chain: the next chunk has nothing to align against.
      previousPlan = null;
      continue;
    }

    let incoming: Segment[] = outcome.result.segments.map((s, idx) => ({
      idx,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      textRaw: s.text,
      confidence: s.confidence,
      hasWords: s.words.length > 0,
      chunkIdx: outcome.plan.idx,
      words: s.words.map((w, i) => ({
        idx: i,
        startMs: w.startMs,
        endMs: w.endMs,
        text: w.text,
        confidence: w.confidence,
      })),
    }));

    const canMerge =
      overlapMs > 0 && previousPlan !== null && outcome.plan.overlapLeadMs > 0 && accumulated.length > 0;

    if (canMerge) {
      const seamMs = outcome.plan.contentStartMs;
      const leadMs = outcome.plan.overlapLeadMs;
      const prevHasWords = accumulated.some((s) => s.hasWords);
      const nextHasWords = incoming.some((s) => s.hasWords);

      if (prevHasWords && nextHasWords) {
        const prevWords = accumulated.flatMap((s) => s.words);
        const nextWords = incoming.flatMap((s) => s.words);
        const seam = mergeSeam({
          prevWords,
          nextWords,
          seamMs,
          leadMs,
          lang: { code: language.code, wordSegmentation: language.text.wordSegmentation },
        });
        const applied = applySeam(
          { segments: incoming },
          seam,
          { wordJoin: language.text.wordJoin },
        );
        incoming = applied.segments;
        seams.push({
          afterChunk: previousPlan!.idx,
          method: seam.method,
          score: Number(seam.score.toFixed(3)),
          droppedWords: applied.droppedWords,
          flagged: seam.flagged,
        });
      } else {
        // Word alignment is impossible; fall back to segment granularity and always flag.
        const seam = mergeSeamNoWords({
          prevSegments: accumulated,
          nextSegments: incoming,
          seamMs,
          leadMs,
          lang: { code: language.code, wordSegmentation: language.text.wordSegmentation },
        });
        const dropped = seam.dropNextThrough + 1;
        incoming = incoming.slice(dropped).map((s, idx) => ({ ...s, idx }));
        seams.push({
          afterChunk: previousPlan!.idx,
          method: seam.method,
          score: Number(seam.score.toFixed(3)),
          droppedWords: 0,
          flagged: seam.flagged,
        });
      }
    }

    accumulated = [...accumulated, ...incoming];
    previousPlan = outcome.plan;
  }

  return {
    segments: accumulated.map((s, idx) => ({
      ...s,
      idx,
      words: s.words.map((w, i) => ({ ...w, idx: i })),
    })),
    seams,
  };
}

export async function runAsr(ctx: EngineContext, input: AsrInput): Promise<AsrOutput> {
  const limit = Math.max(
    1,
    Math.min(ctx.concurrency.asrChunks, input.provider.capabilities().limits.maxConcurrentRequests),
  );

  const outcomes: ChunkOutcome[] = new Array(input.chunks.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, input.chunks.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= input.chunks.length) return;
        const outcome = await transcribeChunk(ctx, input, input.chunks[index]!);
        outcomes[index] = outcome;
        await input.onChunkDone?.(outcome);
      }
    }),
  );

  const { segments, seams } = stitch(outcomes, input.language, input.overlapMs);

  const warnings: AsrOutput['warnings'] = [];
  let quality: WordTimingQuality | null = null;
  let audioMs = 0;
  let requests = 0;

  for (const outcome of outcomes) {
    if (outcome.error) {
      warnings.push({
        code: 'chunk_failed',
        chunk: outcome.plan.idx,
        message: `Chunk ${outcome.plan.idx} failed after retries: ${outcome.error.message}`,
      });
      continue;
    }
    if (!outcome.result) continue;
    // The run's quality is the minimum across chunks: one wordless chunk means callers
    // cannot assume word timings anywhere without checking per segment.
    quality = quality === null ? outcome.result.wordTimingQuality : minWordTimingQuality(quality, outcome.result.wordTimingQuality);
    audioMs += outcome.result.usage.audioMs;
    requests += outcome.result.usage.requests;
    for (const w of outcome.result.warnings) warnings.push({ ...w, chunk: outcome.plan.idx });
  }

  for (const seam of seams) {
    if (seam.method === 'hard-cut') {
      warnings.push({
        code: 'seam_hard_cut',
        chunk: seam.afterChunk,
        message: `Chunks ${seam.afterChunk} and ${seam.afterChunk + 1} disagreed about their overlap (score ${seam.score}); cut at the midpoint.`,
      });
    } else if (seam.flagged) {
      warnings.push({
        code: 'seam_low_confidence',
        chunk: seam.afterChunk,
        message: `Seam after chunk ${seam.afterChunk} merged with low confidence (score ${seam.score}).`,
      });
    }
  }

  return {
    segments,
    seams,
    wordTimingQuality: quality ?? 'none',
    outcomes,
    warnings,
    usage: { audioMs, requests },
  };
}

export { isRetryable };
