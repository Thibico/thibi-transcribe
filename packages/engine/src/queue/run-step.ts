import { and, eq, sql } from 'drizzle-orm';
import { runSteps, type RunStepRow } from '@thibi/db';
import { assertContext, type EngineContext } from '../context.js';
import { AbortedError, LeaseLostError, isRetryable } from '../errors.js';
import { insertAndNotify } from '../events/emit.js';
import { withHeartbeat } from './lease.js';
import { reconcile } from './reconcile.js';
import { POLICY, backoffMs } from './retry.js';
import type { StepJob, StepKind } from './queues.js';

/**
 * What a handler returns.
 *
 * Deliberately not "throw or return void". A step has four successful endings and they are
 * genuinely different — finished, waiting on someone else's computer, deliberately not done,
 * and could-not-start-yet — and collapsing any of them into an exception would put them
 * through the retry machinery, which is wrong for all four.
 */
export type StepResult =
  | {
      state: 'done';
      output?: Record<string, unknown>;
      costUsd?: number;
    }
  | {
      /** Work is happening at a provider. Holds no worker slot; not a lease state. */
      state: 'awaiting_external';
      externalRef?: string;
      pollAfter?: Date;
      deadlineAt?: Date;
      output?: Record<string, unknown>;
    }
  | {
      /** An optional step declining to run — its precondition was absent. */
      state: 'skipped';
      output?: Record<string, unknown>;
    }
  | {
      /**
       * No global slot was free. Back to `pending` with a short delay and **`attempt`
       * untouched**.
       *
       * Slot contention is not a fault and must never consume a retry budget. Get this wrong
       * and a busy hour marks half the diarize steps dead without a single thing having gone
       * wrong.
       */
      state: 'no_slot';
      retryAfter: Date;
    };

export type StepHandler = (
  ctx: EngineContext,
  step: RunStepRow,
  signal: AbortSignal,
) => Promise<StepResult>;

export type HandlerRegistry = Partial<Record<StepKind, StepHandler>>;

/**
 * Everything that can be safely written about a failure.
 *
 * Phase 10 §9 specifies a fuller scrubber; this is the honest subset until it exists. It is
 * allowlist-shaped rather than denylist-shaped on purpose: `/admin/queue` renders this
 * verbatim, so the question is not "what should be removed" but "what has been positively
 * decided is safe to show". A provider's message travels because replacing it with a guess is
 * what made a misconfigured project look like a regional restriction in the old app.
 */
export function serialiseError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { code: 'UNKNOWN', message: String(err).slice(0, 2000) };
  }
  const status = (err as { status?: unknown }).status;
  const code = (err as { code?: unknown }).code;
  return {
    code: typeof code === 'string' ? code : err.name,
    message: err.message.slice(0, 2000),
    ...(typeof status === 'number' ? { status } : {}),
    at: new Date().toISOString(),
  };
}

/**
 * The one path every step takes.
 *
 * A handler receives `(ctx, step, signal)` and returns a `StepResult`. It never touches
 * pg-boss, never calls `reconcile`, and never decides its own retry — all three are the
 * reconciler's and this function's business, and a lint rule stops `handlers/**` from
 * importing either module.
 */
export async function runStep(
  ctx: EngineContext,
  registry: HandlerRegistry,
  job: StepJob,
): Promise<void> {
  assertContext(ctx, ['workerId']);
  const owner = ctx.workerId;

  /**
   * Claim by conditional UPDATE, never by read-then-act.
   *
   * `AND attempt = $n` is what makes a duplicate doorbell a no-op instead of a second
   * execution: a job delivered for attempt 0 cannot claim a step that has since moved to
   * attempt 1. This is the old app's `if (run.status !== 'queued') return` done atomically —
   * same intent, without the window between the read and the write.
   */
  const claimed = await ctx.db.execute<RunStepRow>(sql`
    update run_steps
    set    state = 'running',
           lease_owner = ${owner},
           heartbeat_at = now(),
           started_at = coalesce(started_at, now())
    where  id = ${job.stepId}
      and  state in ('ready', 'awaiting_external')
      and  attempt = ${job.attempt}
    returning *
  `);

  const row = claimed.rows[0];
  if (!row) return; // Someone else has it, or it has moved on. Both are fine.

  const step = normaliseRow(row);
  const handler = registry[step.kind as StepKind];

  try {
    if (!handler) {
      // A kind with no handler is a deployment mistake — a worker built before a step kind
      // existed, or a typo in the registry. Not retryable: the next attempt has the same
      // registry, and burning the budget only delays the operator seeing why.
      throw new NoHandlerError(step.kind);
    }
    const result = await withHeartbeat(ctx, step, owner, (signal) => handler(ctx, step, signal));
    await applyStepResult(ctx, step, owner, result);
  } catch (err) {
    await onStepError(ctx, step, owner, err);
  } finally {
    // Every path ends here. The reconciler decides what moves next, including after a
    // failure — which is why no error path in this phase needs bespoke repair logic.
    await reconcile(ctx, step.runId);
  }
}

