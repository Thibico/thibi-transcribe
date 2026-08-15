import { sql } from 'drizzle-orm';
import type { EngineContext } from '../context.js';
import { reconcile } from './reconcile.js';
import { STALE_AFTER_SECONDS } from './lease.js';

export interface RecoverOptions {
  /**
   * Pull every scheduled poll forward to now. **Boot only.** See `nudgeExternalWork` for why
   * a periodic nudge would silently flatten the poll backoff to the tick interval.
   */
  nudgeExternal?: boolean;
}

export interface RecoveryReport {
  /** Steps whose worker stopped heartbeating and which are now someone else's to run. */
  reclaimed: number;
  /** `awaiting_external` steps made immediately pollable. Never reset — see below. */
  nudged: number;
  /** Live runs re-reconciled. */
  reconciled: number;
}

/**
 * Reclaim steps abandoned by a worker that died.
 *
 * A step whose heartbeat has gone quiet is **dead work, not lost work**: it goes back to
 * `pending` with `attempt + 1`, and the reconciler re-promotes it. The attempt increments
 * because the work really was attempted and really did fail — a worker that vanishes
 * mid-chunk has usually vanished for a reason that will repeat, and a step that could be
 * reclaimed without limit would loop forever against an OOM.
 */
export async function reclaimStaleLeases(ctx: EngineContext): Promise<string[]> {
  const result = await ctx.db.execute<{ run_id: string }>(sql`
    update run_steps
    set    state = case when attempt + 1 >= max_attempts
                        then (case when optional then 'skipped' else 'dead' end)::step_state
                        else 'pending'::step_state end,
           attempt = attempt + 1,
           lease_owner = null,
           heartbeat_at = null,
           finished_at = case when attempt + 1 >= max_attempts then now() else finished_at end,
           error = coalesce(error, '{}'::jsonb)
                   || jsonb_build_object('code', 'HEARTBEAT_LOST',
                                         'lostAt', now(),
                                         'lastOwner', lease_owner)
    where  state = 'running'
      and  heartbeat_at < now() - make_interval(secs => ${STALE_AFTER_SECONDS})
    returning run_id
  `);
  return result.rows.map((r) => r.run_id);
}

/**
 * Make external work pollable again. **Never reset it.**
 *
 * The single most valuable statement in this phase, and the one whose absence is invisible
 * until the invoice arrives. An `awaiting_external` step is running on someone else's
 * computer: Google is transcribing, or the sidecar is diarizing. Treating it like a stale
 * `running` step — resetting it so it can be "retried" — re-submits work that is already
 * happening and pays for it twice, silently, for two hours.
 *
 * All this does is drop `poll_after` to now.
 *
 * **What it does not do, measured 2026-08-15 against a live operation: make the next poll
 * immediate.** The plan and amendment 92 both claim a restart costs nothing instead of a poll
 * cycle. It does not, and the reason is the singleton key. Polling never bumps `attempt`, so
 * every poll of a step sends under the same key `${stepId}:${attempt}`, and `reconcile` has
 * *already* queued the next poll with the old `start_after` before the crash. The boot re-ring
 * hits the `short` policy's one-queued-job-per-key rule and is dropped. The row says "poll now";
 * the queue says "poll in 27 seconds"; the queue wins. Observed exactly that, to the second.
 *
 * So this is a **repair for a doorbell the queue lost**, not an accelerator — and it is still
 * worth having in that role, because a step whose job was archived or dropped would otherwise
 * wait for nothing at all. Making a restart genuinely immediate needs `Doorbell` to be able to
 * reschedule or cancel a queued job, which is new interface surface and is recorded as debt
 * rather than bolted on. The cost of not having it is bounded by one poll interval — latency
 * only, never correctness and never money.
 *
 * **It is a boot statement, and running it periodically would be a bug.** `least(poll_after,
 * now())` drags a *future* poll forward, so calling it on the 60-second tick would pull every
 * scheduled poll back to now once a minute — a capped backoff of 30 s → 300 s would become a
 * flat 60 s, and a batch run that takes two hours would make 120 pointless requests against a
 * quota the sync path also needs. It was on the tick until the first handler that returns
 * `awaiting_external` was written; nothing could have noticed before, because nothing had ever
 * put a step in that state. `recoverTick` now takes it as an option and only the boot call
 * passes it.
 */
export async function nudgeExternalWork(ctx: EngineContext): Promise<string[]> {
  const result = await ctx.db.execute<{ run_id: string }>(sql`
    update run_steps
    set    poll_after = least(coalesce(poll_after, now()), now())
    where  state = 'awaiting_external'
      and  (poll_after is null or poll_after > now())
    returning run_id
  `);
  return result.rows.map((r) => r.run_id);
}

/** Every run that is not finished. Cheap, and the input to the reconcile tick. */
export async function liveRunIds(ctx: EngineContext): Promise<string[]> {
  const result = await ctx.db.execute<{ id: string }>(sql`
    select id from runs where state not in ('done', 'failed', 'partial', 'cancelled')
  `);
  return result.rows.map((r) => r.id);
}

/**
 * The boot and periodic sweep.
 *
 * This is what replaces the old app's `UPDATE runs SET status='error' WHERE status IN
 * ('queued','chunking','running')` at every startup — a line that converted every restart
 * into total data loss, and the specific behaviour this whole phase exists to eliminate. A
 * test asserts no string matching `interrupted by server restart` survives anywhere in the
 * repository.
 *
 * Run on boot and every 60 seconds. Reconciling every live run afterwards is what repairs a
 * run whose doorbell was lost in the window between COMMIT and `sendStep`, so this doubles as
 * the backstop that lets `reconcile` ring after committing rather than inside its transaction.
 */
export async function recoverTick(
  ctx: EngineContext,
  options: RecoverOptions = {},
): Promise<RecoveryReport> {
  const reclaimed = await reclaimStaleLeases(ctx);
  const nudged = options.nudgeExternal === true ? await nudgeExternalWork(ctx) : [];
  const reconciled = await reconcileAllLive(ctx);
  return { reclaimed: reclaimed.length, nudged: nudged.length, reconciled };
}

/**
 * Reconcile every run that has not finished.
 *
 * The 30-second tick, and the reason `reconcile` is allowed to ring its doorbells *after*
 * committing rather than inside its transaction: a crash in that window leaves a promoted
 * step nobody was told about, and this is what finds it. Also the backstop for a doorbell
 * that pg-boss lost, a worker that died between claim and heartbeat, and any other gap where
 * the database is right and the queue is stale.
 *
 * **One wedged run must not stop the others from being repaired.** A run whose reconcile
 * throws is logged and skipped; it gets another chance in thirty seconds.
 */
export async function reconcileAllLive(ctx: EngineContext): Promise<number> {
  const live = await liveRunIds(ctx);
  for (const runId of live) {
    try {
      await reconcile(ctx, runId);
    } catch (err) {
      ctx.logger?.error({ err, runId }, 'reconcile failed during sweep');
    }
  }
  return live.length;
}
