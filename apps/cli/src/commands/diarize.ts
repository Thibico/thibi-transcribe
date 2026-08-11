import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  diarizeAudioForRun,
  NotConfiguredError,
  parseRttm,
  PyannoteSource,
  runDiarization,
  scoreDiarization,
  type DiarizationSource,
  type Turn,
} from '@thibi/engine';
import { buildContext, type CliContext } from '../context.js';
import { EXIT } from '../output.js';

const ENGINE_VERSION = '0.1.0';

/**
 * `thibi diarize` — attribute an existing transcript, and score the attribution.
 *
 * `run` exists because of the invariant in Phase 3 §6: **diarization must never gate the
 * transcript.** ASR finishes a one-hour file in about a minute and pyannote takes about an
 * hour and forty; a design where speaker labels block the transcript turns a one-minute
 * product into a two-hour one. So diarization is a separate pass over a run that already
 * exists, and `thibi transcribe --diarize` is the convenience of doing both in one command,
 * not the only way in.
 *
 * `score` exists because every threshold in `reconcile.ts` is **chosen, not measured**.
 */
export function diarizeCommand(): Command {
  const command = new Command('diarize').description(
    'Diarize an existing run, or score a diarization against a reference',
  );

  command
    .command('run')
    .argument('<runId>')
    .option('--speakers <n>', 'exact number of speakers, if you know it', Number)
    .option('--min-speakers <n>', 'lower bound', Number)
    .option('--max-speakers <n>', 'upper bound', Number)
    .option('--source <id>', 'pyannote', 'pyannote')
    .action(async (runId: string, opts: DiarizeOptions & { source: string }) => {
      const aborter = new AbortController();
      const onSigint = (): void => aborter.abort();
      process.on('SIGINT', onSigint);
      const cli = await buildContext({ engineVersion: ENGINE_VERSION, signal: aborter.signal });
      try {
        if (!cli.db) throw new Error('thibi diarize needs a database.');
        const source = resolveSource(cli, opts.source);
        if (!source) return;
        await diarizeRun(cli, runId, source, opts);
      } catch (err) {
        if (err instanceof NotConfiguredError) {
          process.stderr.write(`\n${err.message}\n${err.hint ? `${err.hint}\n` : ''}`);
          process.exitCode = EXIT.notConfigured;
          return;
        }
        throw err;
      } finally {
        process.off('SIGINT', onSigint);
        await cli.close();
      }
    });

  command
    .command('score')
    .argument('<runId>', 'the run whose stored turns are the hypothesis')
    .requiredOption('--reference <path>', 'a hand-labelled RTTM')
    .option(
      '--hypothesis <path>',
      'score an RTTM against another RTTM instead of reading the database. For threshold ' +
        'sweeps that never touch a run.',
    )
    .option('-f, --format <format>', 'text | json', 'text')
    .action(
      async (
        runId: string,
        opts: { reference: string; hypothesis?: string; format: string },
      ) => {
        const cli = await buildContext({ engineVersion: ENGINE_VERSION });
        try {
          const reference = parseRttm(await readFile(resolve(opts.reference), 'utf8'));

          let hypothesis: Turn[];
          if (opts.hypothesis) {
            hypothesis = parseRttm(await readFile(resolve(opts.hypothesis), 'utf8'));
          } else {
            if (!cli.db) throw new Error('Scoring a run needs a database. Use --hypothesis.');
            const { rows } = await cli.db.$client.query<{
              raw_key: string;
              start_ms: number;
              end_ms: number;
            }>(
              // The most recent successful diarization of this run. Two of them can exist —
              // a failed attempt leaves a row too — and scoring the failed one would report
              // a DER of 1.0 for a run that is fine.
              `select t.raw_key, t.start_ms, t.end_ms
                 from speaker_turns t
                 join diarization_runs d on d.id = t.diarization_run_id
                where d.run_id = $1 and d.state = 'succeeded'
                  and d.created_at = (
                    select max(created_at) from diarization_runs
                     where run_id = $1 and state = 'succeeded')
                order by t.start_ms`,
              [runId],
            );
            if (rows.length === 0) {
              process.stderr.write(
                `Run ${runId} has no successful diarization to score. ` +
                  `Run \`thibi diarize run ${runId}\` first.\n`,
              );
              process.exitCode = EXIT.usage;
              return;
            }
            hypothesis = rows.map((r) => ({
              startMs: r.start_ms,
              endMs: r.end_ms,
              speakerKey: r.raw_key,
            }));
          }

          const score = scoreDiarization(reference, hypothesis);
          if (opts.format === 'json') {
            process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
            return;
          }
          const pct = (ms: number): string =>
            `${((ms / score.totalMs) * 100).toFixed(1).padStart(5)}%`;
          process.stdout.write(
            `reference   ${score.referenceSpeakers} speakers, ` +
              `${(score.totalMs / 1000).toFixed(1)}s of speech (overlap counted per speaker)\n` +
              `hypothesis  ${score.hypothesisSpeakers} speakers\n` +
              `miss       ${pct(score.missMs)}\n` +
              `false alarm${pct(score.falseAlarmMs)}\n` +
              `confusion  ${pct(score.confusionMs)}\n` +
              `DER        ${(score.der * 100).toFixed(1)}%\n` +
              `JER        ${(score.jer * 100).toFixed(1)}%\n` +
              `\nNo collar and no UEM: NIST forgives 250 ms either side of a reference\n` +
              `boundary and scores inside an evaluation map. Both would flatter this number,\n` +
              `so it is comparable to itself across a threshold sweep and not to a published DER.\n`,
          );
        } finally {
          await cli.close();
        }
      },
    );

  return command;
}

