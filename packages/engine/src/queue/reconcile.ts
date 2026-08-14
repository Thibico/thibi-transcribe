import { and, eq, inArray, sql } from 'drizzle-orm';
import { runs, runSteps, type RunStepRow, type StepState } from '@thibi/db';
import { assertContext, type EngineContext } from '../context.js';
import { insertAndNotify, type RunEventDraft } from '../events/emit.js';
import type { PendingSend, QueueName, StepKind } from './queues.js';

/** Reached the end of its road, whatever happened on the way. */
const TERMINAL: readonly StepState[] = ['done', 'skipped', 'failed', 'dead', 'cancelled'];

/** States that let a dependent proceed. See `satisfies()` for the third case. */
const SATISFYING: readonly StepState[] = ['done', 'skipped'];

/** Run states nothing further happens from. `partial` is terminal — but not sticky; see below. */
const TERMINAL_RUN: readonly string[] = ['done', 'failed', 'partial', 'cancelled'];

/**
 * Kinds whose death is a survivable casualty rather than a run-fatal failure.
 *
 * A three-hour transcript with one bad 55-second chunk is still worth having, and this set is
 * what makes that true. A `dead` step of one of these kinds both (a) satisfies its dependents
 * and (b) does not fail the run — **provided at least one sibling shard of the same kind
 * succeeded**. If none did, nothing was transcribed and the run has genuinely failed.
 *
 * The phase-9 plan intended this but did not implement it, and the gap closed `partial` off
 * twice over. `asr.chunk` is not `optional`, so one dead shard made `hardFailed` true and the
 * terminal branch chose `failed` before it ever reached the `partial` test; and independently,
 * the dependency-poisoning rule marked `normalize.text` — which depends on `['asr.chunk','*']`
 * — `failed` the moment any shard died, so the transcript would never have been assembled from
 * the survivors either. Both are fixed by one rule, stated here and used in both places.
 *
 * What makes it safe to proceed over a casualty is the placeholder segment the dead step's
 * handler writes: the timeline stays contiguous, so every downstream consumer sees the shape
 * it already expects rather than a hole it would need a special case for.
 */
const CASUALTY_KINDS = new Set<StepKind>(['asr.chunk']);

interface ReconcileOptions {
  /** Injectable for the concurrency test. Defaults to the real send. */
  onSend?: (send: PendingSend) => Promise<void>;
}

/**
 * Drive one run's DAG forward by whatever it can move.
 *
 * Called after every step transition and on the 30-second tick over every live run. It is the
 * **only writer of `runs.state` and `runs.progress`, and the only caller of `sendStep`** —
 * one promotion path and one send path, so a step cannot be started by two mechanisms that
 * disagree about how many times it has run.
 *
 * Convergent, not incremental: it reads the whole DAG and decides everything from scratch
 * each time. Calling it redundantly is free; failing to call it costs at most one 30-second
 * tick. That asymmetry is deliberate — every error path in this phase ends with a
 * `reconcile()` rather than with bespoke repair logic.
 */
