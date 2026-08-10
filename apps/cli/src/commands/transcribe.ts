import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  AbortedError,
  createGoogleProvider,
  createRun,
  DEFAULT_OVERLAP_MS,
  ModeUnavailableError,
  NotConfiguredError,
  persistChunks,
  persistResult,
  planMode,
  probe,
  recordUsage,
  requestCancel,
  runBatch,
  StagingRefusedError,
  transcribe,
  UnsupportedLanguageError,
  type GoogleConfig,
  type TranscriptionProvider,
} from '@thibi/engine';
import { resolveRate, unitForMode } from '@thibi/db';
import { assetKey, extensionOf, rawResponseKey } from '@thibi/storage';
import { stat } from 'node:fs/promises';
import { buildContext, resolveServiceAccountJson, readEnvironment } from '../context.js';
import { DEFAULT_GOOGLE_MODEL, DEFAULT_GOOGLE_REGION } from '../config.js';
import { buildTranscript, EXIT, formatText, type TranscriptJson } from '../output.js';

const ENGINE_VERSION = '0.1.0';

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function transcribeCommand(): Command {
  return new Command('transcribe')
    .description('Transcribe an audio or video file')
    .argument('<file>', 'path to the media file')
    .requiredOption('-l, --lang <code>', 'language code, e.g. my, my-MM or Burmese')
    .option('-p, --provider <id>', 'provider id', 'google')
    .option('-m, --model <id>', 'provider model')
    .option(
      '--mode <mode>',
      'auto | sync | sync_chunked | batch. `batch` needs a GCS staging bucket and is never ' +
        'chosen automatically: spike S3 measured it 3.6-7x slower than chunked sync at every ' +
        'duration, and worth using only because it is 5.3x cheaper.',
      'auto',
    )
    .option(
      '--dry-run',
      'Probe and plan, print the cost both ways from the rates table, and stop without ' +
        'sending any audio to the provider.',
    )
    .option('-o, --out <path>', 'output path, or - for stdout', '-')
    .option('-f, --format <format>', 'json | text', 'json')
    .option('--no-db', 'run without Postgres or MinIO; nothing is persisted')
    .option('--max-duration <seconds>', 'transcribe only the first N seconds', Number)
    .option(
      '-c, --concurrency <n>',
      'parallel chunk requests. Two CLIs at once can self-429 until Phase 9 adds a shared token bucket.',
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--overlap-ms <n>',
      'how much earlier each chunk starts, for seam de-duplication. 0 disables the merge.',
      (v) => Number.parseInt(v, 10),
      DEFAULT_OVERLAP_MS,
    )
    .option('--raw-dir <path>', 'write each provider response here, for debugging')
    .action(async (file: string, opts) => {
      const startedAt = new Date();
      const sourcePath = resolve(file);
      const filename = basename(sourcePath);

      /**
       * SIGINT has to reach the engine, not just kill the process.
       *
       * On the batch path a submitted operation keeps running — and keeps billing — after
       * the CLI exits, so Ctrl-C must cancel it at Google and sweep the staged audio. The
       * abort signal is how `pollToCompletion` learns to stop; the handler below is what
       * does the cleanup.
       */
      const aborter = new AbortController();
      let interrupted = false;
      const onSigint = (): void => {
        if (interrupted) {
          // A second Ctrl-C means they want out now. Honour it, and say what is left behind.
          process.stderr.write(
            '\nInterrupted again — exiting without waiting for cleanup. Any submitted ' +
              'operation may still be running.\n',
          );
          process.exit(EXIT.aborted);
        }
        interrupted = true;
        process.stderr.write('\nCancelling…\n');
        aborter.abort();
      };
      process.on('SIGINT', onSigint);

      const cli = await buildContext({
        noDb: opts.db === false,
        ...(opts.concurrency ? { concurrency: opts.concurrency as number } : {}),
        signal: aborter.signal,
        engineVersion: ENGINE_VERSION,
      });

      try {
        // ---- resolve the language ----------------------------------------------------
        const language = cli.languages.get(opts.lang as string);
        if (!language) {
          process.stderr.write(
            `Unknown language '${opts.lang}'. Try \`thibi lang list\` — the registry accepts ` +
              `an ISO code, a BCP-47 tag, an English name or an endonym.\n`,
          );
          process.exitCode = EXIT.usage;
          return;
        }

        // ---- build the provider ------------------------------------------------------
        if (opts.provider !== 'google') {
          process.stderr.write(
            `Provider '${opts.provider}' is not available yet. Whisper providers land in ` +
              `Phase 4; only 'google' works today.\n`,
          );
          process.exitCode = EXIT.usage;
          return;
        }

        const env = readEnvironment();
        const serviceAccountJson = await resolveServiceAccountJson(env);
        if (!serviceAccountJson) {
          throw new NotConfiguredError(
            'No Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account ' +
              'JSON with roles/speech.client, or GOOGLE_SA_JSON to its contents.',
          );
        }

        const projectId =
          (await cli.settings.get('google.project_id')) ??
          (JSON.parse(serviceAccountJson) as { project_id?: string }).project_id;
        if (!projectId) {
          throw new NotConfiguredError('No Google project id: set GOOGLE_PROJECT_ID.');
        }

        const provider: TranscriptionProvider = createGoogleProvider({ clock: cli.ctx.clock });
        const capability = provider.supportsLanguage(language.code);
        if (!capability?.supported) {
          process.stderr.write(
            `${provider.label} does not support ${language.code} (${language.nameEn}).\n` +
              `Run \`thibi lang show ${language.code}\` to see which providers do.\n`,
          );
          process.exitCode = EXIT.languageRejected;
          return;
        }

        const model =
          (opts.model as string | undefined) ??
          (await cli.settings.get('google.model')) ??
          DEFAULT_GOOGLE_MODEL;

        const providerConfig: GoogleConfig = {
          serviceAccountJson,
          projectId,
          region: (await cli.settings.get('google.region')) ?? DEFAULT_GOOGLE_REGION,
          model,
        };

        // ---- plan, and stop here on --dry-run ------------------------------------------
        // Resolved before anything is uploaded or created, because `--mode batch` without a
        // staging bucket must fail here rather than after a run row exists.
        const capabilities = provider.capabilities(model);
        const requestedMode = opts.mode as string;
        const probed = await probe(cli.ctx, { path: sourcePath });
        const bytes = (await stat(sourcePath)).size;

        const decision = planMode({
          durationMs: probed.durationMs,
          bytes,
          caps: capabilities,
          stagingConfigured: cli.staging !== null,
          ...(requestedMode !== 'auto' ? { force: requestedMode as 'sync' } : {}),
        });
        cli.ctx.logger.info({}, `plan: mode=${decision.mode}  reason="${decision.reason}"`);

        if (opts.dryRun) {
          await printDryRun(cli, {
            mode: decision.mode,
            reason: decision.reason,
            durationMs: probed.durationMs,
            providerId: provider.id,
            model,
          });
          return;
        }

        // ---- run ---------------------------------------------------------------------
        const rawDir = opts.rawDir as string | undefined;
        const persisting = cli.db !== null;

        // The source is uploaded and the run row created before any work begins, so a
        // crash leaves a record of what was attempted rather than nothing at all.
        let runId: string = randomUUID();
        let jobId: string | null = null;
        let assetId: string | null = null;
        let sha256: string | null = null;

        if (persisting) {
          sha256 = await sha256Of(sourcePath);
          const key = assetKey(sha256, extensionOf(filename));
          if (!(await cli.ctx.store.head(key))) {
            await cli.ctx.store.putStream(key, createReadStream(sourcePath));
          }
          const created = await createRun(cli.ctx, {
            sha256,
            storageKey: key,
            filename,
            bytes,
            durationMs: probed.durationMs,
            probeRaw: null,
            title: filename,
            languageCode: language.code,
            providerId: provider.id,
            model,
            // The planned mode, not a hardcoded guess. Phase 1 always wrote `sync_chunked`
            // here and let the engine decide something else, which made `runs.mode` wrong
            // for every single-request run. It also has to be right from the start on the
            // batch path: `mode='batch'` is what makes an interrupted run findable.
            mode: decision.mode,
          });
          runId = created.runId;
          jobId = created.jobId;
          assetId = created.assetId;
          if (created.assetExisted) {
            cli.ctx.logger.info({ sha256: sha256.slice(0, 12) }, 'ingest: asset already stored');
          }
        }

        // ---- batch: a separate path, not a branch inside the sync one -------------------
        if (decision.mode === 'batch') {
          const batch = await runBatch(cli.ctx, {
            sourcePath,
            filename,
            language,
            provider,
            providerConfig,
            model,
            runId,
            region: providerConfig.region,
            planReason: decision.reason,
            ...(assetId ? { assetId } : {}),
            ...(opts.maxDuration ? { maxDurationMs: (opts.maxDuration as number) * 1000 } : {}),
            onSubmitted: (op) => {
              // The word the crash test in the plan's verification looks for.
              cli.ctx.logger.info({}, `op      ${op.name}  [persisted]`);
            },
            onPoll: (status, elapsedMs) => {
              const pct =
                status.progressPercent !== undefined ? `  ${status.progressPercent}%` : '';
              cli.ctx.logger.info({}, `poll    ${Math.round(elapsedMs / 1000)}s${pct}`);
            },
          });

          const wordCount = batch.segments.reduce((n, s) => n + s.words.length, 0);

          // One `run_chunks` row, so segments join to a chunk on both paths rather than
          // being nullable on one of them.
          if (persisting) {
            await persistChunks(cli.ctx, runId, [
              {
                idx: 0,
                offsetMs: 0,
                contentStartMs: 0,
                endMs: batch.usage.audioMs,
                overlapLeadMs: 0,
              },
            ]);
          }

          const usage = persisting
            ? await recordUsage(cli.ctx, {
                runId,
                providerId: provider.id,
                model,
                mode: 'batch',
                status: batch.status,
                audioMs: batch.usage.audioMs,
              })
            : null;

          if (persisting && jobId) {
            const written = await persistResult(cli.ctx, {
              runId,
              jobId,
              segments: batch.segments,
              wordTimingQuality: batch.wordTimingQuality,
              // Merged into whatever `persistOperation` already wrote, which is why
              // `pipeline.batch` survives to the end of the run.
              pipeline: { planReason: decision.reason, warnings: batch.warnings },
              costUsd: usage?.usd ?? 0,
              partial: false,
              failedChunks: new Set(),
            });
            cli.ctx.logger.info(
              { segments: written.segmentsInserted, words: written.wordsInserted },
              'persist: written',
            );
          }

          cli.ctx.logger.info(
            {},
            `done    ${formatDuration(batch.latencyMs)}   segments=${batch.segments.length}  ` +
              `words=${wordCount}  wordTimingQuality=${batch.wordTimingQuality}`,
          );
          if (usage) {
            const syncUsd = await estimateUsd(cli, provider.id, model, 'sync', usage.minutes);
            cli.ctx.logger.info(
              {},
              `cost    $${usage.usd.toFixed(4)}` +
                (syncUsd !== null ? `  (sync would have been $${syncUsd.toFixed(4)})` : '') +
                (usage.reportedByProvider ? '' : '  [estimated: the provider reported no duration]'),
            );
          }
          cli.ctx.logger.info({}, `staging deleted (${batch.stagingDeleted} objects)`);
          for (const warning of batch.warnings) {
            cli.ctx.logger.warn({ code: warning.code }, warning.message);
          }

          const batchTranscript: TranscriptJson = buildTranscript({
            runId,
            provider: provider.id,
            model,
            language: language.code,
            mode: 'batch',
            engineVersion: ENGINE_VERSION,
            wordTimingQuality: batch.wordTimingQuality,
            startedAt,
            finishedAt: new Date(),
            costUsd: usage?.usd ?? 0,
            partial: false,
            filename,
            sha256,
            durationMs: batch.probe.durationMs,
            format: batch.probe.formatName,
            plans: [],
            failedChunks: new Set(),
            seams: [],
            segments: batch.segments,
            warnings: batch.warnings,
          });

          const out =
            opts.format === 'text'
              ? formatText(batchTranscript)
              : JSON.stringify(batchTranscript, null, 2);
          if (opts.out === '-') process.stdout.write(out + '\n');
          else await writeFile(resolve(opts.out as string), out + '\n');
          return;
        }

        const result = await transcribe(cli.ctx, {
          sourcePath,
          filename,
          language,
          provider,
          providerConfig,
          model,
          runId,
          mode: decision.mode,
          ...(assetId ? { assetId } : {}),
          overlapMs: opts.overlapMs as number,
          ...(opts.maxDuration ? { maxDurationMs: (opts.maxDuration as number) * 1000 } : {}),
          onPlan: async (plans) => {
            // Before any cutting and before any network request.
            if (persisting) await persistChunks(cli.ctx, runId, plans);
            cli.ctx.logger.info(
              { chunks: plans.length, overlapMs: opts.overlapMs },
              'plan: chunks recorded before any provider request',
            );
          },
          onRawResponse: async (idx: number, raw: unknown) => {
            const body = JSON.stringify(raw, null, 2);
            if (rawDir) {
              await writeFile(resolve(rawDir, `${String(idx).padStart(3, '0')}.json`), body);
            }
            // Archive the untouched provider response, so a disputed transcript can always
            // be checked against what the provider actually said.
            if (persisting) {
              await cli.ctx.store.put(rawResponseKey(runId, idx), Buffer.from(body), {
                contentType: 'application/json',
              });
            }
          },
        });

        // ---- report ------------------------------------------------------------------
        const wordCount = result.segments.reduce((n, s) => n + s.words.length, 0);
        for (const seam of result.seams) {
          cli.ctx.logger.info(
            {},
            `seam ${seam.afterChunk}→${seam.afterChunk + 1}: ${seam.method} score ${seam.score}, ` +
              `dropped ${seam.droppedWords} duplicated word${seam.droppedWords === 1 ? '' : 's'}`,
          );
        }
        cli.ctx.logger.info(
          {},
          `words: ${wordCount} · word timings: ${result.wordTimingQuality} · ` +
            `cost $${result.costUsd.toFixed(4)}`,
        );
        if (result.wordTimingQuality === 'none') {
          cli.ctx.logger.warn(
            {},
            `word timings: none — ${language.code} returned no word offsets; subtitle timing ` +
              `will be interpolated`,
          );
        }
        for (const warning of result.warnings) {
          cli.ctx.logger.warn({ code: warning.code }, warning.message);
        }

        const failedChunks = new Set(
          result.warnings.filter((w) => w.code === 'chunk_failed').map((w) => w.chunk!),
        );

        if (persisting && jobId) {
          const written = await persistResult(cli.ctx, {
            runId,
            jobId,
            segments: result.segments,
            wordTimingQuality: result.wordTimingQuality,
            pipeline: { seams: result.seams, warnings: result.warnings },
            costUsd: result.costUsd,
            partial: result.partial,
            failedChunks,
          });
          cli.ctx.logger.info(
            { segments: written.segmentsInserted, words: written.wordsInserted },
            'persist: written',
          );
        }

        const transcript: TranscriptJson = buildTranscript({
          runId,
          provider: provider.id,
          model,
          language: language.code,
          mode: result.mode,
          engineVersion: ENGINE_VERSION,
          wordTimingQuality: result.wordTimingQuality,
          startedAt,
          finishedAt: new Date(),
          costUsd: result.costUsd,
          partial: result.partial,
          filename,
          sha256,
          durationMs: result.probe.durationMs,
          format: result.probe.formatName,
          plans: result.plans,
          failedChunks,
          seams: result.seams,
          segments: result.segments,
          warnings: result.warnings,
        });

        const rendered =
          opts.format === 'text' ? formatText(transcript) : JSON.stringify(transcript, null, 2);

        if (opts.out === '-') process.stdout.write(rendered + '\n');
        else await writeFile(resolve(opts.out as string), rendered + '\n');

        if (persisting) {
          await recordUsage(cli.ctx, {
            runId,
            providerId: provider.id,
            model,
            mode: result.mode,
            audioMs: result.usage.audioMs,
          });
        }

        // Exit 4 still prints the transcript: a three-hour transcript with one bad
        // 55-second chunk is still valuable.
        if (result.partial) process.exitCode = EXIT.partial;
      } catch (err) {
        // Three failures that are the operator's to fix, not stack traces to read. Each
        // already carries its own remediation; printing it twice, wrapped in a trace, is
        // how a good message gets ignored.
        if (err instanceof ModeUnavailableError || err instanceof StagingRefusedError) {
          process.stderr.write(`\n${err.message}\n`);
          process.exitCode = EXIT.notConfigured;
          return;
        }
        if (err instanceof AbortedError || aborter.signal.aborted) {
          process.stderr.write('\nCancelled.\n');
          process.exitCode = EXIT.aborted;
          return;
        }
        throw err;
      } finally {
        process.off('SIGINT', onSigint);
        await cli.close();
      }
    });
}

