import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { LANGUAGES } from '@thibi/languages';
import { resolveRate, type Db } from '@thibi/db';
import {
  estimateAsr,
  formatDryRun,
  loadHumanReviews,
  loadTsv,
  makeRunId,
  NoEvalSetError,
  publishRun,
  readRunlog,
  ResponseCache,
  runAsrEval,
  RunlogWriter,
  runlogPath,
  type AsrEstimate,
  type AsrRunResult,
  type PublishResult,
} from '@thibi/eval';
import { buildContext, readEnvironment } from '../context.js';
import { runNormalize } from '@thibi/engine';
import { buildProvider } from '../providers.js';

const ENGINE_VERSION = 'phase-5';

/**
 * `thibi eval` — the measurement surface.
 *
 * `--dry-run` costs nothing and downloads no audio. Without it the command spends money, so
 * it prints the estimate first and unconditionally: a run that reports its cost only
 * afterwards is a receipt, not a budget.
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
    .option('--results-dir <path>', 'where the runlog, tiers.json and reports are written', 'results')
    .option(
      '--dry-run',
      'print exact clip counts, estimated audio and estimated USD. Downloads no audio.',
    )
    .option('--budget-usd <usd>', 'stop before the call that would exceed this', Number)
    .option('--no-cache', 'ignore cached provider responses on read; still writes them')
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
      const resultsDir = String(opts['resultsDir'] ?? 'results');

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

        if (opts['dryRun']) {
          process.stdout.write(`${formatDryRun(estimates, `${provider}/${model}`)}\n`);
          return;
        }

        // Past this line, the command spends money. The estimate is printed first and
        // unconditionally: a run that reports its cost only afterwards is a receipt, not a
        // budget.
        process.stderr.write(`${formatDryRun(estimates, `${provider}/${model}`)}\n\n`);

        const built = await buildProvider({
          id: provider,
          model,
          languageCode: codes[0] ?? 'my-MM',
          settings: cli.settings,
          env: readEnvironment(),
          // The eval scores text, not timings. Requiring word timestamps here would refuse
          // the OpenAI models that only return them for some languages, and refuse them for
          // a measurement that never looks at a timestamp.
          requireWordTimestamps: false,
        });

        // Resolved once, for two callers: costing each clip, and projecting whether the
        // next clip would cross `--budget-usd`. It used to be a database query per clip
        // against a table that cannot change mid-run.
        const runRate = await maybeRate(cli.db, provider, built.model);

        // The id is minted here, not inside the run, because the runlog is named by it and
        // has to be open before the first billable call — a log that only learns the run's
        // identity at the end cannot have recorded anything on the way to a crash.
        const startedAt = cli.ctx.clock.now();
        const runId = makeRunId(startedAt, provider);
        const runlog = new RunlogWriter(runlogPath(resultsDir, runId));
        await runlog.write({
          t: 'run',
          runId,
          startedAt: startedAt.toISOString(),
          argv: process.argv.slice(2),
          engineVersion: ENGINE_VERSION,
          provider,
          model: built.model,
          split,
          n,
          baselineCode: 'my-MM',
          baselineAdded: !codes.includes('my-MM'),
        });

        const result = await runAsrEval(
          {
            now: () => cli.ctx.clock.now(),
            onEvent: (event) => runlog.write(event),
            cache: new ResponseCache(cacheDir, { read: opts['noCache'] !== true }),
            transcribe: async ({ clip, languageCode }) => {
              // Providers take a path, so each clip is written to a temp directory that
              // disposes itself. Nothing accumulates on disk between clips.
              await using tmp = await cli.ctx.tmp.dir('thibi-eval-');
              const file = join(tmp.path, clip.filename);
              await writeFile(file, clip.bytes);

              // Normalize exactly as the pipeline does, rather than posting the raw wav.
              // Not a workaround for Google's "unsupported encoding" 400 — that was only how
              // it surfaced. A CER measured on audio that never went through `runNormalize`
              // would be a number for a path no user takes: loudnorm changes what the
              // recogniser hears, so it has to be in the measurement.
              const normalized = await runNormalize(cli.ctx, file, tmp.path);
              const durationMs = wavDurationMs(clip.bytes);
              const out = await built.provider.transcribe(built.config, {
                audio: { path: normalized.flacPath },
                languageCode,
                offsetMs: 0,
                durationMs,
                model: built.model,
                logger: cli.ctx.logger,
              });
              const text = out.segments.map((s) => s.text).join(' ').trim();
              return { text, costUsd: (out.usage.audioMs / 60_000) * (runRate ?? 0) };
            },
          },
          {
            languages: codes,
            runId,
            n,
            split,
            cacheDir,
            provider,
            model: built.model,
            budgetUsd: opts['budgetUsd'] === undefined ? null : Number(opts['budgetUsd']),
            usdPerMinute: runRate,
            onProgress: (line) => process.stderr.write(`${line}\r`),
          },
        );

        await runlog.write({
          t: 'end',
          finishedAt: result.finishedAt,
          spentUsd: result.spentUsd,
          budgetExhausted: result.budgetExhausted,
        });

        process.stderr.write('\n');
        process.stdout.write(`${formatRunSummary(result)}\n`);
        process.stdout.write(`\nrunlog  ${runlogPath(resultsDir, runId)}\n`);

        if (result.budgetExhausted) {
          process.stderr.write(
            `\nBudget of $${Number(opts['budgetUsd']).toFixed(2)} reached. Partial results above; ` +
              `tiers.json is not written from a partial run — the runlog is, so ` +
              `\`thibi eval report --run ${runId}\` still works on what was measured.\n`,
          );
          process.exitCode = 3;
          return;
        }

        const published = await publishRun(resultsDir, result, ENGINE_VERSION);
        process.stdout.write(`${formatPublish(published)}\n`);
        if (published.exitCode !== 0) process.exitCode = published.exitCode;
      } finally {
        await cli.close();
      }
    });

  cmd
    .command('report')
    .description('Recompute tiers.json and the dated report from a runlog. Makes no API calls.')
    .requiredOption('--run <runId>', 'the run to re-derive from')
    .option('--results-dir <path>', 'where the runlog, tiers.json and reports live', 'results')
    .action(async (opts: Record<string, unknown>) => {
      const resultsDir = String(opts['resultsDir'] ?? 'results');
      const runId = String(opts['run']);
      const path = runlogPath(resultsDir, runId);

      // No context, no provider, no database: this command exists to be runnable with the
      // network off, which is what makes a disputed number re-derivable by someone who was
      // not there when it was measured.
      let result: AsrRunResult;
      try {
        const { current } = await loadHumanReviews(resultsDir, runId);
        result = await readRunlog(path, current);
      } catch (err) {
        process.stderr.write(
          `  cannot read runlog ${path}\n  ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${formatRunSummary(result)}\n`);
      const published = await publishRun(resultsDir, result, ENGINE_VERSION);
      process.stdout.write(`${formatPublish(published)}\n`);
      if (published.exitCode !== 0) process.exitCode = published.exitCode;
    });

  return cmd;
}

/**
 * Print what `publishRun` did. The decisions are all in `@thibi/eval`; this is the part
 * that belongs to a terminal.
 */
