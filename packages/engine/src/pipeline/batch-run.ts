import type { RunMode, Segment, Warning, WordTimingQuality } from '@thibi/core';
import type { ResolvedLanguage } from '@thibi/languages';
import { rawResponseKey } from '@thibi/storage';
import type { EngineContext } from '../context.js';
import { AbortedError } from '../errors.js';
import { ensureNormalized, normalizeUncached } from '../audio/derivative.js';
import { probe, type ProbeResult } from '../audio/probe.js';
import { normalizeSegments } from '../text/normalize.js';
import { ensureStageable } from '../staging/validate.js';
import { stagingPrefixFor } from '../staging/types.js';
import type {
  BatchOp,
  BatchRequest,
  BatchStatus,
  ProviderConfig,
  ProviderSegment,
  TranscriptionProvider,
} from '../providers/types.js';
import {
  claimStagingPrefix,
  clearStagingPrefix,
  isCancelRequested,
  persistOperation,
  recordBatchProgress,
} from './batch-persist.js';

/**
 * The batch path, driven in process.
 *
 * `transcribe.ts` is its sync sibling and the two deliberately do not share a body: chunking,
 * seam merging and the parallel pool have no meaning here, and folding batch into that
 * function as a series of `if (mode === 'batch')` branches would make the one file that most
 * needs to be readable the one that is least.
 *
 * ## What Phase 9 changes here: nothing in the provider
 *
 * The loop at the bottom is the only thing Phase 9 deletes. It becomes two `run_steps` — an
 * `asr.batch.submit` that sets `awaiting_external`, and a self-rescheduling `asr.poll` —
 * calling **the same three provider methods with the same `BatchOp`**, rebuilt from the
 * database by `loadOperation`. The single constraint that buys this is that `BatchOp` is
 * plain JSON, which is stated on the type and asserted by a round-trip test.
 */

export const POLL_START_MS = 30_000;
export const POLL_MAX_MS = 300_000;
const POLL_FACTOR = 1.5;

export interface BatchRunInput {
  sourcePath: string;
  filename: string;
  language: ResolvedLanguage;
  provider: TranscriptionProvider;
  providerConfig: ProviderConfig;
  model: string;
  runId: string;
  /** Recognizer region, for the co-location assertion. */
  region: string;
  planReason: string;
  assetId?: string;
  maxDurationMs?: number;
  allowMultiRegion?: boolean;
  /** Called once the operation name is durable. The CLI prints `[persisted]`. */
  onSubmitted?: (op: BatchOp) => void | Promise<void>;
  onPoll?: (status: BatchStatus, elapsedMs: number) => void | Promise<void>;
}

export interface BatchRunOutput {
  probe: ProbeResult;
  mode: RunMode;
  op: BatchOp;
  status: BatchStatus;
  segments: Segment[];
  wordTimingQuality: WordTimingQuality;
  warnings: Warning[];
  usage: { audioMs: number; requests: number };
  /** `submittedAtMs → doneAtMs`. Risk 2 wants this on every run from day one. */
  latencyMs: number;
  totalBilledDuration: string | undefined;
  rawKey: string | null;
  /** How many objects the sweep removed. 0 with a non-null prefix means it did not run. */
  stagingDeleted: number;
}

export class BatchFailedError extends Error {
  readonly retryable: boolean;
  constructor(
    message: string,
    readonly scope: 'operation' | 'file',
    retryable: boolean,
  ) {
    super(message);
    this.name = 'BatchFailedError';
    this.retryable = retryable;
  }
}

/**
 * Each entry point asserts only the methods it actually calls.
 *
 * `pollToCompletion` needs `pollBatch` and nothing else, which matters because Phase 9's
 * poll step calls it in isolation from a worker that has an operation and a config — there
 * is no submit in scope and demanding one would be a false requirement.
 */
function assertCan<K extends 'submitBatch' | 'pollBatch' | 'fetchBatchResult'>(
  provider: TranscriptionProvider,
  methods: readonly K[],
): asserts provider is TranscriptionProvider & Required<Pick<TranscriptionProvider, K>> {
  const missing = methods.filter((m) => !provider[m]);
  if (missing.length > 0) {
    throw new Error(
      `Provider ${provider.id} declares 'batch' in its capabilities but does not implement ` +
        `${missing.join(', ')}.`,
    );
  }
}

