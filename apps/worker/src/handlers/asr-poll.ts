import {
  AbortedError,
  NonRetryableError,
  NotConfiguredError,
  ProviderError,
  loadOperation,
  recordBatchProgress,
  type BatchStatus,
  type StepHandler,
} from '@thibi/engine';
import { openStep, type HandlerDeps } from './shared.js';

/**
 * How long we are willing to wait on an operation that never resolves.
 *
 * A two-sided deadline. Google's own LRO expiry is one side; without this second one, a
 * provider that answers `running` forever leaves a step polling until the heat death. Anchored
 * on `op.submittedAtMs` rather than on when this step first ran, so a restart cannot extend it.
 */
const DEADLINE_MS = 6 * 60 * 60_000;

/** Capped exponential backoff, keyed off the poll count. Matches `runBatch`'s in-process loop. */
const POLL_MIN_MS = 30_000;
const POLL_MAX_MS = 300_000;

/**
 * `asr.poll` — ask whether Google has finished, and go back to sleep if not.
 *
 * **The only step in the machine that spends most of its life holding no worker slot**, and the
 * reason `awaiting_external` exists. A two-hour `batchRecognize` is two hours of somebody else's
 * computer; a handler that sat in a sleep loop for it would occupy a worker the whole time and
 * lose the operation on the first redeploy. This one polls once, records what it learned, and
 * returns `awaiting_external` with a `poll_after` — the delay is held by pg-boss, and the
 * reconciler rings the next poll when it comes due.
 *
 * That re-ring is new machinery, not just a new handler: until this step existed nothing in
 * `reconcile` ever sent a step that was not `pending` or `ready`, so `awaiting_external` was a
 * state a step could enter and never leave. See the loop in `reconcile.ts` and amendment 98.
 *
 * ## Polling is not retrying
 *
 * `attempt` is reserved for **poll requests that themselves failed**, so `maxAttempts: 8` means
 * "eight consecutive failed poll requests", not "eight polls". The count of polls lives in
 * `output.polls` and is displayed on the timeline: a run showing 47 polls over four hours is
 * informative, a run showing `attempt 47/8` is a bug report. `applyStepResult` writes `output`
 * without touching `attempt`, which is what makes this true rather than aspirational.
 */