function formatPublish(p: PublishResult): string {
  const lines: string[] = [];
  if (p.tiersPath) lines.push(`tiers   ${p.tiersPath}`);
  lines.push(`report  ${p.reportPath}`);
  if (p.tiersPath === null) {
    const b = p.tiers.baseline;
    lines.push(
      `\nBaseline ${b.code} moved from ${b.previousCerNospace?.toFixed(3) ?? '—'} to ` +
        `${b.cerNospace?.toFixed(3) ?? '—'} — more than 25%. Every ratio in this run is against ` +
        `that baseline, so tiers.json was NOT written. The report above has the numbers; ` +
        `investigate the baseline before believing any of them.`,
    );
    return lines.join('\n');
  }
  lines.push(
    p.changes.length === 0
      ? 'no tier changes'
      : `${p.changes.length} tier change(s): ${p.changes
          .map((c) => `${c.code} ${c.from ?? '—'}→${c.to}`)
          .join(', ')}`,
  );
  return lines.join('\n');
}

/**
 * Duration from the RIFF header rather than ffprobe.
 *
 * FLEURS wavs are 16 kHz mono PCM by construction, and the harness already holds the bytes
 * in memory — shelling out to ffprobe once per clip would add a process spawn to something
 * that is a subtraction and a division. Falls back to the byte-length estimate if the header
 * is not the shape we expect, because a wrong duration must not stop a run: it is used for
 * the provider's `durationMs` and for costing, both of which the provider itself corrects in
 * `usage.audioMs`.
 */