export async function reconcile(
  ctx: EngineContext,
  runId: string,
  options: ReconcileOptions = {},
): Promise<void> {
  assertContext(ctx, ['doorbell']);
  const send = options.onSend ?? ((s: PendingSend) => ctx.doorbell.sendStep(s));

  const sends: PendingSend[] = [];

  await ctx.db.transaction(async (tx) => {
    /**
     * Serialise all reconciliation for this run.
     *
     * **`_xact_`, never the session variant.** A transaction-scoped lock is released by the
     * commit *or* the rollback; the session variant needs a `finally` on a client we may no
     * longer hold, and the first unhandled throw wedges that run permanently.
     *
     * `hashtextextended(text, seed)` returns `bigint`, which is the single-argument advisory
     * lock signature. The `run:` prefix keeps this lock space disjoint from the two-argument
     * `(classid, objid)` space the global GPU slots use.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'run:' + runId}, 42))`);

    /**
     * No `for update`. The advisory lock above is the mutual exclusion, and it is strictly
     * stronger for this purpose: it also excludes a concurrent reconciler that has not yet
     * touched the row. Adding a row lock on top would only introduce a second lock ordering
     * to deadlock against the handlers that write `runs.pipeline`.
     */
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run || TERMINAL_RUN.includes(run.state)) return;

    /**
     * Ordinal order is a topological order of the DAG, by construction: `planRun` emits every
     * step after the steps it depends on. Walking it in that order means one pass promotes a
     * whole chain rather than one link per call — a dependent is always visited after the
     * dependency whose state this pass just changed.
     *
     * It is an invariant of the planner rather than of this function, so a test asserts it
     * directly, and the 30-second tick is the backstop if a future planner ever breaks it: the
     * cost of getting it wrong would be a slow run, never a wrong one.
     */
    const steps = await tx.select().from(runSteps).where(eq(runSteps.runId, runId));

    /**
     * A run with no steps is not this reconciler's business, and saying so is load-bearing.
     *
     * The CLI drives the same stages in one process and never plans a DAG, so every run it
     * creates has zero `run_steps` rows — and the worker's 30-second tick reconciles *every*
     * live run, CLI-created ones included. Without this guard the terminal check finds
     * nothing outstanding, the `pending` → `running` transition below fires, and a worker
     * that will never do any work on that run marks it as running at 0% forever.
     *
     * Found by booting the worker against the dev database, where one such run had been
     * sitting since before this phase existed. It is exactly the class of bug no unit test
     * would have produced, because every test here plans a DAG first.
     */
    if (steps.length === 0) return;

    steps.sort((a, b) => a.ordinal - b.ordinal || a.shard - b.shard);

    const byId = new Map(steps.map((s) => [s.id, s]));
    const events: RunEventDraft[] = [];

    /** Did any sibling shard of this kind finish? Memoised: `satisfies` asks it per edge. */
    const succeededKinds = new Set(steps.filter((s) => s.state === 'done').map((s) => s.kind));

    const isCasualty = (s: RunStepRow): boolean =>
      s.state === 'dead' && CASUALTY_KINDS.has(s.kind as StepKind) && succeededKinds.has(s.kind);

    const satisfies = (s: RunStepRow): boolean =>
      SATISFYING.includes(s.state) || isCasualty(s);

    // ---- cancellation short-circuits everything ---------------------------------------
    if (run.cancelRequestedAt) {
      const killable = steps.filter((s) => s.state === 'pending' || s.state === 'ready');
      if (killable.length > 0) {
        await tx
          .update(runSteps)
          .set({ state: 'cancelled', finishedAt: ctx.clock.now() })
          .where(
            inArray(
              runSteps.id,
              killable.map((s) => s.id),
            ),
          );
        for (const s of killable) s.state = 'cancelled';
      }
      // `running` and `awaiting_external` steps observe the AbortSignal or the provider cancel
      // themselves. We wait for them to drain rather than lying about the run being stopped.
    }

    // ---- dependency satisfaction --------------------------------------------------------
    for (const s of steps) {
      if (s.state !== 'pending') continue;
      if (run.cancelRequestedAt) continue;
      // A retry's backoff. The step is `pending` on purpose and not ready to move yet.
      if (s.pollAfter && s.pollAfter.getTime() > ctx.clock.now().getTime()) continue;

      const deps = s.dependsOn
        .map((id) => byId.get(id))
        .filter((d): d is RunStepRow => d !== undefined);

      if (!deps.every(satisfies)) {
        /**
         * A hard-failed required dependency poisons its dependents *immediately*. Leaving
         * them `pending` forever is how a run hangs with no error and no progress — the
         * failure mode that is hardest to diagnose from the outside, because the run looks
         * merely slow.
         */
        const poisoned = deps.some(
          (d) => (d.state === 'failed' || d.state === 'dead' || d.state === 'cancelled') && !isCasualty(d),
        );
        if (poisoned) {
          const state: StepState = s.optional ? 'skipped' : 'failed';
          await tx
            .update(runSteps)
            .set({
              state,
              error: { code: 'DEPENDENCY_FAILED', dependsOn: s.dependsOn },
              finishedAt: ctx.clock.now(),
            })
            .where(and(eq(runSteps.id, s.id), eq(runSteps.state, 'pending')));
          s.state = state;
        }
        continue;
      }

      await tx
        .update(runSteps)
        .set({ state: 'ready' })
        .where(and(eq(runSteps.id, s.id), eq(runSteps.state, 'pending')));
      s.state = 'ready';
      sends.push(sendFor(s, runId));
    }

    /**
     * Re-ring for anything already `ready`.
     *
     * This covers the window between COMMIT and `sendStep` — a crash there leaves a step
     * promoted with no doorbell, and nothing else would ever notice. The singleton key makes
     * the re-send free when the original did arrive.
     */
    for (const s of steps) {
      if (s.state === 'ready' && !sends.some((x) => x.data.stepId === s.id)) {
        sends.push(sendFor(s, runId));
      }
    }

    // ---- weighted progress ----------------------------------------------------------------
    const totalWeight = steps.reduce((a, s) => a + s.weight, 0) || 1;
    const doneWeight = steps.reduce((a, s) => a + s.weight * stepFraction(s), 0);
    const progress = clamp01(doneWeight / totalWeight);

    // ---- terminal detection ------------------------------------------------------------------
    const allTerminal = steps.length > 0 && steps.every((s) => TERMINAL.includes(s.state));
    let nextState = run.state;

    if (allTerminal) {
      const hardFailed = steps.some(
        (s) => !s.optional && (s.state === 'failed' || s.state === 'dead') && !isCasualty(s),
      );
      const anyCancelled = steps.some((s) => s.state === 'cancelled');
      const casualties = steps.filter((s) => isCasualty(s));

      if (run.cancelRequestedAt && anyCancelled) nextState = 'cancelled';
      else if (hardFailed) nextState = 'failed';
      else if (casualties.length > 0) nextState = 'partial';
      else nextState = 'done';
    } else if (run.state === 'pending') {
      nextState = 'running';
    }

    const changed =
      nextState !== run.state || Math.abs(progress - run.progress) > PROGRESS_EPSILON;

    if (changed) {
      const terminal = TERMINAL_RUN.includes(nextState);
      await tx
        .update(runs)
        .set({
          state: nextState,
          progress,
          ...(terminal ? { finishedAt: ctx.clock.now() } : {}),
        })
        .where(eq(runs.id, runId));

      events.push({ runId, kind: 'run.progress', data: { state: nextState, progress } });
      if (terminal) events.push({ runId, kind: 'run.finished', data: { state: nextState } });
    }

    for (const e of events) await insertAndNotify(tx, e);
  });

  /**
   * Doorbells are rung after commit, and only after.
   *
   * A crash between the two is self-healing: the next tick re-reconciles and re-sends, and the
   * singleton key makes that a no-op if the original did land. A send *inside* the transaction
   * is not self-healing in the other direction — a worker can pick the job up and read a step
   * that has not committed yet, find nothing, and drop it.
   */
  for (const s of sends) await send(s);
}

