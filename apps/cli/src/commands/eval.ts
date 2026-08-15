import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { LANGUAGES } from '@thibi/languages';
import { resolveRate, type Db } from '@thibi/db';
import {
  estimateAsr,
  formatGateFailures,
  gateCleanup,
  renderCleanupReport,
  renderTranslateReport,
  runCleanupEval,
  runTranslateEval,
  writeLlmReport,
  type CleanupArm,
  type CleanupRunResult,
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
  wavDuration,
  type AsrEstimate,
  type AsrRunResult,
  type PublishResult,
} from '@thibi/eval';
import { buildContext, readEnvironment } from '../context.js';
import { runNormalize } from '@thibi/engine';
import { buildProvider } from '@thibi/runtime';
import { buildLlmComplete, isLlmProvider } from '../llm.js';

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
    .option(
      '--sample-strategy <strategy>',
      'tar-order (default, free) | id-seeded (wider prefix, seeded shuffle over sentence id)',
      'tar-order',
    )
    .option('--seed <n>', 'id-seeded only: the shuffle seed', (v) => Number.parseInt(v, 10), 1)
    .option(
      '--baseline-n <count>',
      'clips for my-MM specifically — every ratio divides by it, so its precision is inherited',
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--oversample <n>',
      'id-seeded only: how many times --n to pull before selecting',
      (v) => Number.parseInt(v, 10),
      3,
    )
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
          sampleStrategy: String(opts['sampleStrategy']) === 'id-seeded' ? 'id-seeded' : 'tar-order',
          seed: Number(opts['seed'] ?? 1),
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
              const durationMs = wavDuration(clip.bytes).ms;
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
            sampleStrategy: String(opts['sampleStrategy']) === 'id-seeded' ? 'id-seeded' : 'tar-order',
            seed: Number(opts['seed'] ?? 1),
            oversample: Number(opts['oversample'] ?? 3),
            ...(opts['baselineN'] === undefined ? {} : { baselineN: Number(opts['baselineN']) }),
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
    .command('cleanup')
    .description('Score an editorial cleanup prompt against doing nothing. No audio.')
    .requiredOption('-l, --languages <codes>', 'comma-separated language codes')
    .requiredOption(
      '-m, --models <ids>',
      'comma-separated chat model ids. Required and undefaulted: a model id this repo has ' +
        'not measured is not a default it can offer.',
    )
    .option('-p, --provider <id>', 'openai | groq', 'openai')
    .option('--arms <arms>', 'control,current,restraint', 'control,current,restraint')
    .option('-n, --n <count>', 'segments per language', (v) => Number.parseInt(v, 10), 30)
    .option('--split <split>', 'dev | test | train', 'dev')
    .option('--seed <n>', 'the sampler shuffle seed', (v) => Number.parseInt(v, 10), 1)
    .option('--cache-dir <path>', 'where FLEURS TSVs and LLM responses are cached')
    .option('--results-dir <path>', 'where the runlog and report are written', 'results')
    .option('--budget-usd <usd>', 'stop before the call that would exceed this', Number)
    .option('--gate', 'exit 2 if any arm is worse than its control or rewrites content')
    .option('--no-cache', 'ignore cached responses on read; still writes them')
    .action(async (opts: Record<string, unknown>) => {
      const codes = list(opts['languages']);
      const models = list(opts['models']);
      const arms = list(opts['arms']) as CleanupArm[];
      const provider = String(opts['provider']);
      const n = Number(opts['n']);
      const seed = Number(opts['seed'] ?? 1);
      const split = String(opts['split']) as 'dev' | 'test' | 'train';
      const cacheDir = String(opts['cacheDir'] ?? '.thibi-cache');
      const resultsDir = String(opts['resultsDir'] ?? 'results');
      const gated = opts['gate'] === true;

      const bad = arms.filter((a) => a !== 'control' && a !== 'current' && a !== 'restraint');
      if (bad.length > 0) {
        process.stderr.write(`  unknown arm(s): ${bad.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }
      if (!isLlmProvider(provider)) {
        process.stderr.write(
          `  unknown LLM provider '${provider}'. Phase 5 speaks chat-completions: openai | groq.\n`,
        );
        process.exitCode = 1;
        return;
      }

      // Printed first and unconditionally, as an upper bound: the cache is what decides how
      // many of these are billable and it is not consulted until the run. An estimate that
      // does not announce which it is, is the failure this phase exists to prevent.
      const billable = arms.filter((a) => a !== 'control').length * models.length * codes.length * n;
      process.stderr.write(
        `up to ${billable} billable call(s): ${codes.length} language(s) × ${n} segment(s) × ` +
          `${arms.filter((a) => a !== 'control').length} arm(s) × ${models.length} model(s). ` +
          `Cached responses cost nothing.\n`,
      );
      process.stderr.write(
        '`rates` carries no LLM token units, so spend is reported as $0.0000 and is ' +
          'UNMEASURED, not free. --budget-usd degrades with it.\n\n',
      );

      const now = (): Date => new Date();
      const startedAt = now();
      const runId = makeRunId(startedAt, provider);
      const runlog = new RunlogWriter(runlogPath(resultsDir, runId));
      await runlog.write({
        t: 'run',
        evalKind: 'cleanup',
        runId,
        startedAt: startedAt.toISOString(),
        argv: process.argv.slice(2),
        engineVersion: ENGINE_VERSION,
        provider,
        models,
        arms,
        split,
        n,
        seed,
      });

      const run = await runCleanupEval(
        {
          now,
          cache: new ResponseCache(cacheDir, { read: opts['noCache'] !== true }),
          onEvent: (event) => runlog.write(event),
          complete: buildLlmComplete({ provider, env: readEnvironment() }),
        },
        {
          languages: codes,
          models,
          arms,
          n,
          seed,
          split,
          cacheDir,
          provider,
          runId,
          budgetUsd: opts['budgetUsd'] === undefined ? null : Number(opts['budgetUsd']),
          onProgress: (line) => process.stderr.write(`${line}\r`),
        },
      );
      await runlog.write({
        t: 'end',
        finishedAt: run.finishedAt,
        spentUsd: run.spentUsd,
        budgetExhausted: run.budgetExhausted,
      });
      process.stderr.write('\n');

      const failures = gateCleanup(run);
      const markdown = renderCleanupReport({ run, failures, gated });
      const reportPathWritten = await writeLlmReport(
        resultsDir,
        run.finishedAt.slice(0, 10),
        'cleanup',
        markdown,
      );

      process.stdout.write(`${formatCleanupSummary(run)}\n`);
      process.stdout.write(`\nrunlog  ${runlogPath(resultsDir, runId)}\nreport  ${reportPathWritten}\n\n`);
      process.stdout.write(`${formatGateFailures(failures)}\n`);

      if (run.budgetExhausted) {
        process.exitCode = 3;
        return;
      }
      // A run that measured nothing is a failed run whether or not anyone asked for a gate.
      // Without this it exits 0 with a table of dashes, which is what a six-language run
      // that lost every language to rate limits did on 2026-08-14.
      if (run.languages.every((l) => l.arms.every((a) => a.n === 0))) {
        process.stderr.write('\nNothing was measured: every language failed or has no eval set.\n');
        process.exitCode = 1;
        return;
      }
      // Without --gate the same conditions are evaluated and printed, and the command exits
      // 0. Local iteration is not a fight; CI runs the same command with the flag.
      if (gated && failures.length > 0) process.exitCode = 2;
    });

  cmd
    .command('translate')
    .description('chrF2 against FLEURS parallel text, with a measured ceiling and bar. No audio.')
    .requiredOption('-l, --languages <codes>', 'comma-separated source language codes')
    .requiredOption('-m, --models <ids>', 'comma-separated chat model ids')
    .option('-t, --target <code>', 'target language', 'en-US')
    .option('-p, --provider <id>', 'openai | groq', 'openai')
    .option('-n, --n <count>', 'segments per language, after the join', (v) => Number.parseInt(v, 10), 30)
    .option('--split <split>', 'dev | test | train', 'dev')
    .option('--seed <n>', 'the sampler shuffle seed', (v) => Number.parseInt(v, 10), 1)
    .option('--cache-dir <path>', 'where FLEURS TSVs and LLM responses are cached')
    .option('--results-dir <path>', 'where the runlog and report are written', 'results')
    .option('--budget-usd <usd>', 'stop before the call that would exceed this', Number)
    .option('--no-cache', 'ignore cached responses on read; still writes them')
    .action(async (opts: Record<string, unknown>) => {
      const codes = list(opts['languages']);
      const models = list(opts['models']);
      const provider = String(opts['provider']);
      const target = String(opts['target']);
      const n = Number(opts['n']);
      const seed = Number(opts['seed'] ?? 1);
      const split = String(opts['split']) as 'dev' | 'test' | 'train';
      const cacheDir = String(opts['cacheDir'] ?? '.thibi-cache');
      const resultsDir = String(opts['resultsDir'] ?? 'results');

      if (!isLlmProvider(provider)) {
        process.stderr.write(`  unknown LLM provider '${provider}': openai | groq.\n`);
        process.exitCode = 1;
        return;
      }

      // The ceiling and the bar are added to every run, so the arithmetic has to count them.
      const withControls = new Set([...codes, target, 'my-MM']);
      process.stderr.write(
        `up to ${withControls.size * n * models.length} billable call(s), including the ` +
          `${target} ceiling and the my-MM bar this run measures for itself. ` +
          'Cached responses cost nothing.\n\n',
      );

      const now = (): Date => new Date();
      const startedAt = now();
      const runId = makeRunId(startedAt, provider);
      const runlog = new RunlogWriter(runlogPath(resultsDir, runId));
      await runlog.write({
        t: 'run',
        evalKind: 'translate',
        runId,
        startedAt: startedAt.toISOString(),
        argv: process.argv.slice(2),
        engineVersion: ENGINE_VERSION,
        provider,
        models,
        arms: ['translate'],
        split,
        n,
        seed,
        target,
      });

      const run = await runTranslateEval(
        {
          now,
          cache: new ResponseCache(cacheDir, { read: opts['noCache'] !== true }),
          onEvent: (event) => runlog.write(event),
          complete: buildLlmComplete({ provider, env: readEnvironment() }),
        },
        {
          languages: codes,
          models,
          target,
          n,
          seed,
          split,
          cacheDir,
          provider,
          runId,
          budgetUsd: opts['budgetUsd'] === undefined ? null : Number(opts['budgetUsd']),
          onProgress: (line) => process.stderr.write(`${line}\r`),
        },
      );
      await runlog.write({
        t: 'end',
        finishedAt: run.finishedAt,
        spentUsd: run.spentUsd,
        budgetExhausted: run.budgetExhausted,
      });
      process.stderr.write('\n');

      const markdown = renderTranslateReport(run);
      const written = await writeLlmReport(
        resultsDir,
        run.finishedAt.slice(0, 10),
        'translate',
        markdown,
      );
      process.stdout.write(`${markdown}\n`);
      process.stdout.write(`runlog  ${runlogPath(resultsDir, runId)}\nreport  ${written}\n`);
      if (run.budgetExhausted) {
        process.exitCode = 3;
        return;
      }
      if (run.languages.every((l) => l.arms.every((a) => a.scored === 0))) {
        process.stderr.write('\nNothing was measured: every language failed or has no eval set.\n');
        process.exitCode = 1;
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
    const b = p.tiers.runs[p.tiers.latestRunId]?.baseline;
    lines.push(
      `\nBaseline ${b?.code ?? 'my-MM'} moved from ${b?.previousCerNospace?.toFixed(3) ?? '—'} to ` +
        `${b?.cerNospace?.toFixed(3) ?? '—'} — more than 25%. Every ratio in this run is against ` +
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
  // The counterweight to merging: say how much of the published file this run actually
  // touched. A sweep of five languages that leaves ninety-five in place is correct now, and
  // is also exactly the situation where a reader could believe all one hundred were fresh.
  const total = Object.keys(p.tiers.languages).length;
  const fresh = Object.values(p.tiers.languages).filter(
    (l) => l.evalRunId === p.tiers.latestRunId,
  ).length;
  lines.push(
    `${total} language(s) published — ${fresh} measured by this run` +
      (total > fresh ? `, ${total - fresh} carried over from earlier runs` : ''),
  );
  return lines.join('\n');
}

const list = (value: unknown): string[] =>
  String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The cleanup run, as a terminal table.
 *
 * The control row is printed first and marked, because every other row is only meaningful
 * beside it — an arm at cer_punct 0.03 is excellent against a 0.08 control and a regression
 * against a 0.02 one, and a table that made a reader hunt for the comparison would be read
 * as absolute numbers.
 */
function formatCleanupSummary(run: CleanupRunResult): string {
  const lines: string[] = [`run ${run.runId}`];
  lines.push(
    `  ${run.provider} · models ${run.models.join(', ')} · arms ${run.arms.join(',')} · ` +
      `split ${run.split} · n=${run.n} · seed ${run.seed}`,
  );
  for (const language of run.languages) {
    lines.push('');
    if (language.error) {
      lines.push(`${language.languageCode}  ${language.error}`);
      continue;
    }
    if (language.cfg === null) {
      lines.push(`${language.languageCode}  no eval set`);
      continue;
    }
    lines.push(`${language.languageCode}  n=${language.n}  distinct=${language.distinctIds}`);
    lines.push('  arm/model            cer_punct  content_delta  entity_drift  len_delta  rewritten  failed');
    for (const arm of language.arms) {
      const label = arm.arm === 'control' ? 'control' : `${arm.arm}/${arm.model}`;
      lines.push(
        `  ${label.padEnd(20)}${fmt(arm.cerPunct).padStart(9)}` +
          `${fmt(arm.contentDelta, 4).padStart(15)}${fmt(arm.entityDrift, 4).padStart(14)}` +
          `${fmt(arm.lengthDelta, 4).padStart(11)}` +
          `${`${arm.rewritten}/${arm.n}`.padStart(11)}${String(arm.failed).padStart(8)}`,
      );
    }
  }
  lines.push('');
  lines.push(`spent $${run.spentUsd.toFixed(4)} (unmeasured while \`rates\` carries no LLM token units)`);
  return lines.join('\n');
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
    `  ${r.provider}/${r.model} · split ${r.split} · n=${r.n} · ${r.sampleStrategy}` +
      (r.sampleStrategy === 'id-seeded' ? ` seed=${r.seed}` : '') +
      ` · baseline ${r.baselineCode}` +
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
