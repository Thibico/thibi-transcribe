import {
  clearStagingPrefix,
  loadOperation,
  stagingPrefixFor,
  type StepHandler,
} from '@thibi/engine';
import { openStep } from './shared.js';

/**
 * `staging.cleanup` — delete the copy of the audio that lived in someone else's bucket.
 *
 * Optional, and the last step of a batch run. Staging is a **wire format**: bytes leave our
 * storage, sit in GCS for the length of one operation because that is where Google can read
 * from, and are swept. The bucket's lifecycle rule is the backstop — `ensureStageable` refuses
 * a bucket without one — so a failure here costs a few days of storage on one FLAC rather than
 * an unbounded leak, which is exactly why it is `optional: true` and must never fail a run
 * whose transcript is already written.
 *
 * **It sweeps the staging bucket and nothing in our own object store.** The distinction is
 * load-bearing rather than pedantic: `staging.cleanup` and `normalize.text` both depend on
 * `asr.fetch` and are therefore siblings that can run at the same time, so a version of this
 * step that also deleted `runs/{id}/results/0.json` would occasionally delete the artifact
 * `normalize.text` was about to read — a race that would show up as an empty transcript on
 * about one run in however many, which is the worst failure rate to debug. Sweeping the chunk
 * artifacts needs a step that depends on `normalize.text`, and that step does not exist yet.
 */
export const stagingCleanup: StepHandler = async (parent, step, signal) => {
  const { run, ctx } = await openStep(parent, step, signal);

  const staging = ctx.staging;
  if (!staging) {
    // Nothing was staged, so there is nothing to sweep. `skipped` rather than `done`: this run
    // did not do the work, and a `done` here would claim it had.
    ctx.logger.info({}, 'staging: no bucket configured; nothing to sweep');
    return { state: 'skipped', output: { reason: 'no-staging' } };
  }

  /**
   * The prefix from the run row, falling back to the derived one.
   *
   * `claimStagingPrefix` writes it before the upload, so the column is normally set. The
   * fallback matters for the run that crashed between the claim and its commit: the prefix is
   * derived from `runId` and is therefore byte-identical across restarts, which is the same
   * property that lets `resumeBatchRun` find an orphaned operation by its input URI.
   */
  const stored = await loadOperation(ctx, run.runId);
  const prefix = stored?.stagingPrefix ?? stagingPrefixFor(run.runId);

  const { deleted } = await staging.deletePrefix(prefix);
  await clearStagingPrefix(ctx, run.runId);

  ctx.logger.info({ prefix, deleted }, 'staging: swept');
  return { state: 'done', output: { prefix, deleted } };
};
