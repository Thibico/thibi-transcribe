import { createReadStream } from 'node:fs';
import type { RunMode, Segment, Warning, WordTimingQuality } from '@thibi/core';
import type { ResolvedLanguage } from '@thibi/languages';
import { chunkKey, toTempFile } from '@thibi/storage';
import type { EngineContext } from '../context.js';
import { UnsupportedMediaError } from '../errors.js';
import { cutChunks } from '../audio/cut.js';
import { ensureNormalized, normalizeUncached } from '../audio/derivative.js';
import { durationBudgetMs, planChunks, type ChunkPlan } from '../audio/plan.js';
import { probe, type ProbeResult } from '../audio/probe.js';
import { detectSilences } from '../audio/silences.js';
import { normalizeSegments } from '../text/normalize.js';
import type { ProviderConfig, TranscriptionProvider } from '../providers/types.js';
import { runAsr, type SeamRecord } from './asr.js';
import { planMode } from './plan.js';

/**
 * The whole vertical slice: probe → normalize → plan → chunk → recognise → merge →
 * normalize-text.
 *
 * Persistence is a separate stage on purpose (see `persist.ts`). Keeping it out of here is
 * what makes `--no-db` a real configuration rather than a special case threaded through
 * every step, and it is what Phase 9 replaces with the `run_steps` state machine.
 */

export const DEFAULT_OVERLAP_MS = 1200;

export interface TranscribeInput {
  /** Local path to the source media. */
  sourcePath: string;
  filename: string;
  language: ResolvedLanguage;
  provider: TranscriptionProvider;
  providerConfig: ProviderConfig;
  model: string;
  runId: string;
  mode?: 'auto' | RunMode;
  overlapMs?: number;
  /** The "Try 2 minutes first" affordance Phase 11 calls. */
  maxDurationMs?: number;
  /**
   * When present, the normalized derivative is cached against this asset and reused by
   * every later run. Absent under `--no-db`, where normalization is recomputed each time.
   */
  assetId?: string;
  /** Called with each chunk plan before any network request touches it. */
  onPlan?: (plans: readonly ChunkPlan[]) => void | Promise<void>;
  /** Called with the raw provider response per chunk, for archiving. */
  onRawResponse?: (idx: number, raw: unknown) => void | Promise<void>;
}

export interface TranscribeOutput {
  probe: ProbeResult;
  mode: RunMode;
  /** Stored in `runs.pipeline.planReason` and printed. Never a mystery. */
  planReason: string;
  plans: ChunkPlan[];
  segments: Segment[];
  seams: SeamRecord[];
  wordTimingQuality: WordTimingQuality;
  warnings: Warning[];
  usage: { audioMs: number; requests: number };
  costUsd: number;
  /** True when at least one chunk exhausted its retries: the run is `partial`. */
  partial: boolean;
  normalizedKey: string | null;
}

