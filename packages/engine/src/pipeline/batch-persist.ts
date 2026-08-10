import { resolveRate, unitForMode } from '@thibi/db';
import type { EngineContext } from '../context.js';
import type { BatchOp, BatchStatus } from '../providers/types.js';

/**
 * The persistence around a batch operation, and the ordering it enforces.
 *
 * **This is the part of Phase 2 that the phase exists to get right.** A lost operation name
 * means a second submission and a second bill for audio Google has already processed and is
 * still holding. Everything else here is bookkeeping; the ordering is the design.
 *
 * The phase plan wrote this against `run_steps` and `run_events`. Neither table exists —
 * Phase 1 deferred the step state machine to Phase 9 — and the invariant does not need
 * them. What must be true is that the operation name becomes durable before anything can
 * poll, and `runs` carries that on its own.
 */

/** What lands in `runs.pipeline.batch`. The whole `BatchOp` plus what the poll learned. */
export interface BatchPipelineRecord extends BatchOp {
  doneAtMs?: number;
  /** `submittedAtMs → doneAtMs`. Recorded on every run from day one; see risk 2. */
  latencyMs?: number;
  totalBilledDuration?: string;
  outputUri?: string;
  polls?: number;
}

/**
 * Step 1 — claim the prefix and declare the mode, **before the upload**.
 *
 * The plan set `mode` alongside the operation name. That is too late, and the difference is
 * recoverability: a run that crashes between the upload and the submit would be
 * indistinguishable from a sync run, so nothing would ever look for its orphaned audio or
 * its orphaned operation. `mode='batch'` written here is what makes
 * `mode='batch' AND operation_name IS NULL` a meaningful query.
 *
 * The prefix is derived from `runId` and therefore identical across restarts, which is the
 * only reason `findOrphanOperation` can match on the input URI at all.
 */
export async function claimStagingPrefix(
  ctx: EngineContext,
  runId: string,
  stagingPrefix: string,
): Promise<void> {
  await ctx.db.$client.query(
    `update runs set staging_prefix = $2, mode = 'batch' where id = $1`,
    [runId, stagingPrefix],
  );
}

/**
 * Step 4 — the operation name, atomically, before any poll.
 *
 * One statement, so there is no window in which the name is half-written. The whole `BatchOp`
 * goes into `runs.pipeline.batch` rather than just the name: `BatchOp` is plain JSON
 * precisely so it can be stored and rehydrated, and storing it whole means `thibi runs
 * resume` reconstructs the poll without re-deriving `region` and `inputUri` from three other
 * columns and hoping they still agree.
 *
 * `jsonb ||` merges rather than replaces, so this cannot clobber `planReason` or anything a
 * later phase adds beside it.
 */
export async function persistOperation(
  ctx: EngineContext,
  runId: string,
  op: BatchOp,
): Promise<void> {
  const record: BatchPipelineRecord = { ...op };
  await ctx.db.$client.query(
    `update runs
        set operation_name = $2,
            pipeline = pipeline || jsonb_build_object('batch', $3::jsonb)
      where id = $1`,
    [runId, op.name, JSON.stringify(record)],
  );
}

/** Merge poll/fetch findings into `runs.pipeline.batch` without a read-modify-write race. */
export async function recordBatchProgress(
  ctx: EngineContext,
  runId: string,
  patch: Partial<BatchPipelineRecord>,
): Promise<void> {
  await ctx.db.$client.query(
    `update runs
        set pipeline = jsonb_set(
              pipeline,
              '{batch}',
              coalesce(pipeline->'batch', '{}'::jsonb) || $2::jsonb,
              true)
      where id = $1`,
    [runId, JSON.stringify(patch)],
  );
}