export async function runBatch(
  ctx: EngineContext,
  input: BatchRunInput,
): Promise<BatchRunOutput> {
  const { provider, language } = input;
  const staging = ctx.staging;
  if (!staging) {
    throw new Error('runBatch needs ctx.staging. planMode should have refused before here.');
  }
  assertCan(provider, ['submitBatch', 'pollBatch', 'fetchBatchResult']);

  const warnings: Warning[] = [];

  // ---- refuse before doing anything expensive -----------------------------------------
  // Deliberately the first network call of the run. Everything below it — a probe, a
  // normalize, a 60 MB upload — is wasted if the bucket is not fit to stage into, and the
  // lifecycle assertion is precisely the thing we must not discover afterwards.
  await ensureStageable(staging, input.region, {
    ...(input.allowMultiRegion !== undefined ? { allowMultiRegion: input.allowMultiRegion } : {}),
  });

  // ---- probe + normalize ---------------------------------------------------------------
  const probed = await probe(ctx, { path: input.sourcePath });
  if (!probed.hasAudio) throw new Error(`No audio stream in ${input.filename}`);

  await using work = await ctx.tmp.dir('thibi-batch-');
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

  // The *normalized* derivative is staged, never the original upload. A 2 GB MP4 is a slow
  // upload of something Google will re-decode to 16 kHz mono anyway.
  const prefix = stagingPrefixFor(input.runId);
  const audioKey = `${prefix}audio.flac`;
  const outputUri = staging.uri(`${prefix}out`);

  // ---- 1. claim the prefix, before the upload ------------------------------------------
  await claimStagingPrefix(ctx, input.runId, prefix);

  // ---- 2. upload -----------------------------------------------------------------------
  const staged = await staging.put(audioKey, { path: normalized.flacPath }, {
    contentType: 'audio/flac',
  });
  ctx.logger.info({ uri: staged.uri, bytes: staged.bytes }, 'staged');
  await normalized.dispose?.();

  const req: BatchRequest = {
    runId: input.runId,
    audioUri: staged.uri,
    outputUri,
    languageCode: providerCodeFor(provider, language),
    model: input.model,
    durationMs,
  };

  // ---- 3-4. submit, then persist the name before anything can poll ----------------------
  let op: BatchOp;
  try {
    op = await provider.submitBatch(input.providerConfig, req);
  } catch (err) {
    // The submit failed, so no operation exists and the staged audio is orphaned. Sweeping
    // here rather than leaving it to the lifecycle rule is politeness, not correctness.
    await staging.deletePrefix(prefix).catch(() => ({ deleted: 0 }));
    await clearStagingPrefix(ctx, input.runId).catch(() => {});
    throw err;
  }

  await persistOperation(ctx, input.runId, op);
  await ctx.events.emit({
    runId: input.runId,
    kind: 'asr.batch.submitted',
    data: { name: op.name, dynamicBatching: op.dynamicBatching },
  });
  await input.onSubmitted?.(op);

  if (!op.dynamicBatching) {
    // Risk 1. The run still happens; `usage_records` will record what it actually cost, so
    // the truth comes from the ledger rather than from the estimate.
    ctx.logger.warn(
      {},
      'processingStrategy=DYNAMIC_BATCHING was rejected; submitted without it. This run is ' +
        'billed at the Recognition rate, not the Dynamic Batch rate.',
    );
  }

  // ---- 5. poll -------------------------------------------------------------------------
  const status = await pollToCompletion(ctx, input, op);

  if (status.state === 'failed') {
    const detail = status.error?.message ?? 'unknown';
    const scope = status.error?.scope ?? 'operation';
    // Copy out nothing, delete nothing: the lifecycle rule is the backstop and a failed
    // operation may be worth resubmitting against the audio that is already staged.
    throw new BatchFailedError(
      scope === 'file'
        ? `The operation completed but the file failed: ${detail}. ` +
          `(Spike S3 measured this at 1 run in 5, transient and unbilled.)`
        : `The batch operation failed: ${detail}`,
      scope,
      status.retryable ?? false,
    );
  }

  // ---- 6. fetch, archive, parse — in that order ----------------------------------------
  const result = await provider.fetchBatchResult(input.providerConfig, op, {
    status,
    durationMs,
    read: staging.readJson.bind(staging),
    list: staging.list.bind(staging),
  });

  // Archive into OUR object store **before** the sweep. If this throws, step 7 never runs
  // and the lifecycle rule cleans up — copy out, then delete, never the reverse.
  let rawKey: string | null = null;
  if (ctx.db) {
    rawKey = rawResponseKey(input.runId, 0);
    await ctx.store.put(rawKey, Buffer.from(JSON.stringify(result.raw, null, 2)), {
      contentType: 'application/json',
    });
  }

  const { segments, convertedCount } = normalizeSegments(toSegments(result.segments), language);
  if (convertedCount > 0) {
    ctx.logger.info({ segments: convertedCount }, 'normalize-text: converted Zawgyi');
  }
  for (const w of result.warnings) warnings.push(w as Warning);

  const latencyMs = (status.doneAtMs ?? ctx.clock.now().getTime()) - op.submittedAtMs;
  await recordBatchProgress(ctx, input.runId, {
    ...(status.doneAtMs !== undefined ? { doneAtMs: status.doneAtMs } : {}),
    latencyMs,
    ...(status.totalBilledDuration !== undefined
      ? { totalBilledDuration: status.totalBilledDuration }
      : {}),
    ...(status.outputUri !== undefined ? { outputUri: status.outputUri } : {}),
  });

  // ---- 7. sweep ------------------------------------------------------------------------
  const { deleted } = await staging.deletePrefix(prefix);
  await clearStagingPrefix(ctx, input.runId);
  ctx.logger.info({ deleted }, 'staging swept');

  return {
    probe: probed,
    mode: 'batch',
    op,
    status,
    segments: segments.map((s, idx) => ({ ...s, idx })),
    wordTimingQuality: result.wordTimingQuality,
    warnings,
    usage: result.usage,
    latencyMs,
    totalBilledDuration: status.totalBilledDuration,
    rawKey,
    stagingDeleted: deleted,
  };
}

