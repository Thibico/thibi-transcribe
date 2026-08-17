import { sql } from 'drizzle-orm';
import type { EngineContext } from '../context.js';
import { insertAndNotify } from '../events/emit.js';

/**
 * Stopping a run that is already moving.
 *
 * §10's rule: **a cancel that only stops the *next* step is not a cancel.** The work is in four
 * places at once and each needs its own mechanism.
 *
 * | Where the work is | Mechanism | Built |
 * |---|---|---|
 * | `pending` / `ready` steps | `reconcile` sets `cancelled` in the same pass | yes, since the reconciler |
 * | A running handler | the heartbeat notices and aborts its signal | yes, here |
 * | ffmpeg, provider calls | every stage already takes `ctx.signal` | yes, since phase 1 |
 * | External operations | the handler's own pre-poll check, plus a best-effort provider cancel | yes, `asr.poll` and `diarize.poll` |
 *
 * ## Why the heartbeat rather than the `LISTEN` the plan specifies
 *
 * §10 propagates to a running handler over a `pg_notify('run_cancel', …)` channel that every
 * worker subscribes to. The notify is sent — the UI and any future listener want it — but the
 * mechanism that makes cancellation *true* is the heartbeat, and that is a deliberate inversion
 * of the plan.
 *
 * A `LISTEN` needs a dedicated non-pooled client held open for the life of the process, and its
 * failure mode is silence: the connection drops, nothing throws, and cancellation quietly stops
 * working until someone notices a run that will not die. This project has an open investigation
 * into exactly that shape of failure — a poll chain that went quiet for two hours with no error
 * logged — and adding a second subsystem with the same failure mode, to carry a *guarantee*,
 * would be repeating the mistake while still reading the report on it.
 *
 * The heartbeat is the opposite shape. It already runs every 15 seconds for every running step,
 * it already round-trips to Postgres, and it already aborts the handler when it does not like
 * what it finds. Reading `cancel_requested_at` in the same statement costs one join and no new
 * infrastructure, and it is self-healing by construction: a missed check is retried 15 seconds
 * later, forever, because the state lives in the row rather than in a message that was or was
 * not delivered. The cost is up to 15 seconds of latency on a cancel, against a mechanism that
 * cannot silently stop working. **The listener remains worth adding as an accelerator** — see
 * the note in `lease.ts` — but as the fast path over a guarantee, never as the guarantee.
 */

/** The channel §10 specifies, kept separate from `run_events` so a subscriber need not parse the progress firehose. */
export const CANCEL_CHANNEL = 'run_cancel';

export interface RequestCancelResult {
  /** False when the run was already cancelling, or does not exist. The call stays idempotent. */
  requested: boolean;
  /** Null for a CLI cancel, which has no authenticated user to name. */
  requestedBy: string | null;
}

/**
 * Ask a run to stop.
 *
 * Idempotent by predicate: `where cancel_requested_at is null` means a second press of the
 * button does not move the timestamp, so "when was this cancelled" keeps answering the question
 * it was asked. A repeat is not an error — it is what an impatient user does — so it returns
 * `requested: false` rather than throwing.
 *
 * It does **not** reconcile. `reconcile` needs a doorbell on the context and this is called from
 * places that have none (the CLI's `runs cancel`, and a future HTTP route), so the caller
 * reconciles if it can and the 30-second tick does it otherwise. The cost of not reconciling
 * here is that `pending` steps stay pending for one tick; the cost of requiring a doorbell would
 * be that a cancel is impossible without one.
 */
export async function requestCancel(
  ctx: EngineContext,
  runId: string,
  requestedBy?: string,
): Promise<RequestCancelResult> {
  const by = requestedBy ?? null;
  let requested = false;

  await ctx.db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update runs
      set    cancel_requested_at = now(),
             cancel_requested_by = ${by}
      where  id = ${runId}::uuid
        and  cancel_requested_at is null
        and  state not in ('done', 'failed', 'partial', 'cancelled')
      returning id
    `);
    requested = updated.rows.length > 0;
    if (!requested) return;

    await insertAndNotify(tx, {
      runId,
      kind: 'run.cancelling',
      data: { by },
    });

    /**
     * The separate channel, sent inside the transaction like every other notify here.
     *
     * `pg_notify` inside a transaction is delivered on commit and discarded on rollback, which
     * is the property that matters: a listener must never learn of a cancel that was rolled
     * back. Nothing subscribes to this yet — see the module note — and it is sent anyway so
     * that adding a subscriber later is a subscriber and not also a producer.
     */
    await tx.execute(sql`select pg_notify(${CANCEL_CHANNEL}, ${runId})`);
  });

  return { requested, requestedBy: by };
}

/**
 * Is this run cancelling?
 *
 * Used by the heartbeat, so it is one indexed lookup by primary key and nothing more. It asks
 * about the *run* rather than the step because that is where a user's decision is recorded —
 * a step has no opinion about being cancelled.
 */
export async function isRunCancelling(ctx: EngineContext, runId: string): Promise<boolean> {
  const { rows } = await ctx.db.execute<{ cancelling: boolean }>(sql`
    select cancel_requested_at is not null as cancelling from runs where id = ${runId}::uuid
  `);
  return rows[0]?.cancelling ?? false;
}