export async function transcribe(
  ctx: EngineContext,
  input: TranscribeInput,
): Promise<TranscribeOutput> {
  const { provider, language } = input;
  const capabilities = provider.capabilities(input.model);
  const overlapMs = input.overlapMs ?? DEFAULT_OVERLAP_MS;
  const warnings: Warning[] = [];

  // ---- probe -------------------------------------------------------------------------
  const probed = await probe(ctx, { path: input.sourcePath });
  if (!probed.hasAudio) {
    throw new UnsupportedMediaError(`No audio stream in ${input.filename}`);
  }
  ctx.logger.info(
    { durationMs: probed.durationMs, format: probed.formatName },
    'probe: complete',
  );

  // ---- normalize ---------------------------------------------------------------------
  await using work = await ctx.tmp.dir('thibi-norm-');
  const normalized = input.assetId
    ? await ensureNormalized(ctx, {
        assetId: input.assetId,
        sourcePath: input.sourcePath,
        workDir: work.path,
      })
    : await normalizeUncached(ctx, { sourcePath: input.sourcePath, workDir: work.path });
  const normalizedProbe = await probe(ctx, { path: normalized.flacPath });

  let durationMs = normalizedProbe.durationMs ?? probed.durationMs ?? 0;
  if (input.maxDurationMs !== undefined && durationMs > input.maxDurationMs) {
    durationMs = input.maxDurationMs;
  }

  // ---- plan --------------------------------------------------------------------------
  // The decision and its justification both come from `planMode`, so the CLI, the engine
  // and Phase 11's dialog can never disagree about why a mode was chosen. Measured
  // 2026-08-09 (spike S3): chunked parallel sync beats batchRecognize at every duration, so
  // nothing here routes on duration to batch — `runBatch` is a separate entry point reached
  // only by an explicit request.
  const decision = planMode({
    durationMs: probed.durationMs === null ? null : durationMs,
    bytes: normalized.bytes,
    caps: capabilities,
    stagingConfigured: ctx.staging !== undefined,
    ...(input.mode && input.mode !== 'auto' ? { force: input.mode } : {}),
  });
  const mode = decision.mode;
  // `duration_unknown` is raised by the planner rather than here, because it is a statement
  // about the routing decision and belongs beside the decision it explains.
  warnings.push(...(decision.warnings as Warning[]));
  ctx.logger.info({}, `plan: mode=${mode}  reason="${decision.reason}"`);

  let plans: ChunkPlan[];
  if (mode === 'sync') {
    plans = [{ idx: 0, offsetMs: 0, contentStartMs: 0, endMs: durationMs, overlapLeadMs: 0 }];
  } else {
    const budgetMs = durationBudgetMs(normalized.bytes, durationMs, {
      maxBytes: capabilities.limits.syncMaxBytes,
      maxMs: capabilities.limits.syncMaxSeconds * 1000,
    });
    const silences = await detectSilences(ctx, { path: normalized.flacPath });
    plans = planChunks(durationMs, silences, {
      maxMs: budgetMs,
      overlapLeadMs: overlapMs,
      minMs: 100,
    });
  }
  ctx.logger.info({ chunks: plans.length, mode, overlapMs }, 'plan: complete');

  // `run_chunks` rows are written here, before any cutting and before any network call.
  await input.onPlan?.(plans);

  // ---- cut ---------------------------------------------------------------------------
  await using chunkDir = await ctx.tmp.dir('thibi-chunks-');
  const cut = await cutChunks(ctx, {
    path: normalized.flacPath,
    outDir: chunkDir.path,
    plans,
  });

  // ---- recognise + merge -------------------------------------------------------------
  const asr = await runAsr(ctx, {
    provider,
    providerConfig: input.providerConfig,
    language,
    model: input.model,
    chunks: cut,
    overlapMs,
    onChunkDone: async (outcome) => {
      if (outcome.result) await input.onRawResponse?.(outcome.plan.idx, outcome.result.raw);
      await ctx.events.emit({
        runId: input.runId,
        kind: 'chunk.done',
        data: { idx: outcome.plan.idx, failed: Boolean(outcome.error) },
      });
    },
  });

  // ---- normalize-text ----------------------------------------------------------------
  const { segments, convertedCount } = normalizeSegments(asr.segments, language);
  if (convertedCount > 0) {
    ctx.logger.info({ segments: convertedCount }, 'normalize-text: converted Zawgyi');
  }

  // A cache hit downloaded the derivative to a temp file; release it now that chunks are cut.
  await normalized.dispose?.();

  const partial = asr.outcomes.some((o) => o.error);
  const costUsd = (asr.usage.audioMs / 60_000) * provider.costModel(mode).usdPerMinute;

  return {
    probe: probed,
    mode,
    planReason: decision.reason,
    plans,
    segments,
    seams: asr.seams,
    wordTimingQuality: asr.wordTimingQuality,
    warnings: [...warnings, ...(asr.warnings as Warning[])],
    usage: asr.usage,
    costUsd: Number(costUsd.toFixed(4)),
    partial,
    normalizedKey: null,
  };
}

/** Upload the normalized derivative. Separate so `--no-db` can skip it. */
export async function storeNormalized(
  ctx: EngineContext,
  runId: string,
  flacPath: string,
): Promise<string> {
  const key = chunkKey(runId, 0, '.normalized.flac');
  await ctx.store.putStream(key, createReadStream(flacPath), { contentType: 'audio/flac' });
  return key;
}

export { toTempFile };