export interface DiarizeOptions {
  speakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
}

/**
 * Build the diarization source, or explain why this box cannot.
 *
 * Returns null rather than throwing, having already written the reason: an unset
 * `SIDECAR_URL` is a supported configuration — the compose service is behind a profile —
 * and a stack trace would misrepresent it as a fault.
 */
export function resolveSource(cli: CliContext, sourceId: string): DiarizationSource | null {
  if (sourceId !== 'pyannote') {
    process.stderr.write(
      `Unknown diarization source '${sourceId}'. Only 'pyannote' is built; the ElevenLabs ` +
        `Scribe source is planned and not implemented.\n`,
    );
    process.exitCode = EXIT.usage;
    return null;
  }
  if (!cli.sidecarUrl) {
    process.stderr.write(
      `Diarization needs the Python sidecar, and SIDECAR_URL is not set.\n` +
        `  docker compose --env-file .env -f infra/compose.dev.yml --profile diarize up -d sidecar\n` +
        `  SIDECAR_URL=http://localhost:8081\n`,
    );
    process.exitCode = EXIT.notConfigured;
    return null;
  }
  return new PyannoteSource({ baseUrl: cli.sidecarUrl });
}

/**
 * Submit, poll and reconcile, printing progress.
 *
 * Shared by `thibi diarize run` and `thibi transcribe --diarize` so the two cannot drift —
 * the second is the first, run immediately after the transcript lands.
 */
export async function diarizeRun(
  cli: CliContext,
  runId: string,
  source: DiarizationSource,
  opts: DiarizeOptions,
): Promise<void> {
  const audio = await diarizeAudioForRun(cli.ctx, runId);
  const hints: { numSpeakers?: number; minSpeakers?: number; maxSpeakers?: number } = {};
  if (opts.speakers !== undefined) hints.numSpeakers = opts.speakers;
  if (opts.minSpeakers !== undefined) hints.minSpeakers = opts.minSpeakers;
  if (opts.maxSpeakers !== undefined) hints.maxSpeakers = opts.maxSpeakers;

  // The estimate goes out *before* the wait, not after it. At S6's measured ~0.6x realtime a
  // 30-minute interview is a 49-minute wait, and a user who learns that at minute 50 has
  // been failed by the tool even though it worked.
  process.stderr.write(
    `diarize    ${source.label}  ${humanMs(audio.durationMs)} of audio` +
      (audio.durationMs > 0
        ? `  ~${humanMs(audio.durationMs / 0.6)} at S6's measured 0.6x realtime on CPU ` +
          `(unmeasured on this box)`
        : '') +
      '\n',
  );

  let lastLine = '';
  const outcome = await runDiarization(cli.ctx, {
    runId,
    jobId: audio.jobId,
    source,
    audio: { key: audio.key, durationMs: audio.durationMs },
    hints,
    onProgress: (status, elapsedMs) => {
      const pct = status.progress === undefined ? '' : ` ${Math.round(status.progress * 100)}%`;
      const line = `           ${status.state}${pct}  ${Math.round(elapsedMs / 1000)}s`;
      if (line !== lastLine) {
        process.stderr.write(`${line}\n`);
        lastLine = line;
      }
    },
  });

  if (outcome.kind === 'cancelled') {
    process.stderr.write('Diarization cancelled. The transcript is untouched.\n');
    process.exitCode = EXIT.aborted;
    return;
  }
  if (outcome.kind === 'failed') {
    // Not a failed run. The transcript persisted before this started and is still readable —
    // which is the whole point of diarize being its own pass.
    process.stderr.write(
      `Diarization failed (${outcome.code}): ${outcome.message}\n` +
        `The transcript is unaffected; re-run \`thibi diarize run ${runId}\` when fixed.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { reconciled, persisted, result } = outcome;
  process.stderr.write(
    `reconcile  ${reconciled.stats.words} words  ` +
      `${reconciled.stats.medianFlips} median flip${reconciled.stats.medianFlips === 1 ? '' : 's'}  ` +
      `${reconciled.stats.unassignedWords} unassigned\n` +
      `           ${reconciled.stats.segments} segments  ` +
      `mean purity ${reconciled.stats.meanPurity.toFixed(2)}  ` +
      `${reconciled.stats.flaggedForReview} flagged for review` +
      (reconciled.stats.segmentsByInterval > 0
        ? `\n           ${reconciled.stats.segmentsByInterval} segments had no word timings and ` +
          `were attributed by time overlap only — all flagged`
        : '') +
      `\ndone       ${(result.realtimeFactor ?? 0).toFixed(2)}x realtime  ` +
      `speakers=${result.numSpeakers}\n`,
  );
  for (const s of persisted.speakers) {
    process.stderr.write(
      `           ${s.key}  ${s.displayName ?? '(unnamed)'}  ` +
        `${s.isNew ? 'new' : 'carried across'}  (${s.rawKey})\n`,
    );
  }
  if (persisted.unmatchedPriorKeys.length > 0) {
    process.stderr.write(
      `           kept, unmatched by this run: ${persisted.unmatchedPriorKeys.join(', ')}\n`,
    );
  }
}

/**
 * A duration a person can act on.
 *
 * `(ms / 60000).toFixed(1)` printed "~0 min" for a 15-second clip in the first run of this
 * command, which is not an estimate, it is a shrug. The estimate is the one thing Phase 3
 * §6 requires be shown *before* the wait, so it has to be readable at every scale.
 */
function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