/**
 * `--dry-run`: what this would cost, both ways, before spending anything.
 *
 * Reads the `rates` table rather than a constant, so an admin who corrected a price sees
 * their number. A missing rate prints "unknown" and never $0.00 — quoting zero for two hours
 * of transcription is worse than admitting ignorance, because somebody will believe it.
 */
async function printDryRun(
  cli: Awaited<ReturnType<typeof buildContext>>,
  input: {
    mode: 'sync' | 'sync_chunked' | 'batch';
    reason: string;
    durationMs: number | null;
    providerId: string;
    model: string;
  },
): Promise<void> {
  // The plan line is already on stderr from the logger. Repeating it on stdout would put
  // the same sentence in the file when someone redirects, which is how a `--dry-run` report
  // ends up looking like it ran twice.
  if (input.durationMs === null) {
    process.stdout.write(
      'cost: unavailable — ffprobe could not determine the duration of this file.\n',
    );
    return;
  }

  const minutes = input.durationMs / 60_000;
  const chosen = await estimateUsd(cli, input.providerId, input.model, input.mode, minutes);
  const other = await estimateUsd(
    cli,
    input.providerId,
    input.model,
    input.mode === 'batch' ? 'sync' : 'batch',
    minutes,
  );

  if (chosen === null) {
    process.stdout.write(
      `cost: unknown — no rate configured for ${input.providerId}/${input.model}/` +
        `${unitForMode(input.mode)}. Seed the rates table (\`thibi db seed\`).\n`,
    );
    return;
  }

  process.stdout.write(
    `cost: ${minutes.toFixed(1)} min × $${(chosen / minutes).toFixed(5)} = ` +
      `$${chosen.toFixed(4)}\n`,
  );
  if (other !== null) {
    const label = input.mode === 'batch' ? 'sync' : 'batch';
    process.stdout.write(
      `      ${label} would be $${other.toFixed(4)}` +
        (input.mode === 'batch'
          ? ` — batch is slower (about 5.9x realtime) and ${(other / chosen).toFixed(1)}x cheaper\n`
          : ` — batch is ${(chosen / other).toFixed(1)}x cheaper and 3.6-7x slower` +
            (cli.staging === null ? ', and needs a GCS staging bucket you have not set\n' : '\n')),
    );
  }
  process.stdout.write('\nNothing was sent to the provider.\n');
}

async function estimateUsd(
  cli: Awaited<ReturnType<typeof buildContext>>,
  providerId: string,
  model: string,
  mode: 'sync' | 'sync_chunked' | 'batch',
  minutes: number,
): Promise<number | null> {
  if (!cli.db) return null;
  const rate = await resolveRate(cli.db, { providerId, model, unit: unitForMode(mode) });
  return rate ? minutes * rate.usdPerUnit : null;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

export { NotConfiguredError, UnsupportedLanguageError, requestCancel };
