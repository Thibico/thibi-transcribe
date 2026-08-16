import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  createGoogleProvider,
  parseGsUri,
  persistChunks,
  persistResult,
  planMode,
  pollToCompletion,
  recordUsage,
  reconcileRun,
  requestCancel,
  resumeBatchRun,
  stagingPrefixFor,
  startRun,
  DEFAULT_OVERLAP_MS,
  PgBossDoorbell,
  type BatchDeps,
  type GoogleConfig,
  type PipelineSpec,
} from '@thibi/engine';
import { buildProvider } from '@thibi/runtime';
import { buildContext, resolveServiceAccountJson, readEnvironment } from '../context.js';
import { DEFAULT_GOOGLE_MODEL, DEFAULT_GOOGLE_REGION } from '../config.js';
import { EXIT, formatText, buildTranscript, type TranscriptJson } from '../output.js';

const ENGINE_VERSION = '0.1.0';

/**
 * `thibi runs` — inspect and continue runs that already exist.
 *
 * `resume` is the command the crash test in the Phase 2 plan exercises, and the reason the
 * whole operation-name ordering exists. Killing the CLI immediately after `[persisted]` and
 * running `thibi runs resume <id>` must re-poll the *same* operation, never submit a second
 * one: two submissions means paying twice for audio Google has already processed.
 */
