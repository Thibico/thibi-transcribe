import {
  DiarizerBusyError,
  deadlineForDuration,
  diarizeAudioForRun,
  diarizeStepKey,
  loadDiarizeHandle,
  persistDiarizeHandle,
  type DiarizeRequest,
  type StepHandler,
} from '@thibi/engine';
import { openStep, type HandlerDeps } from './shared.js';

/**
 * `diarize` — hand the recording to the diarizer and write down what it called the task.
 *
 * The third long-async pair in this phase and the second built: `asr.batch.submit` /
 * `asr.poll` against Google, this against the sidecar. The shape is deliberately identical,
 * including the correction §7 needed — **this step ends `done`, not `awaiting_external`** —
 * because `diarize.poll` depends on it and only `done` or `skipped` satisfies a dependency.
 * See `asr-batch-submit.ts` for the full argument; it applies here unchanged.
 *
 * ## It runs beside ASR, not after it
 *
 * `planRun` makes this a dependent of `media.normalize` alone, so it starts the moment the
 * derivative exists and races the ASR shards rather than queueing behind them. That is the
 * phase-3 invariant restated as a DAG edge: **diarization must never gate the transcript.**
 * pyannote is around 0.09x realtime on this box's CPU, so a one-hour interview is three hours
 * of diarization against about a minute of ASR, and a run that waited would show nobody a word
 * for an afternoon. `reconcile.speakers` is where the two meet, and it is the only step that
 * depends on both.
 *
 * ## A busy diarizer is scheduling, not failure
 *
 * The sidecar holds one slot and answers 429 when it is taken. That becomes `no_slot`, which
 * returns the step to `pending` with a short delay and **does not touch `attempt`** — the one
 * `StepResult` variant that exists for exactly this. Getting it wrong would fail a run because
 * two jobs happened to overlap, and `diarize` has only two attempts to spend.
 */
export const createDiarize =
  (deps: HandlerDeps): StepHandler =>
  async (parent, step, signal) => {
    const { run, ctx } = await openStep(parent, step, signal);

    const source = deps.diarizerFor(ctx);
    if (!source) {
      /**
       * No sidecar, so no speaker labels — and that is a deployment choice rather than a
       * fault. `skipped` propagates as satisfying its dependents, so `diarize.poll` and
       * `reconcile.speakers` skip in turn and the run finishes on its transcript alone.
       */
      ctx.logger.info({}, 'diarize: no diarizer configured; skipping');
      return { state: 'skipped', output: { reason: 'no-diarizer' } };
    }

    /**
     * Already submitted. The guard is the persisted handle, for the reason `asr.batch.submit`
     * checks the persisted `BatchOp`: a worker can die between the sidecar accepting the task
     * and this step being marked done, and the reclaimed step must not start a second GPU job.
     *
     * Belt and braces, because `submit` is *also* idempotent on the sidecar's side — the task
     * id is `uuid5(NAMESPACE_URL, "<runId>:diarize")`, so a resubmit lands on the same task
     * rather than a new one. Both are worth having: this one saves the round trip, and the
     * sidecar's covers the window where the handle never reached Postgres.
     */
    const existing = await loadDiarizeHandle(ctx, run.runId);
    if (existing) {
      ctx.logger.info({ taskId: existing.taskId }, 'diarize: already submitted; not re-sending');
      return { state: 'done', output: { taskId: existing.taskId, reused: true } };
    }

    /**
     * The same normalized derivative ASR read, looked up by recipe version.
     *
     * Reconciliation compares word timings against turn timings, and the only thing that makes
     * those comparable is that both were measured on the same bytes on the same timeline. A
     * derivative produced under different ffmpeg parameters is a different timeline, and
     * matching on `kind` alone would silently reconcile against the wrong one.
     */
    const audio = await diarizeAudioForRun(ctx, run.runId);
    if (audio.durationMs <= 0) {
      throw new Error(
        `Run ${run.runId} has no duration on its asset, so the diarizer's deadline cannot be ` +
          `computed. media.probe should have written one.`,
      );
    }

    const hints = (step.input as { hints?: DiarizeRequest['hints'] }).hints ?? {};
    const request: DiarizeRequest = {
      runId: run.runId,
      // The idempotency key, derived from the run id rather than from this step's id: it has
      // to be reconstructible by a process that never saw the submit response.
      stepId: diarizeStepKey(run.runId),
      audio: { key: audio.key, durationMs: audio.durationMs },
      hints,
      deadlineMs: deadlineForDuration(audio.durationMs),
    };

    let handle;
    try {
      handle = await source.submit(ctx, request);
    } catch (err) {
      if (err instanceof DiarizerBusyError) {
        const waitMs = err.retryAfterMs ?? 60_000;
        ctx.logger.info({ waitMs }, 'diarize: the diarizer is busy; requeueing without an attempt');
        await ctx.events.emit({
          runId: run.runId,
          kind: 'diarize.busy',
          data: { retryInMs: waitMs },
        });
        return {
          state: 'no_slot',
          retryAfter: new Date(ctx.clock.now().getTime() + waitMs),
        };
      }
      throw err;
    }

    // Durable before this step is marked done, so a crash in between cannot lose the task id.
    await persistDiarizeHandle(ctx, run.runId, handle);
    await ctx.events.emit({
      runId: run.runId,
      kind: 'diarize.submitted',
      data: { taskId: handle.taskId, source: source.id },
    });

    ctx.logger.info(
      { taskId: handle.taskId, source: source.id, durationMs: audio.durationMs },
      'diarize: submitted [persisted]',
    );

    return {
      state: 'done',
      output: {
        taskId: handle.taskId,
        source: source.id,
        submittedAtMs: handle.submittedAtMs,
        durationMs: audio.durationMs,
      },
    };
  };
