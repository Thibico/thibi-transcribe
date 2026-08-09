import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { LANGUAGES, type ProviderId, type ProviderLanguageCapability } from '@thibi/languages';
import { readEnv } from '../config.js';
import { CHIRP_ADAPTATION, createGoogleProbe } from '../probe/google.js';
import { createGroqProbe, createOpenAiProbe } from '../probe/whisper.js';
import { runProvider } from '../probe/run.js';
import { ProbeAbort, type ProbeProvider } from '../probe/types.js';

const DEFAULT_CLIP = 'packages/languages/fixtures/probe-2s.flac';
const DEFAULT_OUT = 'packages/languages/data/provider-matrix.json';

/** Google recognition list price, for the --dry-run estimate only. */
const GOOGLE_USD_PER_MINUTE = 0.016;

interface MatrixFile {
  _meta: { schema: number; generatedBy: string };
  providers: Record<string, unknown>;
  languages: Record<string, Partial<Record<ProviderId, ProviderLanguageCapability>>>;
}

function emptyMatrix(): MatrixFile {
  return {
    _meta: { schema: 1, generatedBy: 'thibi probe languages' },
    providers: {},
    languages: {},
  };
}

/** Sorted keys, two-space indent, trailing newline: a re-run's diff is only real change. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

export function probeLanguagesCommand(): Command {
  return new Command('languages')
    .description('Probe which language codes each provider accepts, and write the matrix')
    .option(
      '-p, --provider <id...>',
      'google | openai | groq | all (repeatable)',
      ['all'],
    )
    .option('-c, --clip <path>', 'audio clip to send', DEFAULT_CLIP)
    .option('--codes <file>', 'newline-separated codes; default is every registry key')
    .option('--concurrency <n>', 'override the per-provider default', (v) => Number.parseInt(v, 10))
    .option('--region <region>', 'Google region')
    .option('--model <model>', 'Google model')
    .option('-o, --out <path>', 'output file', DEFAULT_OUT)
    .option('--no-merge', 'discard rows for providers not probed in this run')
    .option('--dry-run', 'print the plan and the estimated cost; call nothing')
    .action(async (opts) => {
      const env = readEnv();
      const region = (opts.region as string | undefined) ?? env.googleRegion;
      const model = (opts.model as string | undefined) ?? env.googleModel;

      const requested = new Set<ProviderId>();
      for (const id of opts.provider as string[]) {
        if (id === 'all') (['google', 'openai', 'groq'] as const).forEach((p) => requested.add(p));
        else if (id === 'google' || id === 'openai' || id === 'groq') requested.add(id);
        else throw new ProbeAbort(`Unknown provider '${id}'.`);
      }

      const providers: ProbeProvider[] = [];
      if (requested.has('google')) providers.push(createGoogleProbe(env, region, model));
      if (requested.has('openai')) providers.push(createOpenAiProbe(env.openaiApiKey));
      if (requested.has('groq')) providers.push(createGroqProbe(env.groqApiKey));

      const codes = opts.codes
        ? readFileSync(resolve(opts.codes as string), 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
        : Object.keys(LANGUAGES).sort();

      const clipPath = resolve(opts.clip as string);
      if (!existsSync(clipPath)) throw new ProbeAbort(`Clip not found: ${clipPath}`);
      const clip = readFileSync(clipPath);
      const clipSha256 = createHash('sha256').update(clip).digest('hex');

      if (opts.dryRun) {
        for (const provider of providers) {
          const concurrency = (opts.concurrency as number | undefined) ?? provider.defaultConcurrency;
          const requests = codes.length * provider.models.length;
          const seconds = Math.round((requests * 1.2) / concurrency);
          const cost =
            provider.id === 'google' ? ((codes.length * 2) / 60) * GOOGLE_USD_PER_MINUTE : 0;
          process.stdout.write(
            `would send ${opts.clip} (sha256 ${clipSha256.slice(0, 8)}…) to ${codes.length} codes ` +
              `on ${provider.models.join(', ')}${provider.id === 'google' ? ` @ ${region}` : ''}\n` +
              `  concurrency ${concurrency} · worst case ${requests} requests · ` +
              `estimated wall clock ${seconds}s · estimated cost ` +
              `${cost ? `$${cost.toFixed(2)}` : 'below the reporting threshold'}\n`,
          );
        }
        return;
      }

      // Configure every provider before sending anything: a missing key must stop the run
      // now, not a third of the way through a paid sweep.
      for (const provider of providers) await provider.configure();

      const outPath = resolve(opts.out as string);
      const existing: MatrixFile =
        opts.merge && existsSync(outPath)
          ? (JSON.parse(readFileSync(outPath, 'utf8')) as MatrixFile)
          : emptyMatrix();

      const next = emptyMatrix();
      if (opts.merge) {
        next.providers = { ...existing.providers };
        for (const [code, row] of Object.entries(existing.languages)) {
          next.languages[code] = { ...row };
        }
      }

      const probedAt = new Date().toISOString().slice(0, 10);

      for (const provider of providers) {
        const concurrency = (opts.concurrency as number | undefined) ?? provider.defaultConcurrency;
        process.stderr.write(
          `\n${provider.id}: ${codes.length} codes, models ${provider.models.join(', ')}, ` +
            `concurrency ${concurrency}\n`,
        );

        const previous: Record<string, ProviderLanguageCapability | undefined> = {};
        for (const code of codes) previous[code] = existing.languages[code]?.[provider.id];

        const result = await runProvider({
          provider,
          codes,
          clip,
          concurrency,
          probedAt,
          // Never a guess: 'none' for chirp_2 is spike S1's measured verdict, and the
          // Whisper endpoints bias through `prompt`, which is a different mechanism and
          // unmeasured until Phase 4.
          adaptation: provider.id === 'google' ? CHIRP_ADAPTATION : 'prompt',
          previous,
          onProgress: (done, total, code, status) => {
            process.stderr.write(`  [${done}/${total}] ${code.padEnd(12)} ${status}\n`);
          },
        });

        for (const [code, row] of Object.entries(result.rows)) {
          next.languages[code] = { ...next.languages[code], [provider.id]: row };
        }

        next.providers[provider.id] = {
          models: provider.models,
          ...(provider.id === 'google' ? { region } : {}),
          probedAt,
          clipSha256,
          codesTried: codes.length,
          ...result.counts,
        };

        process.stderr.write(
          `${provider.id}: accepted ${result.counts.accepted}, rejected ${result.counts.rejected}, ` +
            `error ${result.counts.errored}, unknown ${result.counts.unknown}\n`,
        );
        if (result.needsReview.length) {
          process.stderr.write(`  needs human review (${result.needsReview.length}):\n`);
          for (const line of result.needsReview) process.stderr.write(`    ${line}\n`);
        }
      }

      writeFileSync(outPath, JSON.stringify(sortDeep(next), null, 2) + '\n');
      process.stderr.write(`\nwrote ${outPath}\n`);
      process.stderr.write(
        'Inspect `git diff` before committing. Any code accepted that is not already in ' +
          'data/languages.json is a gap in the seeding step, not a language to append blindly.\n',
      );
    });
}