export function runsCommand(): Command {
  const command = new Command('runs').description('Inspect and continue transcription runs');

  command
    .command('show')
    .argument('<id>')
    .action(async (id: string) => {
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        if (!cli.db) throw new Error('runs show needs a database.');
        const { rows } = await cli.db.$client.query(
          `select id, mode, state, provider_id, model, language_code, operation_name,
                  staging_prefix, cost_usd, word_timing_quality, pipeline, created_at,
                  finished_at
             from runs where id = $1`,
          [id],
        );
        if (rows.length === 0) {
          process.stderr.write(`No run ${id}.\n`);
          process.exitCode = EXIT.usage;
          return;
        }
        process.stdout.write(`${JSON.stringify(rows[0], null, 2)}\n`);
      } finally {
        await cli.close();
      }
    });

  /**
   * `thibi runs start <jobId>` — hand a job to the queue.
   *
   * The counterpart to `thibi transcribe`, and the difference between them is the whole point
   * of Phase 9. `transcribe` drives every stage in this process: close the laptop and the run
   * dies with it. This creates a run, plans its DAG, rings the doorbell and returns — the work
   * happens in a worker that can be killed and restarted without losing a chunk.
   *
   * It exists as a CLI command before it exists as an HTTP route deliberately. "Kill the worker
   * mid-chunk and watch it resume" is the claim this phase has to prove, and proving it with
   * `docker kill` and a `select` is a great deal more convincing than watching a progress bar.
   */
  command
    .command('start')
    .argument('<jobId>', 'a job from `thibi ingest`')
    .description('Queue a job for the worker: creates a run, plans its DAG, rings the doorbell')
    .option('-p, --provider <id>', 'provider id: google | openai | groq | faster-whisper', 'google')
    .option('-m, --model <id>', 'provider model')
    .option(
      '--mode <mode>',
      'auto | sync | sync_chunked | batch. Decided here and never re-decided: the DAG is ' +
        'planned around it.',
      'auto',
    )
    .option(
      '--overlap-ms <n>',
      'how much earlier each chunk starts, for seam de-duplication. 0 disables the merge.',
      (v) => Number.parseInt(v, 10),
      DEFAULT_OVERLAP_MS,
    )
    .option(
      '--diarize',
      'also plan speaker diarization. Runs beside ASR rather than after it, and is optional: ' +
        'a failure downgrades the speaker labels, never the transcript. Needs SIDECAR_URL on ' +
        'the worker.',
    )
    .option(
      '--speakers <n>',
      'tell the diarizer how many speakers to expect, when you know',
      (v) => Number.parseInt(v, 10),
    )
    .option('--no-ring', 'plan the run but do not ring the doorbell; the 30 s tick will find it')
    .action(async (jobId: string, opts: Record<string, unknown>) => {
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      let doorbell: PgBossDoorbell | null = null;
      try {
        if (!cli.db) throw new Error('runs start needs a database.');

        const asset = await assetForJob(cli, jobId);
        if (!asset) {
          process.stderr.write(`No job ${jobId}.\n`);
          process.exitCode = EXIT.usage;
          return;
        }

        const language = cli.languages.get(asset.languageCode);
        if (!language) {
          process.stderr.write(
            `Job ${jobId} names language '${asset.languageCode}', which is not in the registry.\n`,
          );
          process.exitCode = EXIT.usage;
          return;
        }

        const built = await buildProvider({
          id: String(opts['provider']),
          env: readEnvironment(),
          settings: cli.settings,
          languageCode: language.code,
          model: opts['model'] as string | undefined,
          requireWordTimestamps: true,
          store: cli.ctx.store,
        });

        /**
         * The mode is decided once, here, with the numbers a user could still act on.
         *
         * `plan.chunks` honours it rather than re-deriving it. Re-deciding inside the worker
         * would occasionally disagree with the DAG that had already been planned around the
         * first answer — a `batch` run growing `asr.chunk` shards — and the disagreement would
         * surface as a step failing for a reason that had stopped being true.
         */
        const requested = String(opts['mode']);
        const decision = planMode({
          durationMs: asset.durationMs,
          bytes: asset.bytes,
          caps: built.provider.capabilities(built.model),
          stagingConfigured: cli.staging !== null,
          ...(requested !== 'auto' ? { force: requested as 'sync' } : {}),
        });

        const spec: PipelineSpec = {
          asr: {
            providerId: built.provider.id,
            model: built.model,
            mode: decision.mode,
            local: built.provider.id === 'faster-whisper',
            overlapMs: opts['overlapMs'] as number,
          },
          /**
           * `required: false`, always, and it is not a flag waiting to be exposed.
           *
           * A required diarization would make `diarize` non-optional, and the reconciler fails
           * a run whose non-optional step dies. Phase 3's founding invariant is that
           * diarization never gates the transcript: pyannote is about 0.09x realtime on this
           * box's CPU, so a one-hour interview is three hours of GPU against a minute of ASR,
           * and a sidecar that is down must cost the speaker labels and nothing else.
           */
          ...(opts['diarize']
            ? {
                diarize: {
                  providerId: 'pyannote',
                  required: false,
                  ...(typeof opts['speakers'] === 'number'
                    ? { hints: { numSpeakers: opts['speakers'] } }
                    : {}),
                },
              }
            : {}),
          // Everything below is off until its handler exists. A step planned onto a kind no
          // worker can execute is a run that stops, and saying so in the plan is better than
          // discovering it in `/admin/queue`.
          editorial: [],
          peaks: false,
          exports: [],
        };

        const started = await startRun(cli.ctx, {
          jobId,
          providerId: built.provider.id,
          model: built.model,
          spec,
        });

        process.stdout.write(
          `run     ${started.runId}\n` +
            `mode    ${decision.mode}  reason="${decision.reason}"\n` +
            `model   ${built.model} — ${built.modelReason}\n` +
            `steps   ${started.steps} planned (the asr.chunk shards are added by plan.chunks)\n`,
        );

        if (opts['ring'] === false) {
          process.stdout.write(
            `\nNot rung. A worker's 30-second reconcile tick will pick it up.\n`,
          );
          return;
        }

        const url = readEnvironment().DATABASE_URL!;
        doorbell = await PgBossDoorbell.create({ connectionString: url, max: 2 });
        await reconcileRun({ ...cli.ctx, doorbell }, started.runId);
        process.stdout.write(`\nQueued. Watch it with \`thibi runs show ${started.runId}\`.\n`);
      } finally {
        if (doorbell) await doorbell.stop({ timeoutMs: 5_000 });
        await cli.close();
      }
    });

  command
    .command('cancel')
    .argument('<id>')
    .description('Request cancellation. A running CLI picks it up before its next poll.')
    .action(async (id: string) => {
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        if (!cli.db) throw new Error('runs cancel needs a database.');
        await requestCancel(cli.ctx, id);
        process.stdout.write(`Cancellation requested for ${id}.\n`);
      } finally {
        await cli.close();
      }
    });

  command
    .command('resume')
    .argument('<id>')
    .description('Re-poll a batch run that was interrupted. Never re-submits.')
    .option('-o, --out <path>', 'output path, or - for stdout', '-')
    .option('-f, --format <format>', 'json | text', 'json')
    .action(async (id: string, opts: { out: string; format: string }) => {
      const startedAt = new Date();
      const aborter = new AbortController();
      const onSigint = (): void => aborter.abort();
      process.on('SIGINT', onSigint);

      const cli = await buildContext({ engineVersion: ENGINE_VERSION, signal: aborter.signal });
      try {
        if (!cli.db) throw new Error('runs resume needs a database.');
        if (!cli.staging) {
          process.stderr.write(
            'No GCS staging bucket is configured, so a batch run cannot be resumed: the ' +
              'transcript has to be read back out of the bucket it was written to.\n',
          );
          process.exitCode = EXIT.notConfigured;
          return;
        }

        const env = readEnvironment();
        const serviceAccountJson = await resolveServiceAccountJson(env);
        if (!serviceAccountJson) {
          process.stderr.write('No Google credentials.\n');
          process.exitCode = EXIT.notConfigured;
          return;
        }
        const projectId =
          (await cli.settings.get('google.project_id')) ??
          (JSON.parse(serviceAccountJson) as { project_id?: string }).project_id;
        if (!projectId) {
          process.stderr.write('No Google project id: set GOOGLE_PROJECT_ID.\n');
          process.exitCode = EXIT.notConfigured;
          return;
        }

        const region = (await cli.settings.get('google.region')) ?? DEFAULT_GOOGLE_REGION;
        const model = (await cli.settings.get('google.model')) ?? DEFAULT_GOOGLE_MODEL;
        const provider = createGoogleProvider({ clock: cli.ctx.clock, signal: aborter.signal });
        const providerConfig: GoogleConfig = { serviceAccountJson, projectId, region, model };

        const deps: BatchDeps = {
          region,
          projectId,
          getToken: async () => {
            // The provider owns the token cache; resume needs one call and can mint its own.
            const { createTokenCache } = await import('@thibi/engine');
            return createTokenCache({ clock: cli.ctx.clock }).get(serviceAccountJson);
          },
          clock: cli.ctx.clock,
          signal: aborter.signal,
        };

        const outcome = await resumeBatchRun(cli.ctx, { runId: id, deps });

        switch (outcome.kind) {
          case 'not-found':
            process.stderr.write(`No run ${id}.\n`);
            process.exitCode = EXIT.usage;
            return;
          case 'not-batch':
            process.stderr.write(
              `Run ${id} is mode=${outcome.mode}. Only batch runs can be resumed — a sync ` +
                `run holds no state outside this process, so re-running it is the resume.\n`,
            );
            process.exitCode = EXIT.usage;
            return;
          case 'already-finished':
            process.stdout.write(`Run ${id} is already ${outcome.state}. Nothing to do.\n`);
            return;
          case 'no-operation':
            process.stderr.write(
              `Run ${id} is a batch run with no operation name, and no operation at Google ` +
                `matches its staged audio within the lookback window. It never got as far as ` +
                `submitting, so nothing is running and nothing has been billed. Re-run the ` +
                `transcribe command.\n` +
                (outcome.stagingPrefix
                  ? `The staged audio at ${outcome.stagingPrefix} will be removed by the ` +
                    `bucket's lifecycle rule.\n`
                  : ''),
            );
            process.exitCode = EXIT.usage;
            return;
        }

        const { op, recovered } = outcome;
        process.stderr.write(
          `resuming batch operation ${op.name}   (no re-submit)` +
            (recovered ? '  [recovered by input-URI match]' : '') +
            '\n',
        );

        const status = await pollToCompletion(
          cli.ctx,
          {
            runId: id,
            provider,
            providerConfig,
            onPoll: (_s, elapsedMs) => {
              process.stderr.write(`poll    ${Math.round(elapsedMs / 1000)}s\n`);
            },
          },
          op,
        );

        if (status.state === 'failed') {
          process.stderr.write(
            `The operation failed (${status.error?.scope}): ${status.error?.message}\n`,
          );
          process.exitCode = 1;
          return;
        }

        // Read the run's own row for the fields the transcript needs, rather than assuming
        // the defaults above match what the original run actually used.
        const { rows } = await cli.db.$client.query<{
          job_id: string;
          language_code: string;
          model: string;
        }>('select job_id, language_code, model from runs where id = $1', [id]);
        const row = rows[0]!;

        const language = cli.languages.get(row.language_code);
        if (!language) throw new Error(`Run ${id} names an unknown language ${row.language_code}`);

        const durationMs = await durationOf(cli, id);
        const result = await provider.fetchBatchResult!(providerConfig, op, {
          status,
          durationMs,
          read: cli.staging.readJson.bind(cli.staging),
          list: cli.staging.list.bind(cli.staging),
        });

        // Same order as the first attempt: archive before the sweep, always.
        const { rawResponseKey } = await import('@thibi/storage');
        await cli.ctx.store.put(
          rawResponseKey(id, 0),
          Buffer.from(JSON.stringify(result.raw, null, 2)),
          { contentType: 'application/json' },
        );

        const segments = result.segments.map((s, idx) => ({
          idx,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          textRaw: s.text,
          confidence: s.confidence,
          hasWords: s.words.length > 0,
          chunkIdx: 0,
          words: s.words.map((w, i) => ({
            idx: i,
            startMs: w.startMs,
            endMs: w.endMs,
            text: w.text,
            confidence: w.confidence,
          })),
        }));

        await persistChunks(cli.ctx, id, [
          { idx: 0, offsetMs: 0, contentStartMs: 0, endMs: durationMs, overlapLeadMs: 0 },
        ]);

        const usage = await recordUsage(cli.ctx, {
          runId: id,
          providerId: 'google',
          model: row.model,
          mode: 'batch',
          status,
          audioMs: durationMs,
        });

        await persistResult(cli.ctx, {
          runId: id,
          jobId: row.job_id,
          segments,
          wordTimingQuality: result.wordTimingQuality,
          pipeline: { warnings: [], resumed: true },
          costUsd: usage?.usd ?? 0,
          partial: false,
          failedChunks: new Set(),
        });

        const prefix = stagingPrefixFor(id);
        const { deleted } = await cli.staging.deletePrefix(prefix);
        await cli.db.$client.query('update runs set staging_prefix = null where id = $1', [id]);

        process.stderr.write(
          `done    segments=${segments.length}  ` +
            `words=${segments.reduce((n, s) => n + s.words.length, 0)}  ` +
            `cost $${(usage?.usd ?? 0).toFixed(4)}\nstaging deleted (${deleted} objects)\n`,
        );

        const transcript: TranscriptJson = buildTranscript({
          runId: id,
          provider: 'google',
          model: row.model,
          language: language.code,
          mode: 'batch',
          engineVersion: ENGINE_VERSION,
          wordTimingQuality: result.wordTimingQuality,
          startedAt,
          finishedAt: new Date(),
          costUsd: usage?.usd ?? 0,
          partial: false,
          filename: '',
          sha256: null,
          durationMs,
          format: null,
          plans: [],
          failedChunks: new Set(),
          seams: [],
          segments,
          warnings: [],
        });

        const rendered =
          opts.format === 'text' ? formatText(transcript) : JSON.stringify(transcript, null, 2);
        if (opts.out === '-') process.stdout.write(rendered + '\n');
        else await writeFile(resolve(opts.out), rendered + '\n');
      } finally {
        process.off('SIGINT', onSigint);
        await cli.close();
      }
    });

  return command;
}