/** Below this, a progress change is not worth a row and a wakeup. */
const PROGRESS_EPSILON = 0.0005;

function sendFor(step: RunStepRow, runId: string): PendingSend {
  return {
    queue: step.queue as QueueName,
    // Fresh per attempt: a retry must not be deduped against its own prior send.
    singletonKey: `${step.id}:${step.attempt}`,
    data: {
      stepId: step.id,
      runId,
      kind: step.kind as StepKind,
      attempt: step.attempt,
    },
    ...(step.pollAfter ? { startAfter: step.pollAfter } : {}),
  };
}

/**
 * How much of this step's weight counts as spent, in [0, 1].
 *
 * **A terminal step contributes its full weight even when it failed.** A run that failed shows
 * a full bar and a red state, not a bar frozen at 63% that reads as still working — the frozen
 * bar is what makes people wait an hour for something that stopped.
 *
 * A started step is worth 0.1 until it reports otherwise: visible, honest, and never inflated
 * upward by guessing.
 */
export function stepFraction(s: Pick<RunStepRow, 'state' | 'output'>): number {
  if (TERMINAL.includes(s.state)) return 1;
  if (s.state === 'running' || s.state === 'awaiting_external') {
    const p = (s.output as { progress?: unknown } | null)?.progress;
    return typeof p === 'number' ? clamp01(p) : 0.1;
  }
  return 0;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
