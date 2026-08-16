import { diarizationResultKey } from '@thibi/storage';
import type { EngineContext } from '../context.js';
import type { DiarizationResult, DiarizeHandle } from './types.js';

/**
 * What a queue-driven diarization leaves behind between its steps.
 *
 * Phase 3 ran submit → poll → fetch → reconcile → persist inside one function, so nothing had
 * to survive between them. Phase 9 splits that across three steps in up to three processes,
 * and the two things that must outlive a worker are the handle and the turns. They are stored
 * in different places on purpose, and the difference is size rather than taste: the handle is
 * four fields and belongs beside the run so `thibi runs show` can print it, and the result is
 * an unbounded array of turns plus the source's raw response, which has no business in a
 * `jsonb` column that every reconcile pass reads.
 */

/** What lands in `runs.pipeline.diarize`. `DiarizeHandle` is JSON-only for exactly this. */
export interface DiarizePipelineRecord extends DiarizeHandle {
  /** Bumped by `diarize.poll`, never by `attempt` — polling is not retrying. */
  polls?: number;
  /** How many times a `lost` task has been resubmitted. Capped at one. */
  lostResubmits?: number;
  doneAtMs?: number;
  latencyMs?: number;
  computeMs?: number;
  realtimeFactor?: number;
  numSpeakers?: number;
}

/**
 * Write the handle down before anything can poll it.
 *
 * The same ordering `persistOperation` enforces for `batchRecognize`, and the same reasoning:
 * a lost task id means a second submission, and on a three-hour file that is the difference
 * between waiting five hours and waiting ten. It costs no money here — the sidecar is ours —
 * but it costs the one GPU slot, which on this box is the scarcer resource.
 *
 * `jsonb ||` merges rather than replaces, so this cannot clobber the planner's spec or the
 * `batch` record beside it. Every writer of that column obeys the same rule.
 */
export async function persistDiarizeHandle(
  ctx: EngineContext,
  runId: string,
  handle: DiarizeHandle,
): Promise<void> {
  const record: DiarizePipelineRecord = { ...handle };
  await ctx.db.$client.query(
    `update runs
        set pipeline = pipeline || jsonb_build_object('diarize', $2::jsonb)
      where id = $1`,
    [runId, JSON.stringify(record)],
  );
}

/** Merge poll findings into `runs.pipeline.diarize` without a read-modify-write race. */
export async function recordDiarizeProgress(
  ctx: EngineContext,
  runId: string,
  patch: Partial<DiarizePipelineRecord>,
): Promise<void> {
  await ctx.db.$client.query(
    `update runs
        set pipeline = jsonb_set(
              pipeline,
              '{diarize}',
              coalesce(pipeline->'diarize', '{}'::jsonb) || $2::jsonb,
              true)
      where id = $1`,
    [runId, JSON.stringify(patch)],
  );
}

/**
 * Rehydrate the handle a previous step submitted. Null when nothing has been submitted yet.
 *
 * Read from the run row rather than from the submitting step's `output`, so a `diarize.poll`
 * that runs on a different container after a redeploy needs to know only its run id — the same
 * property that lets `loadOperation` resume a batch poll.
 */
export async function loadDiarizeHandle(
  ctx: EngineContext,
  runId: string,
): Promise<DiarizePipelineRecord | null> {
  const { rows } = await ctx.db.$client.query<{ diarize: DiarizePipelineRecord | null }>(
    `select pipeline->'diarize' as diarize from runs where id = $1`,
    [runId],
  );
  const record = rows[0]?.diarize;
  return record?.taskId ? record : null;
}

/**
 * Park the diarizer's result where the reconciler will find it.
 *
 * Object storage rather than `speaker_turns`, and the distinction matters: `speaker_turns` rows
 * are written by `persistDiarization` in the same transaction that attributes segments and
 * words, because a turn set without its attribution is a half-finished diarization that the
 * editor would render as speakers nobody said anything as. This is the raw material for that
 * transaction, not a partial version of it.
 */
export async function writeDiarizationResult(
  ctx: EngineContext,
  runId: string,
  result: DiarizationResult,
): Promise<string> {
  const key = diarizationResultKey(runId);
  await ctx.store.put(key, Buffer.from(JSON.stringify(result)), {
    contentType: 'application/json',
  });
  return key;
}

/** Read it back, or null if the diarization never got that far. Null is an ordinary answer. */
export async function readDiarizationResult(
  ctx: EngineContext,
  runId: string,
): Promise<DiarizationResult | null> {
  const key = diarizationResultKey(runId);
  if (!(await ctx.store.head(key))) return null;
  const stream = await ctx.store.get(key);
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as DiarizationResult;
}