/**
 * The job's recording: what `planMode` needs before anything is created.
 *
 * Read from the asset rather than taken from flags, because the mode decision is about *this*
 * file — its duration and its bytes against the provider's sync limits — and a wrong answer
 * here plans a DAG of the wrong shape.
 */
async function assetForJob(
  cli: Awaited<ReturnType<typeof buildContext>>,
  jobId: string,
): Promise<{ languageCode: string; durationMs: number | null; bytes: number } | null> {
  const { rows } = await cli.db!.$client.query<{
    language_code: string;
    duration_ms: number | null;
    bytes: string;
  }>(
    `select j.language_code, a.duration_ms, a.bytes
       from jobs j join media_assets a on a.id = j.asset_id
      where j.id = $1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    languageCode: row.language_code,
    durationMs: row.duration_ms,
    bytes: Number(row.bytes),
  };
}

/**
 * The run's audio duration, from the asset row.
 *
 * Only used to bound segments that came back with no word timings at all, and to cost the
 * run when Google reported no `totalBilledDuration`. Zero is an acceptable fallback for the
 * first; `recordUsage` prefers the provider's number for the second.
 */
async function durationOf(
  cli: Awaited<ReturnType<typeof buildContext>>,
  runId: string,
): Promise<number> {
  const { rows } = await cli.db!.$client.query<{ duration_ms: number | null }>(
    `select a.duration_ms
       from runs r join jobs j on j.id = r.job_id join media_assets a on a.id = j.asset_id
      where r.id = $1`,
    [runId],
  );
  return rows[0]?.duration_ms ?? 0;
}

export { parseGsUri };
