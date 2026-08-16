import {
  AbortedError,
  NonRetryableError,
  ProviderError,
  deadlineForDuration,
  diarizeAudioForRun,
  diarizeStepKey,
  loadDiarizeHandle,
  persistDiarizationFailure,
  persistDiarizeHandle,
  recordDiarizeProgress,
  writeDiarizationResult,
  type DiarizeRequest,
  type StepHandler,
} from '@thibi/engine';
import { openStep, type HandlerDeps } from './shared.js';

/**
 * How often to ask. 15 s, as §7's two-sided deadline specifies.
 *
 * Flat rather than backing off, unlike `asr.poll`. The difference is who is on the other end:
 * `batchRecognize` is a per-project quota shared with the sync path, so a backoff there is
 * politeness that has a price attached. The sidecar is ours, on the same compose network, and
 * a status call costs nothing — so the useful property is a progress bar that moves.
 */
const POLL_INTERVAL_MS = 15_000;

/**
 * How many times a `lost` task may be resubmitted. One.
 *
 * `lost` means the container ran this and was killed, so it has already cost a GPU slot and
 * real compute. A crash-looping sidecar that resubmitted forever would occupy the single slot
 * indefinitely and never surface a reason. A 429 is *not* an attempt and is not counted here —
 * nothing was tried. Carried in `runs.pipeline.diarize.lostResubmits` rather than in the step's
 * `attempt`, for the same reason polls are: neither is a failure of this step.
 */
const MAX_LOST_RESUBMITS = 1;

/**
 * `diarize.poll` — wait on the GPU without occupying a worker.
 *
 * The sidecar's half of the pattern `asr.poll` established. Poll once, record what was learned,
 * return `awaiting_external` with a `poll_after`; the reconciler rings the next poll when it
 * comes due. On a one-hour interview this step is alive for three hours and holds a worker slot
 * for perhaps four seconds of it.
 *
 * **It fetches as well as polls.** `asr.fetch` is a separate step because reading a
 * `batchRecognize` output is a bucket listing plus a JSON parse of unbounded size against a
 * provider that charges for the operation; the sidecar hands back its result on one call to a
 * service on the same network. A fourth step for it would be a queue round trip to save
 * nothing. The result goes to object storage, because `reconcile.speakers` — which needs the
 * *words* too — may not run for a long time afterwards.
 */