function wavDurationMs(bytes: Buffer): number {
  const FALLBACK_BYTES_PER_MS = 32; // 16 kHz * 2 bytes, mono
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
    return Math.round(bytes.length / FALLBACK_BYTES_PER_MS);
  }
  const byteRate = bytes.readUInt32LE(28);
  const dataSize = bytes.readUInt32LE(40);
  if (byteRate === 0) return Math.round(bytes.length / FALLBACK_BYTES_PER_MS);
  return Math.round((dataSize / byteRate) * 1000);
}

/** The rate table is optional — a run without one still measures, it just cannot cost. */
async function maybeRate(db: Db | null, providerId: string, model: string): Promise<number | null> {
  if (!db) return null;
  const rate = await resolveRate(db, { providerId, model, unit: 'minute' });
  return rate?.usdPerUnit ?? null;
}

const fmt = (v: number | null, digits = 3) => (v === null ? '—' : v.toFixed(digits));

/**
 * The run summary.
 *
 * Prints `distinct` and the gender flag beside every CER, because those are what say whether
 * the number describes a language or twelve sentences read by one speaker (amendments 68).
 * A CER without its sample composition is the kind of number that gets quoted later.
 */
function formatRunSummary(r: AsrRunResult): string {
  const lines: string[] = [];
  lines.push(`run ${r.runId}`);
  lines.push(
    `  ${r.provider}/${r.model} · split ${r.split} · n=${r.n} · baseline ${r.baselineCode}` +
      (r.baselineAdded ? ' (added to this run)' : ''),
  );
  lines.push('');
  lines.push(
    'language    n  distinct      cer  cer-nosp   ci95(nosp)         wer  script  ratio  tier',
  );
  for (const l of r.languages) {
    if (l.error) {
      lines.push(`${l.languageCode.padEnd(10)}  ${l.error}`);
      continue;
    }
    if (l.cfg === null) {
      lines.push(`${l.languageCode.padEnd(10)}  no eval set`);
      continue;
    }
    const ci = l.cerCi95 ? `[${fmt(l.cerCi95[0])}, ${fmt(l.cerCi95[1])}]` : '—';
    lines.push(
      `${l.languageCode.padEnd(10)}${String(l.n).padStart(2)}` +
        `${String(l.distinctIds).padStart(10)}` +
        `${fmt(l.cer).padStart(9)}${fmt(l.cerNospace).padStart(10)}` +
        `${ci.padStart(19)}` +
        `${fmt(l.wer, 3).padStart(12)}` +
        `${fmt(l.scriptIntegrity, 2).padStart(8)}` +
        `${fmt(l.ratio, 2).padStart(7)}  ${l.tier?.tier ?? '—'}`,
    );
  }
  lines.push('');
  lines.push(`spent $${r.spentUsd.toFixed(4)}`);

  const uniform = r.languages.filter((l) => l.genderUniform && l.n > 0);
  for (const l of uniform) {
    lines.push(
      `note  ${l.languageCode}: every clip in this sample is ${Object.keys(l.genderSplit)[0]} — ` +
        `the gender split cannot show speaker concentration here, and any tier derived from ` +
        `this number inherits that limit`,
    );
  }
  const thin = r.languages.filter((l) => l.n > 0 && l.distinctIds < l.n);
  for (const l of thin) {
    lines.push(
      `note  ${l.languageCode}: ${l.n} clips cover only ${l.distinctIds} distinct sentences`,
    );
  }
  const lost = r.languages.filter((l) => l.unmatched > 0);
  for (const l of lost) {
    lines.push(`note  ${l.languageCode}: ${l.unmatched} fetched clip(s) had no reference text`);
  }
  return lines.join('\n');
}
