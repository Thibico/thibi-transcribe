import { Command } from 'commander';
import { LANGUAGES } from '@thibi/languages';
import { resolveRate } from '@thibi/db';
import { estimateAsr, formatDryRun, loadTsv, NoEvalSetError, type AsrEstimate } from '@thibi/eval';
import { buildContext } from '../context.js';

const ENGINE_VERSION = 'phase-5';

/**
 * `thibi eval` — the measurement surface.
 *
 * Only `asr --dry-run` is built. The billable path is deliberately absent rather than
 * stubbed to a no-op: a command that accepts `--no-dry-run` and quietly does nothing is how
 * a sweep gets reported as "run, zero cost" by someone who did not read the source.
 */
export function evalCommand(): Command {
  const cmd = new Command('eval').description('Measure provider accuracy against FLEURS');

  cmd
    .command('asr')
    .description('Score ASR providers against FLEURS reference transcripts')
    .requiredOption('-l, --languages <codes>', 'comma-separated language codes')
    .option('-n, --n <count>', 'clips per language', (v) => Number.parseInt(v, 10), 30)
    .option('-p, --provider <id>', 'provider id', 'google')
    .option('-m, --model <id>', 'provider model', 'chirp_2')
    .option('--split <split>', 'dev | test | train', 'dev')
    .option('--cache-dir <path>', 'where FLEURS TSVs and wavs are cached')
    .option(
      '--dry-run',
      'print exact clip counts, estimated audio and estimated USD. Downloads no audio.',
    )
    .action(async (opts: Record<string, unknown>) => {
      const codes = String(opts['languages'])
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const n = Number(opts['n']);
      const provider = String(opts['provider']);
      const model = String(opts['model']);
      const split = String(opts['split']) as 'dev' | 'test' | 'train';
      const cacheDir = String(opts['cacheDir'] ?? '.thibi-cache');

      if (!opts['dryRun']) {
        process.stderr.write(
          'Only --dry-run is built. The runner, the response cache and tiers.json are Phase 5\n' +
            'work in progress; running a real sweep would spend money against providers with no\n' +
            'runlog to show for it.\n',
        );
        process.exitCode = 4;
        return;
      }

      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        const rate = cli.db
          ? await resolveRate(cli.db, { providerId: provider, model, unit: 'minute' })
          : null;
        const usdPerMinute = rate?.usdPerUnit ?? null;

        const estimates: AsrEstimate[] = [];
        for (const code of codes) {
          const entry = LANGUAGES[code];
          if (!entry) {
            process.stderr.write(`  unknown language code: ${code}\n`);
            process.exitCode = 3;
            return;
          }
          const cfg = entry.fleurs.config;
          if (cfg === null) {
            // Not an error. Five Google locales have no FLEURS set and the command must
            // still exit 0 — an eval set we do not have is a fact about FLEURS, not a fault
            // in the request.
            estimates.push(
              estimateAsr({ languageCode: code, cfg: null, rows: [], droppedRecords: 0, n, usdPerMinute }),
            );
            continue;
          }
          try {
            const { rows, dropped } = await loadTsv(cacheDir, cfg, split);
            estimates.push(
              estimateAsr({ languageCode: code, cfg, rows, droppedRecords: dropped, n, usdPerMinute }),
            );
          } catch (err) {
            if (err instanceof NoEvalSetError) {
              estimates.push(
                estimateAsr({ languageCode: code, cfg: null, rows: [], droppedRecords: 0, n, usdPerMinute }),
              );
              continue;
            }
            throw err;
          }
        }

        process.stdout.write(`${formatDryRun(estimates, `${provider}/${model}`)}\n`);
      } finally {
        await cli.close();
      }
    });

  return cmd;
}