export const createDiarizePoll =
  (deps: HandlerDeps): StepHandler =>
  async (parent, step, signal) => {
    const { run, ctx } = await openStep(parent, step, signal);

    const source = deps.diarizerFor(ctx);
    if (!source) {
      ctx.logger.info({}, 'diarize: no diarizer configured; nothing to poll');
      return { state: 'skipped', output: { reason: 'no-diarizer' } };
    }

    /**
     * Cancellation before the poll rather than after, so a cancel that arrived during a
     * fifteen-second sleep is honoured on waking. The reconciler cannot cancel this step for
     * us — it only kills `pending` and `ready` steps, because a step waiting on someone else's
     * computer has to observe the request itself, and here it can also tell the sidecar.
     */
    if (run.cancelRequestedAt !== null || signal.aborted) {
      const stored = await loadDiarizeHandle(ctx, run.runId);
      if (stored) await source.cancel?.(ctx, stored).catch(() => {});
      throw new AbortedError('cancelled while waiting on the diarizer');
    }

    let handle = await loadDiarizeHandle(ctx, run.runId);
    if (!handle) {
      /**
       * `diarize` is `done` but no handle was stored, so the crash window between the sidecar
       * accepting the task and Postgres learning its id fired. Not retryable: polling again
       * finds the same absence. Unlike the batch equivalent this is cheap to repair — the task
       * id is derived from the run id, so re-running `diarize` lands on the same task.
       */
      throw new NonRetryableError(
        `Run ${run.runId} has no stored diarization handle, so there is nothing to poll. The ` +
          `sidecar task id is derived from the run id, so re-running the diarize step will ` +
          `find the existing task rather than starting a second one.`,
        { code: 'DIARIZE_HANDLE_MISSING', runId: run.runId },
      );
    }

    const audio = await diarizeAudioForRun(ctx, run.runId);
    const deadlineAtMs = handle.submittedAtMs + deadlineForDuration(audio.durationMs);
    if (ctx.clock.now().getTime() > deadlineAtMs) {
      /**
       * The client always wins this race. The sidecar's own deadline is set 120 s later, so a
       * timeout is attributed on our side; the server-side check exists only so a runaway job
       * frees the slot without a container restart.
       */
      await source.cancel?.(ctx, handle).catch(() => {});
      await persistDiarizationFailure(ctx, {
        runId: run.runId,
        jobId: run.jobId,
        source: source.id,
        model: source.id,
        taskId: handle.taskId,
        state: 'failed',
        error: { code: 'deadline_exceeded', message: 'diarization exceeded its deadline' },
        audioDurationMs: audio.durationMs,
      });
      throw new NonRetryableError(
        `Diarization of run ${run.runId} exceeded its ` +
          `${Math.round(deadlineForDuration(audio.durationMs) / 60_000)} minute deadline.`,
        { code: 'DIARIZE_DEADLINE_EXCEEDED', taskId: handle.taskId },
      );
    }

    const status = await source.poll(ctx, handle);
    const polls = (handle.polls ?? 0) + 1;

    await ctx.events.emit({
      runId: run.runId,
      kind: 'diarize.progress',
      data: {
        state: status.state,
        progress: status.progress ?? null,
        elapsedMs: ctx.clock.now().getTime() - handle.submittedAtMs,
      },
    });

    /**
     * A lost task was run and killed, so resubmitting costs the slot again — once, and then
     * the run is told the sidecar is probably crash-looping rather than being kept waiting on
     * a task that keeps evaporating.
     */
    if (status.state === 'lost') {
      const lostResubmits = handle.lostResubmits ?? 0;
      if (lostResubmits >= MAX_LOST_RESUBMITS) {
        await persistDiarizationFailure(ctx, {
          runId: run.runId,
          jobId: run.jobId,
          source: source.id,
          model: source.id,
          taskId: handle.taskId,
          state: 'failed',
          error: {
            code: 'lost',
            message: 'the sidecar lost this task more than once; it is probably crash-looping',
          },
          audioDurationMs: audio.durationMs,
        });
        throw new NonRetryableError(
          `The sidecar lost the diarization of run ${run.runId} more than once; it is probably ` +
            `crash-looping. Check the container's logs rather than resubmitting.`,
          { code: 'DIARIZE_LOST', taskId: handle.taskId },
        );
      }

      ctx.logger.warn({ taskId: handle.taskId }, 'diarize: task lost; resubmitting once');
      const request: DiarizeRequest = {
        runId: run.runId,
        stepId: diarizeStepKey(run.runId),
        audio: { key: audio.key, durationMs: audio.durationMs },
        hints: {},
        deadlineMs: deadlineForDuration(audio.durationMs),
      };
      handle = { ...(await source.submit(ctx, request)), lostResubmits: lostResubmits + 1, polls };
      await persistDiarizeHandle(ctx, run.runId, handle);
      return {
        state: 'awaiting_external',
        externalRef: handle.taskId,
        pollAfter: new Date(ctx.clock.now().getTime() + POLL_INTERVAL_MS),
        deadlineAt: new Date(deadlineAtMs),
        output: { ...(step.output ?? {}), polls, lostResubmits: lostResubmits + 1 },
      };
    }

    if (status.state === 'cancelled') {
      await persistDiarizationFailure(ctx, {
        runId: run.runId,
        jobId: run.jobId,
        source: source.id,
        model: source.id,
        taskId: handle.taskId,
        state: 'cancelled',
        error: { code: 'cancelled', message: 'the diarizer reported the task cancelled' },
        audioDurationMs: audio.durationMs,
      });
      throw new AbortedError('the diarizer reported the task cancelled');
    }

    if (status.state === 'failed') {
      const code = status.error?.code ?? 'internal';
      await persistDiarizationFailure(ctx, {
        runId: run.runId,
        jobId: run.jobId,
        source: source.id,
        model: source.id,
        taskId: handle.taskId,
        state: 'failed',
        error: { code, message: status.error?.message ?? 'the diarizer failed' },
        audioDurationMs: audio.durationMs,
      });
      throw new ProviderError(status.error?.message ?? 'the diarizer failed', undefined, {
        hint: `Sidecar task ${handle.taskId}, code ${code}.`,
      });
    }

    if (status.state !== 'succeeded') {
      await recordDiarizeProgress(ctx, run.runId, { polls });
      // Logged per poll, as `asr.poll` does. Without it a three-hour diarization writes one
      // line at submit and the next when it finishes, and the operator's only way to tell a
      // working run from a wedged one is to query the database.
      ctx.logger.info(
        { taskId: handle.taskId, polls, state: status.state, progress: status.progress },
        'diarize: still running',
      );
      return {
        state: 'awaiting_external',
        externalRef: handle.taskId,
        pollAfter: new Date(ctx.clock.now().getTime() + POLL_INTERVAL_MS),
        deadlineAt: new Date(deadlineAtMs),
        output: {
          ...(step.output ?? {}),
          polls,
          state: status.state,
          // Absent is not zero, and it is never fabricated upward. The sidecar reports a
          // fraction where it can; where it cannot, the step's own 0.1 "started" credit stands.
          ...(status.progress !== undefined ? { progress: status.progress } : {}),
        },
      };
    }

    const result = await source.fetch(ctx, handle);
    await writeDiarizationResult(ctx, run.runId, result);

    const doneAtMs = ctx.clock.now().getTime();
    await recordDiarizeProgress(ctx, run.runId, {
      polls,
      doneAtMs,
      latencyMs: doneAtMs - handle.submittedAtMs,
      numSpeakers: result.numSpeakers,
      ...(result.computeMs !== undefined ? { computeMs: result.computeMs } : {}),
      ...(result.realtimeFactor !== undefined ? { realtimeFactor: result.realtimeFactor } : {}),
    });

    ctx.logger.info(
      {
        taskId: handle.taskId,
        turns: result.turns.length,
        speakers: result.numSpeakers,
        polls,
        realtimeFactor: result.realtimeFactor,
      },
      'diarize: complete',
    );

    return {
      state: 'done',
      output: {
        ...(step.output ?? {}),
        polls,
        progress: 1,
        turns: result.turns.length,
        numSpeakers: result.numSpeakers,
      },
    };
  };
