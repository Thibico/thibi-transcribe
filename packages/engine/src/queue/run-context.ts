import { sql } from 'drizzle-orm';
import type { RunPipeline } from '@thibi/db';
import type { EngineContext } from '../context.js';
import { USER_FACING } from '../errors.js';
import type { PipelineSpec } from './plan.js';

/**
 * Everything a handler needs to know about the run it was handed, in one query.
 *
 * A handler receives a `run_steps` row and nothing else. Every one of them then needs the same
 * five facts — which recording, which language, which provider, which model, what the pipeline
 * was supposed to be — and the alternative to loading them here is five handlers each writing
 * their own three-table join, differing in whichever one was fixed.
 *
 * It is a read, so it lives in the engine rather than in the worker: no environment, no
 * provider construction, nothing an app has to supply. Turning `providerId` and `model` into
 * something callable *is* an app's job, and stays in `@thibi/runtime`.
 */

export interface RunAsset {
  id: string;
  storageKey: string;
  filename: string;
  bytes: number;
  /** Null is a legitimate answer from ffprobe, not an error — see `audio/probe.ts`. */
  durationMs: number | null;
  mime: string | null;
  /**
   * Whether `probe_raw` was already stored, usually at ingest.
   *
   * Not the same question as `durationMs !== null`: a null duration is a legitimate probe
   * result, so treating "no duration" as "not probed" would re-download and re-probe a 2 GB
   * file on every run of a recording ffprobe genuinely cannot measure.
   */
  probed: boolean;
}

export interface RunContext {
  runId: string;
  jobId: string;
  languageCode: string;
  providerId: string;
  model: string;
  mode: 'sync' | 'sync_chunked' | 'batch';
  /** The whole column: the spec the planner wrote *and* the runtime state stages appended. */
  pipeline: RunPipeline;
  /** The spec half, when the run was created by something that plans a DAG. */
  spec: PipelineSpec | null;
  asset: RunAsset;
  cancelRequestedAt: Date | null;
}

/**
 * A step whose run cannot be loaded is not a retryable failure.
 *
 * It means the run, its job or its asset is gone — a cascade delete beat the doorbell — and
 * five more attempts will find the same absence. Distinguishing it from a transient database
 * error is what stops a deleted run from occupying a queue for the length of its backoff.
 */
export class RunNotLoadableError extends Error {
  readonly retryable = false;
  readonly [USER_FACING] = true as const;
  constructor(runId: string) {
    super(
      `Run ${runId} has no job or no asset. It was probably deleted while a step for it was ` +
        `still queued; nothing further will happen to it.`,
    );
    this.name = 'RunNotLoadableError';
  }
}

/**
 * A `type` and not an `interface`, deliberately: `db.execute<T>` constrains `T` to
 * `Record<string, unknown>`, and an interface has no implicit index signature to satisfy it.
 */
type RunContextRow = {
  job_id: string;
  language_code: string;
  provider_id: string;
  model: string;
  mode: string;
  pipeline: RunPipeline;
  cancel_requested_at: Date | null;
  asset_id: string;
  storage_key: string;
  filename: string;
  bytes: string | number;
  duration_ms: number | null;
  mime: string | null;
  probed: boolean;
};

