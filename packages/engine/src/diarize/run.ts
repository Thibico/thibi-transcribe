/**
 * The `diarize` stage: submit, poll, reconcile, persist.
 *
 * This is the only place the three halves of Phase 3 meet, and the shape of it is dictated
 * by one invariant from the phase plan §6: **diarization must never gate the transcript.**
 * ASR finishes a one-hour file in about a minute; pyannote takes about an hour and forty
 * minutes. So this runs *after* the transcript is already persisted and readable, against
 * the rows it left behind, and a failure here downgrades the speaker labels rather than the
 * run.
 *
 * `run_steps` does not exist until Phase 9, so the idempotency key is derived from the run
 * id rather than read from a step row. That is deliberate and not a placeholder: the key has
 * to be reconstructible without having stored the submit response, which is exactly what
 * `diarizeStepKey` is.
 */
import { AbortedError, ProviderError } from '../errors.js';
import type { EngineContext } from '../context.js';
import { DiarizerBusyError } from './pyannote.js';
import { loadReconcileInput, persistDiarization, persistDiarizationFailure } from './persist.js';
import { reconcile, type ReconcileOptions, type ReconcileResult } from './reconcile.js';
import type {
  DiarizationCapabilities,
  DiarizationResult,
  DiarizeHandle,
  DiarizeRequest,
  DiarizeStatus,
} from './types.js';
import type { PersistDiarizationOutput } from './persist.js';

export interface DiarizationSource {
  readonly id: string;
  readonly label: string;
  capabilities(): DiarizationCapabilities;
  submit(ctx: EngineContext, req: DiarizeRequest): Promise<DiarizeHandle>;
  poll(ctx: EngineContext, h: DiarizeHandle): Promise<DiarizeStatus>;
  fetch(ctx: EngineContext, h: DiarizeHandle): Promise<DiarizationResult>;
  cancel?(ctx: EngineContext, h: DiarizeHandle): Promise<void>;
}

/** 15 s, as the plan's two-sided deadline specifies. */
export const DIARIZE_POLL_INTERVAL_MS = 15_000;

/**
 * `max(10 min, 12 × duration)`.
 *
 * Twelve times realtime is roughly three times the worst CPU factor S6 measured (0.56×).
 * Generous on purpose: the alternative to a generous deadline is killing a job at hour six,
 * having already paid for all of it.
 */
export function deadlineForDuration(durationMs: number): number {
  return Math.max(10 * 60_000, 12 * durationMs);
}

/**
 * The idempotency key, and therefore `task_id = uuid5(NAMESPACE_URL, key)`.
 *
 * One diarization per run, so the run id determines it. A resubmit after a lost response
 * lands on the same task rather than starting a second one — which on a three-hour file is
 * the difference between waiting five hours and waiting ten.
 */
export function diarizeStepKey(runId: string): string {
  return `${runId}:diarize`;
}

export interface RunDiarizationInput {
  runId: string;
  jobId: string;
  source: DiarizationSource;
  audio: { key: string; durationMs: number };
  hints?: { numSpeakers?: number; minSpeakers?: number; maxSpeakers?: number };
  options?: ReconcileOptions;
  /** Overridden only by tests; production polls every 15 s. */
  pollIntervalMs?: number;
  onProgress?: (status: DiarizeStatus, elapsedMs: number) => void;
}

export type RunDiarizationOutcome =
  | {
      kind: 'done';
      result: DiarizationResult;
      reconciled: ReconcileResult;
      persisted: PersistDiarizationOutput;
      elapsedMs: number;
    }
  | { kind: 'failed'; code: string; message: string; diarizationRunId: string }
  | { kind: 'cancelled'; diarizationRunId: string };

/**
 * How many times a `lost` task may be resubmitted.
 *
 * One. `lost` means the container ran this and was killed, so it costs a slot and real
 * compute; a crash-looping sidecar that resubmitted forever would occupy the queue
 * indefinitely and never surface a reason. A 429 is *not* an attempt and is not counted
 * here — nothing was tried.
 */
const MAX_LOST_RESUBMITS = 1;

