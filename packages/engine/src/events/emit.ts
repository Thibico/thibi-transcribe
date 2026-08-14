import { sql } from 'drizzle-orm';
import type { Db } from '@thibi/db';
import type { EventSink, Logger, RunEvent } from '../context.js';

/** Anything with `execute`: the pool, or a transaction handle. */
type Executor = Pick<Db, 'execute'>;

export interface RunEventDraft {
  runId: string;
  kind: string;
  data?: Record<string, unknown>;
}

/**
 * Insert an event and ring the doorbell, in one statement and in the caller's transaction.
 *
 * Both halves of that sentence are load-bearing.
 *
 * **The payload is a pointer, never the data.** `NOTIFY` caps a payload at 8000 bytes and a
 * transcript segment blows straight through it; listeners re-read `run_events` by `seq`. This
 * is what "the doorbell, not the transport" means concretely.
 *
 * **In the caller's transaction**, so a listener can never observe an event before the state
 * it describes. The row and the state change become visible at the same instant, and
 * `pg_notify` inside a transaction is only delivered on commit — so a rolled-back transition
 * announces nothing, which is the behaviour you would otherwise have to write a compensating
 * path for.
 */
export async function insertAndNotify(tx: Executor, event: RunEventDraft): Promise<number> {
  const result = await tx.execute<{ seq: string | number }>(sql`
    with e as (
      insert into run_events (run_id, kind, data)
      values (${event.runId}::uuid, ${event.kind}, ${JSON.stringify(event.data ?? {})}::jsonb)
      returning seq, run_id, kind
    )
    select seq,
           pg_notify('run_events',
                     json_build_object('seq', seq, 'runId', run_id, 'kind', kind)::text)
    from e
  `);
  return Number(result.rows[0]!.seq);
}

/**
 * Kinds whose only job is to move a bar, and which are therefore safe to drop.
 *
 * Safe *because* events are snapshots rather than deltas: superseding one progress event with
 * a later one loses nothing, where superseding a `+= 1` would leave the bar permanently short.
 */
const COALESCED = new Set(['run.progress', 'step.progress', 'log']);

/**
 * Kinds that bypass the window entirely.
 *
 * A user waiting to find out whether their run failed must not wait out a debounce. Anything
 * terminal, and anything an operator would act on, flushes on the spot.
 */
const IMMEDIATE = new Set([
  'run.finished',
  'run.cancelling',
  'step.dead',
  'step.retrying',
  'step.skipped',
]);

export interface CoalescingEventSinkOptions {
  /** Default 500 ms. At most one coalesced event per run per window. */
  windowMs?: number;
  logger?: Logger;
}

/**
 * The `ctx.events` a worker hands to handlers.
 *
 * A 180-chunk run emits a progress event per chunk plus per-chunk logs, and the editor does
 * not need 20 Hz. This holds at most one coalesced event per run per window and flushes
 * anything urgent immediately.
 *
 * **`reconcile` does not go through here**, and that is deliberate rather than an oversight
 * in the wiring. Its events must be written inside the transaction that makes the state
 * change, so a listener cannot see a progress snapshot describing a state that has not
 * committed — a guarantee a debounce buffer sitting outside the transaction cannot make.
 * Reconcile is rate-limited instead by its own change guard: it emits nothing unless the
 * state changed or progress moved by more than 0.0005, which on the 180-chunk run above is
 * one event per chunk completion rather than one per reconcile call.
 */
export class CoalescingEventSink implements EventSink {
  private readonly windowMs: number;
  private readonly logger: Logger | undefined;
  /** Latest pending snapshot per `${runId}\0${kind}`. Newer wins; that is the point. */
  private readonly pending = new Map<string, RunEvent>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly db: Db,
    options: CoalescingEventSinkOptions = {},
  ) {
    this.windowMs = options.windowMs ?? 500;
    this.logger = options.logger;
  }

  emit(event: RunEvent): void | Promise<void> {
    if (this.stopped) return;
    if (IMMEDIATE.has(event.kind) || !COALESCED.has(event.kind)) {
      return this.write(event);
    }
    this.pending.set(`${event.runId}\0${event.kind}`, event);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.windowMs).unref();
  }

  /** Write everything buffered. Called on the window timer, and on drain. */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const event of batch) await this.write(event);
  }

  /** Flush and stop accepting. Idempotent, so a SIGTERM path can call it freely. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    this.stopped = true;
  }

  /**
   * An event that cannot be written must not take a step down with it.
   *
   * This is progress reporting, not the transcript. A run that finished successfully but
   * could not announce it is still a run that finished successfully, and the SSE route's
   * periodic re-read repairs the client's view regardless. Throwing here would convert a
   * cosmetic failure into a dead step.
   */
  private async write(event: RunEvent): Promise<void> {
    try {
      await insertAndNotify(this.db, {
        runId: event.runId,
        kind: event.kind,
        ...(event.data !== undefined ? { data: event.data } : {}),
      });
    } catch (err) {
      this.logger?.warn(
        { err, runId: event.runId, kind: event.kind },
        'dropping a run event that could not be written',
      );
    }
  }
}
