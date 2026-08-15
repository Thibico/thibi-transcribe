import { sql } from 'drizzle-orm';
import type { EngineContext } from '../context.js';
import { USER_FACING } from '../errors.js';
import { materialisePlan, planRun, type PipelineSpec } from './plan.js';

/**
 * Create a run and the DAG that will execute it.
 *
 * The missing half of Phase 9 until now: the machinery could plan, promote, claim, lease and
 * recover, and nothing anywhere called `materialisePlan`, so no step ever existed to be picked
 * up. A worker with every handler in the world still transcribes nothing without this.
 *
 * **One transaction, and the spec is written before the steps.** `runs.pipeline` is what every
 * handler reads to find out what this run was meant to be — `plan.chunks` re-plans from it,
 * `asr.chunk` takes the provider from it — so a step that became visible before the spec did
 * would fail on a run that was about to be perfectly valid.
 *
 * **The DAG is planned in two stages, and this is the first.** Nothing knows how many chunks a
 * recording has until `plan.chunks` has run, so this pass stops there and the `plan.chunks`
 * handler calls `planRun` again with the real count, in the transaction that writes
 * `run_chunks`. The convergent insert makes the second call an extension of this one rather
 * than a correction of it, which is why there is no repair path and no special case.
 *
 * It does **not** ring the doorbell. `reconcile` is the only caller of `sendStep`, and the
 * caller of this function reconciles immediately afterwards; if it dies before doing so, the
 * worker's 30-second tick finds the run and promotes it anyway. That is the same self-healing
 * property every other write in this phase has, and it is why nothing here needs to be
 * transactional with a queue.
 */

export class JobNotStartableError extends Error {
  readonly [USER_FACING] = true as const;
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'JobNotStartableError';
  }
}

export interface StartRunInput {
  jobId: string;
  providerId: string;
  model: string;
  /** The spec. `asr.mode` decides the DAG's shape, so it is settled here and not re-decided. */
  spec: PipelineSpec;
  /**
   * Point the job at this run.
   *
   * Default true. False is for a re-transcription being trialled against a better provider: the
   * job keeps presenting the transcript a human may already have corrected until somebody
   * promotes the new one.
   */
  promote?: boolean;
}

export interface StartRunResult {
  runId: string;
  languageCode: string;
  steps: number;
}

export async function startRun(
  ctx: EngineContext,
  input: StartRunInput,
): Promise<StartRunResult> {
  const { rows } = await ctx.db.execute<{ id: string; language_code: string }>(sql`
    select id, language_code from jobs where id = ${input.jobId}::uuid
  `);
  const job = rows[0];
  if (!job) {
    throw new JobNotStartableError(`No job ${input.jobId}.`, 'List them with `thibi runs show`.');
  }

  /**
   * `null`, not `0`: the chunk count is unknown, which is a different statement from "there are
   * no chunks". Passing `0` planned `normalize.text` with a wildcard dependency that resolved to
   * an empty array, so it had no dependencies, so the reconciler promoted it immediately and a
   * worker wrote an empty transcript before the first chunk was cut. See `planRun`.
   */
  const specs = planRun(input.spec, null);
  let runId = '';

  await ctx.db.transaction(async (tx) => {
    const created = await tx.execute<{ id: string }>(sql`
      insert into runs
        (job_id, provider_id, model, language_code, mode, engine_version, pipeline, started_at)
      values (${input.jobId}::uuid, ${input.providerId}, ${input.model}, ${job.language_code},
              ${input.spec.asr.mode}, ${ctx.engineVersion},
              ${JSON.stringify(input.spec)}::jsonb, now())
      returning id
    `);
    runId = created.rows[0]!.id;

    await materialisePlan(tx, runId, specs);

    /**
     * `status = 'running'` here rather than at the first step.
     *
     * A job that has been started and has not yet been picked up is not `pending` — pending is
     * what it was before somebody pressed the button, and conflating the two makes "why is
     * nothing happening" unanswerable from the jobs list. `reconcile` writes the terminal
     * status when the run ends.
     */
    await tx.execute(sql`
      update jobs
      set    status = 'running',
             updated_at = now()
             ${input.promote === false ? sql`` : sql`, primary_run_id = ${runId}::uuid`}
      where  id = ${input.jobId}::uuid
    `);
  });

  return { runId, languageCode: job.language_code, steps: specs.length };
}
