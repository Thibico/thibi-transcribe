import { sql } from 'drizzle-orm';
import type { RunStepRow } from '@thibi/db';
import type { EngineContext } from '../context.js';
import { AbortedError, LeaseLostError } from '../errors.js';

/**
 * How often a running step says it is still alive.
 *
 * The recovery sweep reclaims a step whose heartbeat is older than
 * {@link STALE_AFTER_SECONDS}, which is six intervals. Tight enough to recover from a killed
 * container in under two minutes, loose enough that a garbage-collection pause or a slow
 * write does not let another worker steal a step that is doing fine.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Six missed heartbeats. See {@link HEARTBEAT_INTERVAL_MS}. */
export const STALE_AFTER_SECONDS = 90;

/**
 * Run a handler while holding, and proving, a lease on its step.
 *
 * Every handler runs inside this; there is no opt-out. Two things can abort the signal it
 * hands the handler, and the difference between them matters to the retry policy:
 *
 * - **The lease was stolen.** The heartbeat's conditional UPDATE matched no row, which means
 *   the recovery sweep decided this worker was dead and handed the step to another one.
 *   `AND lease_owner = $owner` is what makes that detectable at all — without it a
 *   resurrected step and its zombie predecessor both run to completion and both write
 *   segments, and the run quietly ends up with duplicates. On detection this worker aborts
 *   and writes **nothing**, because the row it would write to is no longer its own.
 * - **The process is shutting down**, via `ctx.signal`. That is a cancellation, not a fault.
 *
 * A transient database blip during a heartbeat is swallowed: the 90-second window absorbs
 * several, and treating one failed UPDATE as a lost lease would abandon healthy work every
 * time the database hiccupped.
 */
export async function withHeartbeat<T>(
  ctx: EngineContext,
  step: Pick<RunStepRow, 'id'>,
  owner: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();

  const onParentAbort = (): void => {
    controller.abort(new AbortedError('the worker is shutting down'));
  };
  if (ctx.signal) {
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setInterval(() => {
    void ctx.db
      .execute(
        sql`update run_steps set heartbeat_at = now()
            where id = ${step.id} and state = 'running' and lease_owner = ${owner}`,
      )
      .then((result) => {
        if (result.rowCount === 0) controller.abort(new LeaseLostError(step.id));
      })
      .catch(() => {
        // A transient DB error is not evidence the lease is gone. The 90-second window is
        // six of these; losing one is normal and losing six is the thing being detected.
      });
  }, HEARTBEAT_INTERVAL_MS);

  // Never let the heartbeat alone hold the event loop open.
  timer.unref();

  try {
    return await fn(controller.signal);
  } finally {
    clearInterval(timer);
    ctx.signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * The reason a controller was aborted, if it was aborted for one of ours.
 *
 * `AbortController.abort(reason)` puts the reason on the signal rather than throwing it, and
 * a handler that simply returns early on `signal.aborted` would otherwise land as a success.
 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.aborted ? signal.reason : undefined;
}
