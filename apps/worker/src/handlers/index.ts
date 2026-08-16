import type { HandlerRegistry } from '@thibi/engine';
import { createAsrBatchSubmit } from './asr-batch-submit.js';
import { createAsrChunk } from './asr-chunk.js';
import { createAsrFetch } from './asr-fetch.js';
import { createAsrPoll } from './asr-poll.js';
import { createDiarize } from './diarize.js';
import { createDiarizePoll } from './diarize-poll.js';
import { mediaNormalize } from './media-normalize.js';
import { mediaProbe } from './media-probe.js';
import { normalizeText } from './normalize-text.js';
import { createPlanChunks } from './plan-chunks.js';
import { reconcileSpeakers } from './reconcile-speakers.js';
import { stagingCleanup } from './staging-cleanup.js';
import { defaultDeps, type HandlerDeps } from './shared.js';

/**
 * One handler per step kind, each a thin wrapper over a Phase 1–8 stage function.
 *
 * A handler receives `(ctx, step, signal)` and returns a `StepResult`. It never touches
 * pg-boss, never calls `reconcile`, and never decides its own retry — those belong to the
 * doorbell, the reconciler and `runStep` respectively, and mixing them is how a step ends up
 * retried by two mechanisms that disagree about how many times it has run. An ESLint rule on
 * `handlers/**` enforces it, and `tests/lint-rules.test.ts` watches the rule.
 *
 * **The twelve below are a complete chunked run, a complete batch run, and speaker
 * attribution on either.** The kinds still absent — `media.peaks`, `editorial.pass`, `export`
 * — are absent on purpose rather than forgotten: a step routed to a kind with no handler lands
 * `dead` naming the kind, which is the right answer for a worker built before that kind
 * existed, and an `optional: true` kind lands `skipped` and does not fail the run. `thibi runs
 * start` plans none of them today, so the gap is visible in the plan rather than only at
 * execution time.
 */
export function createHandlerRegistry(deps: HandlerDeps = defaultDeps()): HandlerRegistry {
  return {
    'media.probe': mediaProbe,
    'media.normalize': mediaNormalize,
    'plan.chunks': createPlanChunks(deps),
    'asr.chunk': createAsrChunk(deps),
    'asr.batch.submit': createAsrBatchSubmit(deps),
    'asr.poll': createAsrPoll(deps),
    'asr.fetch': createAsrFetch(deps),
    'staging.cleanup': stagingCleanup,
    'normalize.text': normalizeText,
    diarize: createDiarize(deps),
    'diarize.poll': createDiarizePoll(deps),
    'reconcile.speakers': reconcileSpeakers,
  };
}

export { defaultDeps, type HandlerDeps } from './shared.js';
