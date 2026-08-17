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

export interface HeartbeatOptions {
  /**
   * Override the beat interval. **Tests only**, and it exists for one specific test.
   *
   * Cancellation of a *running* handler is detected by the heartbeat, so asserting it at the
   * real 15-second interval would mean a 15-second test — and a suite slow enough that people
   * stop running it is a suite that stops catching things. Production never passes this.
   */
  intervalMs?: number;
}

/**
 * Run a handler while holding, and proving, a lease on its step.
 *
 * Every handler runs inside this; there is no opt-out. **Three** things can abort the signal it
 * hands the handler, and the differences matter to the retry policy:
 *
 * - **The lease was stolen.** The heartbeat's conditional UPDATE matched no row, which means
 *   the recovery sweep decided this worker was dead and handed the step to another one.
 *   `AND lease_owner = $owner` is what makes that detectable at all — without it a
 *   resurrected step and its zombie predecessor both run to completion and both write
 *   segments, and the run quietly ends up with duplicates. On detection this worker aborts
 *   and writes **nothing**, because the row it would write to is no longer its own.
 * - **The process is shutting down**, via `ctx.signal`. That is a cancellation, not a fault.
 * - **The run was cancelled**, which the same statement learns for free by joining `runs`.
 *   That is how a cancel reaches a handler that is already mid-request; §10 specifies a
 *   `LISTEN` channel instead, and `cancel.ts` explains why the guarantee lives here and the
 *   channel is left as the accelerator.
 *
 * A transient database blip during a heartbeat is swallowed: the 90-second window absorbs
 * several, and treating one failed UPDATE as a lost lease would abandon healthy work every
 * time the database hiccupped. **A cancel is therefore also delayed by a blip, and that is the
 * right trade**: a cancel that arrives 15 seconds late is a delay, and a step abandoned because
 * one UPDATE timed out is lost work.
 */
export async function withHeartbeat<T>(
  ctx: EngineContext,
  step: Pick<RunStepRow, 'id'>,
  owner: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: HeartbeatOptions = {},
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
      .execute<{ cancelling: boolean }>(
        /**
         * The heartbeat and the cancel check, in one round trip.
         *
         * `returning` gives the run's cancel state for free — the row is already being written
         * and its `run_id` is already the join key — which is what makes cancellation cost no
         * new infrastructure. §10 propagates a cancel to a running handler over a
         * `LISTEN run_cancel` channel instead; the notify is still sent, but the *guarantee*
         * lives here, because a listener's failure mode is a dropped connection and silence,
         * and this one re-reads the truth every fifteen seconds forever. See `cancel.ts`.
         */
        sql`update run_steps s set heartbeat_at = now()
            from   runs r
            where  s.id = ${step.id} and s.state = 'running' and s.lease_owner = ${owner}
              and  r.id = s.run_id
            returning (r.cancel_requested_at is not null) as cancelling`,
      )
      .then((result) => {
        if (result.rowCount === 0) {
          controller.abort(new LeaseLostError(step.id));
          return;
        }
        /**
         * A cancelled run aborts its running steps. `AbortedError` is non-retryable, which is
         * what stops `onStepError` from scheduling five more attempts of the thing the user
         * just asked to stop.
         */
        if (result.rows[0]?.cancelling === true) {
          controller.abort(new AbortedError('the run was cancelled'));
        }
      })
      .catch(() => {
        // A transient DB error is not evidence the lease is gone. The 90-second window is
        // six of these; losing one is normal and losing six is the thing being detected.
      });
  }, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);

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
