import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  createGoogleProvider,
  createRun,
  DEFAULT_OVERLAP_MS,
  NotConfiguredError,
  persistChunks,
  persistResult,
  transcribe,
  UnsupportedLanguageError,
  type GoogleConfig,
  type TranscriptionProvider,
} from '@thibi/engine';
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
    .option('--mode <mode>', 'auto | sync | sync_chunked', 'auto')
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

      const cli = await buildContext({
        noDb: opts.db === false,
        ...(opts.concurrency ? { concurrency: opts.concurrency as number } : {}),
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
            bytes: (await stat(sourcePath)).size,
            durationMs: null,
            probeRaw: null,
            title: filename,
            languageCode: language.code,
            providerId: provider.id,
            model,
            mode: 'sync_chunked',
          });
          runId = created.runId;
          jobId = created.jobId;
          assetId = created.assetId;
          if (created.assetExisted) {
            cli.ctx.logger.info({ sha256: sha256.slice(0, 12) }, 'ingest: asset already stored');
          }
        }

        const result = await transcribe(cli.ctx, {
          sourcePath,
          filename,
          language,
          provider,
          providerConfig,
          model,
          runId,
          mode: opts.mode as 'auto',
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

        // Exit 4 still prints the transcript: a three-hour transcript with one bad
        // 55-second chunk is still valuable.
        if (result.partial) process.exitCode = EXIT.partial;
      } finally {
        await cli.close();
      }
    });
}

export { NotConfiguredError, UnsupportedLanguageError };
