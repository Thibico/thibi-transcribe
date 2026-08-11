import { Command } from 'commander';
import { listSpeakers, mergeSpeakers, renameSpeaker, SpeakerNotFoundError } from '@thibi/engine';
import { buildContext } from '../context.js';
import { EXIT } from '../output.js';

const ENGINE_VERSION = '0.1.0';

/**
 * `thibi speakers` — the human half of diarization.
 *
 * Keyed by **job**, not run, because that is what `speakers` is scoped to and the reason
 * the whole of Phase 3's identity matching exists: *"Speaker 01 is Daw Khin"* is a fact
 * about the recording, so a re-transcription must not discard it. `rename` here plus a
 * second `thibi transcribe --diarize` is the demo the phase is for.
 */
export function speakersCommand(): Command {
  const command = new Command('speakers').description(
    'List, name and merge the speakers of a job',
  );

  command
    .command('list')
    .argument('<jobId>')
    .option('--run <runId>', 'count segments and share against one run rather than the whole job')
    .option('-f, --format <format>', 'text | json', 'text')
    .action(async (jobId: string, opts: { run?: string; format: string }) => {
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        if (!cli.db) throw new Error('thibi speakers needs a database.');
        const rows = await listSpeakers(cli.ctx, jobId, opts.run);
        if (rows.length === 0) {
          process.stderr.write(
            `Job ${jobId} has no speakers. Either it has not been diarized, or the job id is ` +
              `wrong — \`thibi runs show <runId>\` prints the job id of a run.\n`,
          );
          return;
        }
        if (opts.format === 'json') {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          return;
        }
        for (const s of rows) {
          const name = s.displayName ?? '(unnamed)';
          const merged = s.mergedInto ? '  [merged]' : '';
          process.stdout.write(
            `${s.key.padEnd(12)}${name.padEnd(24)}` +
              `${(s.share * 100).toFixed(0).padStart(3)}%  ` +
              `${String(s.segments).padStart(4)} segments  ` +
              `${String(s.words).padStart(6)} words${merged}\n`,
          );
        }
      } finally {
        await cli.close();
      }
    });

  command
    .command('rename')
    .argument('<jobId>')
    .argument('<key>', 'the durable key, e.g. speaker-01 — not the diarizer\'s SPEAKER_00')
    .argument('[name]', 'omit to clear the name')
    .action(async (jobId: string, key: string, name: string | undefined) => {
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        if (!cli.db) throw new Error('thibi speakers needs a database.');
        const speaker = await renameSpeaker(cli.ctx, jobId, key, name ?? null);
        process.stdout.write(
          `${speaker.key} is now ${speaker.displayName ?? '(unnamed)'}. ` +
            `It will survive the next --diarize run of this job.\n`,
        );
      } catch (err) {
        if (err instanceof SpeakerNotFoundError) {
          process.stderr.write(`${err.message}\nTry \`thibi speakers list ${jobId}\`.\n`);
          process.exitCode = EXIT.usage;
          return;
        }
        throw err;
      } finally {
        await cli.close();
      }
    });

  command
    .command('merge')
    .argument('<jobId>')
    .argument('<fromKey>', 'the speaker to retire')
    .argument('<intoKey>', 'the speaker to keep')
    .description(
      'Merge two speakers the diarizer split. The retired row is kept and marked, never ' +
        'deleted, so the merge is reversible and old turns still resolve.',
    )
    .action(async (jobId: string, fromKey: string, intoKey: string) => {
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        if (!cli.db) throw new Error('thibi speakers needs a database.');
        const out = await mergeSpeakers(cli.ctx, jobId, fromKey, intoKey);
        process.stdout.write(
          `${out.from} → ${out.into}: ${out.segmentsMoved} segments, ${out.wordsMoved} words, ` +
            `${out.turnsMoved} turns moved.\n` +
            `${out.from} is kept and marked merged, so a later diarization cannot resurrect ` +
            `the split.\n`,
        );
      } catch (err) {
        if (err instanceof SpeakerNotFoundError) {
          process.stderr.write(`${err.message}\nTry \`thibi speakers list ${jobId}\`.\n`);
          process.exitCode = EXIT.usage;
          return;
        }
        throw err;
      } finally {
        await cli.close();
      }
    });

  return command;
}