export class NoHandlerError extends Error {
  readonly retryable = false;
  constructor(readonly kind: string) {
    super(`no handler registered for step kind "${kind}"`);
    this.name = 'NoHandlerError';
  }
}

/**
 * Record a handler's outcome.
 *
 * Every write is predicated on `lease_owner = $owner`. A worker whose lease was stolen while
 * it worked must not be able to overwrite the state of the worker that now owns the step —
 * the heartbeat aborts it, but the abort races with a handler that was about to return.
 */
async function applyStepResult(
  ctx: EngineContext,
  step: RunStepRow,
  owner: string,
  result: StepResult,
): Promise<void> {
  const now = ctx.clock.now();

  if (result.state === 'no_slot') {
    // Not a fault: no event, no attempt increment, no error recorded. Just try later.
    await ctx.db
      .update(runSteps)
      .set({
        state: 'pending',
        pollAfter: result.retryAfter,
        leaseOwner: null,
        heartbeatAt: null,
      })
      .where(and(eq(runSteps.id, step.id), eq(runSteps.leaseOwner, owner)));
    return;
  }

  if (result.state === 'awaiting_external') {
    await ctx.db
      .update(runSteps)
      .set({
        state: 'awaiting_external',
        // Never cleared once set: its presence is the guard that stops a retried submit from
        // double-billing a provider.
        ...(result.externalRef !== undefined ? { externalRef: result.externalRef } : {}),
        ...(result.pollAfter !== undefined ? { pollAfter: result.pollAfter } : {}),
        ...(result.deadlineAt !== undefined ? { deadlineAt: result.deadlineAt } : {}),
        ...(result.output !== undefined ? { output: result.output } : {}),
        leaseOwner: null,
        heartbeatAt: null,
      })
      .where(and(eq(runSteps.id, step.id), eq(runSteps.leaseOwner, owner)));
    return;
  }

  await ctx.db
    .update(runSteps)
    .set({
      state: result.state,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.state === 'done' && result.costUsd !== undefined
        ? { costUsd: result.costUsd }
        : {}),
      finishedAt: now,
      leaseOwner: null,
      heartbeatAt: null,
      pollAfter: null,
    })
    .where(and(eq(runSteps.id, step.id), eq(runSteps.leaseOwner, owner)));
}

/**
 * Decide what a thrown error means for this step, and record it where someone can read it.
 *
 * The retry goes back to **`pending`, not `ready`**: the reconciler owns promotion and
 * `poll_after` becomes the `startAfter` on the resulting send. One promotion path, one send
 * path, and a backoff that is visible in the table rather than held in a sleeping process.
 */
async function onStepError(
  ctx: EngineContext,
  step: RunStepRow,
  owner: string,
  err: unknown,
): Promise<void> {
  /**
   * The step belongs to another worker now. Writing anything — even the error — would stamp
   * on state that is no longer ours, and the worker that holds the lease is presumably
   * getting on with it.
   */
  if (err instanceof LeaseLostError) {
    ctx.logger?.warn({ stepId: step.id, kind: step.kind }, 'lease lost; abandoning without writing');
    return;
  }

  const spec = POLICY[step.kind as StepKind];
  const nextAttempt = step.attempt + 1;
  const cancelled = err instanceof AbortedError;
  const retryable = !cancelled && spec !== undefined && isRetryable(err) && nextAttempt < spec.maxAttempts;
  const error = serialiseError(err);

  const state = retryable
    ? 'pending'
    : cancelled
      ? 'cancelled'
      : step.optional
        ? 'skipped'
        : 'dead';

  const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
  const pollAfter =
    retryable && spec
      ? new Date(
          ctx.clock.now().getTime() +
            backoffMs(spec, step.attempt, typeof retryAfterMs === 'number' ? retryAfterMs : undefined),
        )
      : null;

  await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(runSteps)
      .set({
        state,
        attempt: nextAttempt,
        leaseOwner: null,
        heartbeatAt: null,
        pollAfter,
        error,
        finishedAt: retryable ? null : ctx.clock.now(),
      })
      .where(and(eq(runSteps.id, step.id), eq(runSteps.leaseOwner, owner)))
      .returning({ id: runSteps.id });

    // Lease taken between the throw and this write. Say nothing; the new owner is authoritative.
    if (updated.length === 0) return;

    await insertAndNotify(tx, {
      runId: step.runId,
      kind: retryable ? 'step.retrying' : state === 'skipped' ? 'step.skipped' : 'step.dead',
      data: {
        stepId: step.id,
        kind: step.kind,
        shard: step.shard,
        attempt: nextAttempt,
        maxAttempts: step.maxAttempts,
        error,
      },
    });
  });
}

/**
 * Raw SQL returns snake_case; the rest of the engine speaks Drizzle's camelCase.
 *
 * `returning *` is used rather than a column list so the handler sees the whole row, which
 * means this conversion has to exist somewhere. Here, once, rather than in fifteen handlers.
 */
function normaliseRow(row: Record<string, unknown>): RunStepRow {
  const camel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    camel[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return camel as unknown as RunStepRow;
}
