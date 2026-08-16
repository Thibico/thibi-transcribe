import {
  loadDiarizeHandle,
  loadReconcileInput,
  persistDiarization,
  readDiarizationResult,
  reconcile,
  type StepHandler,
} from '@thibi/engine';
import { openStep } from './shared.js';

/**
 * `reconcile.speakers` — decide who said each word, and give the speakers durable names.
 *
 * **The only step in the DAG that depends on both branches of it.** `planRun` gives it the ASR
 * leaves *and* `diarize.poll`, and that is the whole reason it exists as a separate step rather
 * than as the tail of `diarize.poll`: attribution needs the turns and the words, the two arrive
 * from different providers on wildly different timescales — about a minute of ASR against three
 * hours of pyannote on this box — and neither branch may wait on the other. The join is here.
 *
 * Three things happen, and they are one decision each about the whole timeline:
 *
 *  1. **Reconcile.** The word↔turn algorithm from Phase 3, the hardest correctness problem in
 *     the product. It is `reconcile` from `diarize/`, not `reconcileRun` from `queue/` — the
 *     package exports both and they are unrelated.
 *  2. **Identity.** `persistDiarization` matches this run's anonymous `SPEAKER_00` labels
 *     against speakers already known to the *job*, including attribution a human corrected by
 *     hand, so a rename survives a re-diarization instead of being orphaned by it.
 *  3. **Persist.** Turns, speakers, and the segment and word attribution, in one transaction.
 *
 * It is `optional: true`, so a failure downgrades the speaker labels rather than the run — the
 * phase-3 invariant that diarization must never gate the transcript, stated once more as a DAG
 * property. A run that reaches here with a dead `diarize` produces a transcript with no
 * speakers, which is what the product should do.
 */
export const reconcileSpeakers: StepHandler = async (parent, step, signal) => {
  const { run, ctx } = await openStep(parent, step, signal);

  /**
   * No turns, so nothing to attribute.
   *
   * Reached when `diarize` skipped for want of a sidecar, and — because a `skipped` dependency
   * satisfies its dependents just as a `done` one does — this step is promoted anyway. That is
   * the right behaviour for an optional branch and it means the absence has to be handled here
   * rather than assumed away.
   */
  const result = await readDiarizationResult(ctx, run.runId);
  if (!result) {
    ctx.logger.info({}, 'reconcile.speakers: no diarization result; nothing to attribute');
    return { state: 'skipped', output: { reason: 'no-diarization' } };
  }

  /**
   * Segments, not chunks. A run with none has no transcript to attribute speakers to, which
   * means `normalize.text` has not run — and this step depends on the ASR leaves rather than on
   * `normalize.text` itself, so on a chunked run the two are siblings and can race.
   *
   * `skipped` rather than an error, because it is a scheduling outcome and not a fault: the
   * next reconcile tick promotes nothing new, but the run is not damaged and the transcript is
   * still on its way. Recorded as debt — the honest fix is for `planRun` to depend this step on
   * `normalize.text` instead of on the ASR leaves, which is a planner change rather than a
   * handler one.
   */
  const { segments, words } = await loadReconcileInput(ctx, run.runId);
  if (segments.length === 0) {
    ctx.logger.warn(
      {},
      'reconcile.speakers: no segments yet; diarize runs after the transcript, not instead of it',
    );
    return { state: 'skipped', output: { reason: 'no-segments' } };
  }

  const handle = await loadDiarizeHandle(ctx, run.runId);
  const reconciled = reconcile(segments, words, result.turns);

  const persisted = await persistDiarization(ctx, {
    runId: run.runId,
    jobId: run.jobId,
    source: handle?.sourceId ?? 'pyannote',
    model: result.model,
    params: (result.params as Record<string, unknown> | undefined) ?? {},
    taskId: handle?.taskId ?? null,
    turns: result.turns,
    reconciled,
    audioDurationMs: result.audioDurationMs ?? run.asset.durationMs,
    computeMs: result.computeMs ?? null,
    realtimeFactor: result.realtimeFactor ?? null,
  });

  ctx.logger.info(
    {
      speakers: persisted.speakers.length,
      turns: persisted.turnsInserted,
      segments: persisted.segmentsUpdated,
      words: persisted.wordsUpdated,
      carriedOver: persisted.speakers.filter((s) => !s.isNew).length,
    },
    'reconcile.speakers: attributed',
  );

  return {
    state: 'done',
    output: {
      speakers: persisted.speakers.length,
      turnsInserted: persisted.turnsInserted,
      segmentsUpdated: persisted.segmentsUpdated,
      wordsUpdated: persisted.wordsUpdated,
      unmatchedPriorKeys: persisted.unmatchedPriorKeys.length,
    },
  };
};