export const createAsrPoll =
  (deps: HandlerDeps): StepHandler =>
  async (parent, step, signal) => {
    const { run, ctx } = await openStep(parent, step, signal);

    /**
     * Cancellation is checked before the poll rather than after.
     *
     * The reconciler cannot cancel this step for us — it only kills steps that are `pending` or
     * `ready`, because a step that is waiting on a provider has to observe the request itself.
     * Checking first means a cancel that arrived during a five-minute sleep is honoured on
     * waking rather than one poll later. `runStep` turns `AbortedError` into `cancelled` without
     * consuming a retry.
     */
    if (run.cancelRequestedAt !== null || signal.aborted) {
      throw new AbortedError('cancelled while waiting on the batch operation');
    }

    const stored = await loadOperation(ctx, run.runId);
    const op = stored?.op ?? null;
    if (!op) {
      /**
       * No stored operation, but `asr.batch.submit` is `done` — the crash window between
       * `submitBatch` returning and `persistOperation` committing fired, and there may be an
       * operation at Google that nothing here knows the name of. Not retryable: polling again
       * will find the same absence, and the repair is `thibi runs resume`, which can match the
       * orphan by its input URI.
       */
      throw new NonRetryableError(
        `Run ${run.runId} has no stored batch operation, so there is nothing to poll. ` +
          `\`thibi runs resume ${run.runId}\` searches Google for an operation submitted ` +
          `against this run's staged audio, which is how the lost name is recovered.`,
        { code: 'BATCH_OPERATION_MISSING', runId: run.runId },
      );
    }

    const deadlineMs = op.submittedAtMs + DEADLINE_MS;
    if (ctx.clock.now().getTime() > deadlineMs) {
      throw new NonRetryableError(
        `Batch operation ${op.name} has been running for more than ` +
          `${DEADLINE_MS / 3_600_000} hours; giving up on it. It may still complete at Google — ` +
          `if it has, \`thibi runs resume ${run.runId}\` fetches the result rather than ` +
          `re-submitting and paying again.`,
        { code: 'BATCH_DEADLINE_EXCEEDED', operation: op.name, submittedAtMs: op.submittedAtMs },
      );
    }

    const built = await deps.providerFor(ctx, run);
    if (!built.provider.pollBatch) {
      throw new NotConfiguredError(
        `Provider ${built.provider.id} has no batch surface, but run ${run.runId} has a batch ` +
          `operation to poll.`,
      );
    }

    // The whole `BatchOp`, not the name. Passing the name alone loses `region`, and Speech v2
    // is regional: polling the wrong regional host 404s in a way that reads like "the operation
    // is gone" rather than "you asked the wrong server".
    const status = await built.provider.pollBatch(built.config, op);
    const polls = pollCount(step.output) + 1;

    if (status.state === 'running') {
      const nextMs = Math.min(POLL_MAX_MS, POLL_MIN_MS * 2 ** Math.min(polls - 1, 4));
      ctx.logger.info(
        { operation: op.name, polls, progressPercent: status.progressPercent },
        'asr: batch still running',
      );
      return {
        state: 'awaiting_external',
        // Never cleared once set; it is what an operator reads off `/admin/queue` to check an
        // operation by hand, and what makes an abandoned step traceable to a real spend.
        externalRef: op.name,
        pollAfter: new Date(ctx.clock.now().getTime() + jitter(nextMs)),
        deadlineAt: new Date(deadlineMs),
        output: { ...(step.output ?? {}), polls, progress: progressOf(status) },
      };
    }

    /**
     * Branch on `state`, never on `done`.
     *
     * An operation can report itself finished with a per-file error and no operation-level
     * error — spike S3 measured it at 1 run in 5 — so `classifyOperation` collapses both into
     * `state: 'failed'` with `error.scope` saying which happened. `retryable` says whether
     * re-submitting is worth anything: code 13 yes, code 8 no.
     *
     * **Thrown non-retryably even when the failure is the retryable kind**, which looks wrong
     * and is not. `status.retryable` means *re-submitting* would be worth something, and this
     * step does not submit: `asr.batch.submit` is already `done` with the failed operation
     * persisted beside it, so eight more polls would ask the same question and get the same
     * answer eight times, over forty minutes of backoff. Re-submitting means clearing the
     * stored `BatchOp` and re-planning two steps, which this phase has no mechanism for — so
     * the flag travels into the message where an operator can act on it, and the run fails
     * honestly rather than pretending to be working. Recorded as debt.
     */
    if (status.state === 'failed') {
      const detail = status.error?.message ?? 'unknown';
      const scope = status.error?.scope ?? 'operation';
      throw new ProviderError(
        (scope === 'file'
          ? `The operation completed but the file failed: ${detail}. (Spike S3 measured this ` +
            `at 1 run in 5, transient and unbilled.)`
          : `The batch operation failed: ${detail}`) +
          (status.retryable === true
            ? ` Re-submitting is worth trying: start the job again with \`thibi runs start\`.`
            : ''),
        status.error?.code,
        { hint: `Operation ${op.name}, scope=${scope}.` },
      );
    }

    /**
     * Everything the poll learned goes into `runs.pipeline.batch`, merged rather than assigned.
     *
     * `asr.fetch` runs in a different process and needs `outputUri` and `status` to read the
     * result; `latencyMs` is on every run from day one because risk 2 asks for it. Written here
     * rather than only on the step's `output` so `thibi runs show` and the resume path find it
     * where every other batch fact already lives.
     */
    const doneAtMs = status.doneAtMs ?? ctx.clock.now().getTime();
    await recordBatchProgress(ctx, run.runId, {
      polls,
      doneAtMs,
      latencyMs: doneAtMs - op.submittedAtMs,
      ...(status.totalBilledDuration !== undefined
        ? { totalBilledDuration: status.totalBilledDuration }
        : {}),
      ...(status.outputUri !== undefined ? { outputUri: status.outputUri } : {}),
    });

    ctx.logger.info(
      { operation: op.name, polls, latencyMs: doneAtMs - op.submittedAtMs },
      'asr: batch complete',
    );

    return {
      state: 'done',
      output: {
        ...(step.output ?? {}),
        polls,
        progress: 1,
        ...(status.outputUri !== undefined ? { outputUri: status.outputUri } : {}),
      },
    };
  };

/** `output.polls` from the previous attempt, defended against a hand-edited row. */
function pollCount(output: Record<string, unknown> | null): number {
  const polls = (output as { polls?: unknown } | null)?.polls;
  return typeof polls === 'number' && Number.isFinite(polls) && polls >= 0 ? polls : 0;
}

/**
 * A percentage, divided to a fraction.
 *
 * The plan's sketch had `op.progressPercent ?? 0.2`, which mixes units — a live run would show
 * 2600% progress on the timeline. It *is* populated: measured 26/52/78 across thirteen polls on
 * a 20-minute file, which retired the Phase 2 risk that assumed it might always be absent. The
 * fallback is for a provider that omits it, and it is never fabricated upward.
 */
function progressOf(status: BatchStatus): number {
  return status.progressPercent !== undefined ? status.progressPercent / 100 : 0.2;
}

/**
 * Full jitter on the ceiling, for the same reason `retry.ts` uses it: several batch runs
 * submitted together must not settle into polling in lockstep.
 */
function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random() / 2));
}