export async function loadRunContext(ctx: EngineContext, runId: string): Promise<RunContext> {
  const { rows } = await ctx.db.execute<RunContextRow>(sql`
    select r.job_id, r.language_code, r.provider_id, r.model, r.mode, r.pipeline,
           r.cancel_requested_at,
           a.id as asset_id, a.storage_key, a.filename, a.bytes, a.duration_ms, a.mime,
           -- Not null AND not the jsonb document null, which are different things: a column
           -- holding the four characters null is not a SQL NULL. createRun used to write that
           -- document for every unprobed asset, so the simpler predicate answered "probed" for
           -- assets nothing had ever probed. See the note beside the fix in persist.ts.
           (a.probe_raw is not null and a.probe_raw <> 'null'::jsonb) as probed
    from   runs r
    join   jobs j on j.id = r.job_id
    join   media_assets a on a.id = j.asset_id
    where  r.id = ${runId}::uuid
  `);

  const row = rows[0];
  if (!row) throw new RunNotLoadableError(runId);

  return {
    runId,
    jobId: row.job_id,
    languageCode: row.language_code,
    providerId: row.provider_id,
    model: row.model,
    mode: row.mode as RunContext['mode'],
    pipeline: row.pipeline ?? {},
    spec: readPipelineSpec(row.pipeline ?? {}),
    asset: {
      id: row.asset_id,
      storageKey: row.storage_key,
      filename: row.filename,
      // `bigint` comes back as a string from pg, and `bytes` is compared against a provider's
      // byte cap. A string comparison there is silently wrong rather than loudly wrong.
      bytes: Number(row.bytes),
      durationMs: row.duration_ms,
      mime: row.mime,
      probed: row.probed,
    },
    cancelRequestedAt: row.cancel_requested_at,
  };
}

/**
 * Pull the DAG specification back out of `runs.pipeline`.
 *
 * The column carries two things: what the run was *meant* to be (this) and what happened while
 * it ran (`planReason`, `batch`, `seams`, `warnings`). They share a column, which is why every
 * writer merges with `||` rather than assigning — `persistResult` used to assign and silently
 * deleted `pipeline.batch` on every batch run.
 *
 * Null rather than a default spec when `asr` is absent: a run created by the CLI's
 * single-process path has no spec and never wanted one, and inventing a plausible pipeline for
 * it is how a worker ends up executing steps for a run that already finished.
 */
export function readPipelineSpec(pipeline: RunPipeline): PipelineSpec | null {
  const asr = (pipeline as { asr?: unknown }).asr;
  if (!asr || typeof asr !== 'object') return null;
  const p = pipeline as unknown as PipelineSpec;
  return {
    asr: p.asr,
    ...(p.diarize ? { diarize: p.diarize } : {}),
    editorial: p.editorial ?? [],
    peaks: p.peaks ?? false,
    exports: p.exports ?? [],
  };
}

/** Anything with `execute`: the pool, or a transaction handle. */
type Executor = Pick<EngineContext['db'], 'execute'>;

/**
 * Merge a patch into `runs.pipeline`.
 *
 * `||`, never `=`. The column accumulates across stages and across processes — the planner
 * writes the spec, `persistOperation` writes `batch`, `normalize.text` writes `seams` — and a
 * bare assignment by any one of them deletes the others' work. That is not hypothetical: it
 * shipped once, and was found by querying `pipeline->'batch'` after a live batch run and
 * getting null.
 */
export async function mergePipeline(
  tx: Executor,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await tx.execute(sql`
    update runs set pipeline = pipeline || ${JSON.stringify(patch)}::jsonb
    where id = ${runId}::uuid
  `);
}

/** The rows `plan.chunks` wrote, in order, for the steps that consume them. */
export interface RunChunkRow {
  id: string;
  idx: number;
  offsetMs: number;
  contentStartMs: number;
  endMs: number;
  overlapLeadMs: number;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export async function loadRunChunks(
  ctx: EngineContext,
  runId: string,
): Promise<RunChunkRow[]> {
  const { rows } = await ctx.db.execute<{
    id: string;
    idx: number;
    offset_ms: number;
    content_start_ms: number;
    end_ms: number;
    overlap_lead_ms: number;
    status: RunChunkRow['status'];
  }>(sql`
    select id, idx, offset_ms, content_start_ms, end_ms, overlap_lead_ms, status
    from   run_chunks where run_id = ${runId}::uuid order by idx
  `);
  return rows.map((r) => ({
    id: r.id,
    idx: r.idx,
    offsetMs: r.offset_ms,
    contentStartMs: r.content_start_ms,
    endMs: r.end_ms,
    overlapLeadMs: r.overlap_lead_ms,
    status: r.status,
  }));
}