export async function runDiarization(
  ctx: EngineContext,
  input: RunDiarizationInput,
): Promise<RunDiarizationOutcome> {
  const source = input.source;
  const startedAt = ctx.clock.now().getTime();
  const deadlineMs = deadlineForDuration(input.audio.durationMs);
  const pollIntervalMs = input.pollIntervalMs ?? DIARIZE_POLL_INTERVAL_MS;

  const request: DiarizeRequest = {
    runId: input.runId,
    stepId: diarizeStepKey(input.runId),
    audio: { key: input.audio.key, durationMs: input.audio.durationMs },
    hints: input.hints ?? {},
    deadlineMs,
  };

  const fail = async (
    code: string,
    message: string,
    state: 'failed' | 'cancelled' = 'failed',
    taskId?: string,
  ): Promise<RunDiarizationOutcome> => {
    const diarizationRunId = await persistDiarizationFailure(ctx, {
      runId: input.runId,
      jobId: input.jobId,
      source: source.id,
      model: source.id,
      taskId: taskId ?? null,
      state,
      error: { code, message },
      audioDurationMs: input.audio.durationMs,
    });
    return state === 'cancelled'
      ? { kind: 'cancelled', diarizationRunId }
      : { kind: 'failed', code, message, diarizationRunId };
  };

  let handle: DiarizeHandle | undefined;
  let lostResubmits = 0;

  // Submit, tolerating a busy slot indefinitely: a 429 means another key holds the single
  // slot, which is scheduling, not failure. It must never surface to the user as an error.
  for (;;) {
    if (ctx.signal?.aborted) return fail('cancelled', 'aborted before submit', 'cancelled');
    try {
      handle = await source.submit(ctx, request);
      break;
    } catch (err) {
      if (err instanceof DiarizerBusyError) {
        const wait = err.retryAfterMs ?? 60_000;
        ctx.events.emit({
          runId: input.runId,
          kind: 'diarize.busy',
          data: { retryInMs: wait },
        });
        if (ctx.clock.now().getTime() - startedAt > deadlineMs) {
          return fail('deadline_exceeded', 'the diarizer stayed busy past the deadline');
        }
        await ctx.clock.sleep(wait, ctx.signal);
        continue;
      }
      throw err;
    }
  }

  for (;;) {
    if (ctx.signal?.aborted) {
      await source.cancel?.(ctx, handle).catch(() => {});
      return fail('cancelled', 'cancelled by the caller', 'cancelled', handle.taskId);
    }

    const elapsedMs = ctx.clock.now().getTime() - startedAt;
    if (elapsedMs > deadlineMs) {
      // The client always wins this race: the server's own deadline is set 120 s later, so
      // the failure is attributed on our side and the server-side check exists only so a
      // runaway job frees the slot without a container restart.
      await source.cancel?.(ctx, handle).catch(() => {});
      return fail(
        'deadline_exceeded',
        `diarization exceeded its ${Math.round(deadlineMs / 60_000)} minute deadline`,
        'failed',
        handle.taskId,
      );
    }

    const status = await source.poll(ctx, handle);
    input.onProgress?.(status, elapsedMs);
    ctx.events.emit({
      runId: input.runId,
      kind: 'diarize.progress',
      data: { state: status.state, progress: status.progress ?? null, elapsedMs },
    });

    if (status.state === 'succeeded') break;
    if (status.state === 'cancelled') {
      return fail('cancelled', 'the diarizer reported the task cancelled', 'cancelled', handle.taskId);
    }
    if (status.state === 'lost') {
      if (lostResubmits >= MAX_LOST_RESUBMITS) {
        return fail(
          'lost',
          'the sidecar lost this task more than once; it is probably crash-looping',
          'failed',
          handle.taskId,
        );
      }
      lostResubmits += 1;
      ctx.logger.warn({ taskId: handle.taskId }, 'diarize task lost; resubmitting once');
      handle = await source.submit(ctx, request);
      continue;
    }
    if (status.state === 'failed') {
      const code = status.error?.code ?? 'internal';
      return fail(code, status.error?.message ?? 'the diarizer failed', 'failed', handle.taskId);
    }

    await ctx.clock.sleep(pollIntervalMs, ctx.signal).catch((err) => {
      if (err instanceof AbortedError) return;
      throw err;
    });
  }

  const result = await source.fetch(ctx, handle);
  const { segments, words } = await loadReconcileInput(ctx, input.runId);
  if (segments.length === 0) {
    throw new ProviderError(
      `run ${input.runId} has no segments to attribute; diarize runs after the transcript, ` +
        `not instead of it`,
    );
  }

  const reconciled = reconcile(segments, words, result.turns, input.options);
  const persisted = await persistDiarization(ctx, {
    runId: input.runId,
    jobId: input.jobId,
    source: source.id,
    model: result.model,
    params: (result.params as Record<string, unknown> | undefined) ?? {},
    taskId: handle.taskId,
    turns: result.turns,
    reconciled,
    audioDurationMs: result.audioDurationMs ?? input.audio.durationMs,
    computeMs: result.computeMs ?? null,
    realtimeFactor: result.realtimeFactor ?? null,
    ...(input.options ? { options: input.options } : {}),
  });

  return {
    kind: 'done',
    result,
    reconciled,
    persisted,
    elapsedMs: ctx.clock.now().getTime() - startedAt,
  };
}