/** Rehydrate a stored operation. Returns null when the run never got as far as submitting. */
export async function loadOperation(
  ctx: EngineContext,
  runId: string,
): Promise<{
  op: BatchOp | null;
  mode: string;
  state: string;
  stagingPrefix: string | null;
  operationName: string | null;
  jobId: string;
  languageCode: string;
  model: string;
  providerId: string;
} | null> {
  const { rows } = await ctx.db.$client.query<{
    mode: string;
    state: string;
    staging_prefix: string | null;
    operation_name: string | null;
    job_id: string;
    language_code: string;
    model: string;
    provider_id: string;
    batch: BatchPipelineRecord | null;
  }>(
    `select mode, state, staging_prefix, operation_name, job_id, language_code, model,
            provider_id, pipeline->'batch' as batch
       from runs where id = $1`,
    [runId],
  );

  const row = rows[0];
  if (!row) return null;

  // The stored BatchOp is authoritative when present. Falling back to `operation_name`
  // alone would lose `region`, and a poll against the wrong regional host 404s in a way
  // that reads like "the operation is gone" rather than "you asked the wrong server".
  const op: BatchOp | null = row.batch?.name
    ? {
        provider: row.batch.provider,
        region: row.batch.region,
        name: row.batch.name,
        inputUri: row.batch.inputUri,
        outputPrefix: row.batch.outputPrefix,
        submittedAtMs: row.batch.submittedAtMs,
        dynamicBatching: row.batch.dynamicBatching ?? false,
      }
    : null;

  return {
    op,
    mode: row.mode,
    state: row.state,
    stagingPrefix: row.staging_prefix,
    operationName: row.operation_name,
    jobId: row.job_id,
    languageCode: row.language_code,
    model: row.model,
    providerId: row.provider_id,
  };
}

/** Clear the prefix once the sweep has actually happened, so the column never lies. */
export async function clearStagingPrefix(ctx: EngineContext, runId: string): Promise<void> {
  await ctx.db.$client.query(`update runs set staging_prefix = null where id = $1`, [runId]);
}

export async function isCancelRequested(ctx: EngineContext, runId: string): Promise<boolean> {
  const { rows } = await ctx.db.$client.query<{ requested: boolean }>(
    `select cancel_requested_at is not null as requested from runs where id = $1`,
    [runId],
  );
  return rows[0]?.requested ?? false;
}

export async function requestCancel(ctx: EngineContext, runId: string): Promise<void> {
  await ctx.db.$client.query(
    `update runs set cancel_requested_at = now() where id = $1 and cancel_requested_at is null`,
    [runId],
  );
}

export interface UsageInput {
  runId: string;
  providerId: string;
  model: string;
  mode: 'sync' | 'sync_chunked' | 'batch';
  /** Preferred over our own duration: it is what the provider says it billed. */
  status?: Pick<BatchStatus, 'totalBilledDuration'>;
  /** Fallback when the provider reported nothing. */
  audioMs: number;
}

export interface UsageWritten {
  minutes: number;
  usd: number;
  usdPerUnit: number;
  /** True when the quantity came from the provider rather than from our own probe. */
  reportedByProvider: boolean;
}

/**
 * Record what the run actually consumed.
 *
 * Uses Google's `totalBilledDuration` in preference to our measured duration, because the
 * point of the row is to be checkable against a bill rather than to agree with the estimate.
 * When the two disagree, the provider's number is the one that shows up on the invoice.
 *
 * Returns null when no rate is configured. A missing rate reads as "we do not know what this
 * cost" and never as $0.00 — quoting zero for two hours of transcription is worse than
 * admitting ignorance, because somebody will believe it.
 */
export async function recordUsage(
  ctx: EngineContext,
  input: UsageInput,
): Promise<UsageWritten | null> {
  const unit = unitForMode(input.mode);
  const rate = await resolveRate(ctx.db, {
    providerId: input.providerId,
    model: input.model,
    unit,
  });
  if (!rate) return null;

  const billedSeconds = parseBilledSeconds(input.status?.totalBilledDuration);
  const reportedByProvider = billedSeconds !== null;
  const minutes = (billedSeconds !== null ? billedSeconds * 1000 : input.audioMs) / 60_000;
  const usd = minutes * rate.usdPerUnit;

  await ctx.db.$client.query(
    `insert into usage_records
       (run_id, kind, quantity, usd_per_unit, usd, provider_id, model, unit, reported)
     values ($1,'asr_minutes',$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.runId,
      Number(minutes.toFixed(4)),
      rate.usdPerUnit,
      Number(usd.toFixed(6)),
      input.providerId,
      input.model,
      unit,
      JSON.stringify(
        input.status?.totalBilledDuration !== undefined
          ? { totalBilledDuration: input.status.totalBilledDuration }
          : { source: 'probe', audioMs: input.audioMs },
      ),
    ],
  );

  return {
    minutes: Number(minutes.toFixed(4)),
    usd: Number(usd.toFixed(6)),
    usdPerUnit: rate.usdPerUnit,
    reportedByProvider,
  };
}

/**
 * `"7203s"` → 7203.
 *
 * Protobuf duration-as-string, the same trap `parseOffsetMs` handles for word offsets:
 * Google sends durations as strings with a trailing `s` and they are not always integers.
 */
export function parseBilledSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number.parseFloat(value.endsWith('s') ? value.slice(0, -1) : value);
  return Number.isFinite(seconds) ? seconds : null;
}
