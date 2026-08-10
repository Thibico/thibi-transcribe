import type { EngineContext } from '../context.js';
import { findOrphanOperation, type BatchDeps } from '../providers/google/batch.js';
import type { BatchOp } from '../providers/types.js';
import { stagingPrefixFor } from '../staging/types.js';
import { loadOperation, persistOperation } from './batch-persist.js';

/**
 * Recovering a run whose operation we may have lost.
 *
 * The transaction in `persistOperation` is the real fix; this closes the last window, which
 * is between `batchRecognize` returning a name and that name reaching Postgres. It is narrow
 * — one statement wide — and it is worth closing anyway, because the failure it prevents is
 * paying twice for two hours of audio Google has already transcribed.
 *
 * The recovery is possible at all only because `staging_prefix` is derived from `runId` and
 * is therefore byte-identical across restarts: the input URI a crashed process sent is the
 * input URI this process can search for.
 */

/** Operations older than this are a previous run of the same audio, not ours. */
export const DEFAULT_LOOKBACK_MS = 6 * 60 * 60_000;

export type ResumeOutcome =
  | { kind: 'not-found' }
  | { kind: 'not-batch'; mode: string }
  | { kind: 'already-finished'; state: string }
  /** The common, cheap case: the name was persisted, so just poll it. */
  | { kind: 'resume'; op: BatchOp; recovered: false }
  /** The crash window fired and the operation was matched by input URI. */
  | { kind: 'resume'; op: BatchOp; recovered: true }
  /** `mode='batch'`, no operation name, and no matching operation at Google. */
  | { kind: 'no-operation'; stagingPrefix: string | null };

export interface ResumeOptions {
  runId: string;
  deps: BatchDeps;
  lookbackMs?: number;
}

/**
 * Work out how to continue a batch run.
 *
 * Reads the run, and only reaches for Google's operation list in the one case that needs it.
 * Listing on every resume would be a wasted request on the overwhelmingly common path where
 * the name is exactly where we put it.
 */
export async function resumeBatchRun(
  ctx: EngineContext,
  options: ResumeOptions,
): Promise<ResumeOutcome> {
  const row = await loadOperation(ctx, options.runId);
  if (!row) return { kind: 'not-found' };
  if (row.mode !== 'batch') return { kind: 'not-batch', mode: row.mode };

  // `partial` is not in this list on purpose: a batch run is whole-file, so it has no way to
  // be partially successful, and if one ever appears it wants investigating rather than
  // silently re-polling.
  if (row.state === 'done' || row.state === 'cancelled') {
    return { kind: 'already-finished', state: row.state };
  }

  if (row.op) return { kind: 'resume', op: row.op, recovered: false };

  // No stored operation. Either the crash window fired, or the run never got to the submit.
  const prefix = row.stagingPrefix ?? stagingPrefixFor(options.runId);
  const nowMs = ctx.clock.now().getTime();

  const orphan = await findOrphanOperation(options.deps, {
    inputUri: `gs://${ctx.staging?.bucket ?? ''}/${prefix}audio.flac`,
    sinceMs: options.lookbackMs ?? DEFAULT_LOOKBACK_MS,
    nowMs,
    outputPrefix: `gs://${ctx.staging?.bucket ?? ''}/${prefix}out`,
  });

  if (!orphan) return { kind: 'no-operation', stagingPrefix: row.stagingPrefix };

  // Write it down before polling it, so this recovery does not have to happen twice.
  await persistOperation(ctx, options.runId, orphan);
  return { kind: 'resume', op: orphan, recovered: true };
}