/**
 * Poll until the operation stops running.
 *
 * Capped exponential backoff with full jitter, starting at 30 s: batch is measured at ~5.9x
 * realtime, so a 2-hour file is twenty minutes of waiting and polling it every two seconds
 * would be six hundred pointless requests against a per-project quota that the sync path
 * also needs.
 *
 * Cancellation is checked **before** each poll rather than after, so a cancel that arrives
 * during a five-minute sleep is honoured on waking rather than one poll later.
 */
export async function pollToCompletion(
  ctx: EngineContext,
  input: Pick<BatchRunInput, 'runId' | 'provider' | 'providerConfig' | 'onPoll'>,
  op: BatchOp,
): Promise<BatchStatus> {
  const provider = input.provider;
  assertCan(provider, ['pollBatch']);

  const startedAt = ctx.clock.now().getTime();
  let delayMs = POLL_START_MS;
  let polls = 0;

  for (;;) {
    if (ctx.signal?.aborted) throw new AbortedError();
    if (ctx.db && (await isCancelRequested(ctx, input.runId))) throw new AbortedError();

    const status = await provider.pollBatch(input.providerConfig, op);
    polls++;
    const elapsedMs = ctx.clock.now().getTime() - startedAt;
    await input.onPoll?.(status, elapsedMs);

    if (status.state !== 'running') {
      if (ctx.db) await recordBatchProgress(ctx, input.runId, { polls });
      return status;
    }

    await ctx.clock.sleep(delayMs, ctx.signal);
    // Full jitter on the ceiling, for the same reason `retry.ts` uses it: several runs
    // submitted together must not settle into polling in lockstep.
    delayMs = Math.round(Math.min(POLL_MAX_MS, delayMs * POLL_FACTOR) * (0.5 + Math.random() / 2));
  }
}

/**
 * The provider's own code for this language, from the matrix — never a literal.
 *
 * Exported because `asr.batch.submit` builds the same `BatchRequest` from a worker rather than
 * from this function, and the mapping has to be the *same* mapping. A second copy in the
 * handler would be one more place for `my-MM` to become `my` in one path and not the other —
 * the sync path maps inside the provider, so batch is the only path where the caller does it,
 * and a lone copy is a lone chance to drift.
 */
export function providerCodeFor(
  provider: TranscriptionProvider,
  language: ResolvedLanguage,
): string {
  return provider.supportsLanguage(language.code)?.providerCode ?? language.code;
}

/**
 * `ProviderSegment[]` → `Segment[]`.
 *
 * The sync path does this inside `stitch()`, where it is entangled with seam merging. Batch
 * has no seams — it is one whole-file request — so it needs the plain conversion and nothing
 * else. `chunkIdx: 0` because `run_chunks` gets exactly one row for a batch run, which keeps
 * the segment→chunk join uniform across both paths rather than nullable on one of them.
 */
function toSegments(providerSegments: readonly ProviderSegment[]): Segment[] {
  return providerSegments.map((s, idx) => ({
    idx,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text,
    textRaw: s.text,
    confidence: s.confidence,
    hasWords: s.words.length > 0,
    chunkIdx: 0,
    words: s.words.map((w, i) => ({
      idx: i,
      startMs: w.startMs,
      endMs: w.endMs,
      text: w.text,
      confidence: w.confidence,
    })),
  }));
}
