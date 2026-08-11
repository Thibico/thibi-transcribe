import { Command } from 'commander';
import { createGoogleProvider, createGroqProvider, createOpenAiProvider, systemClock } from '@thibi/engine';
import { createRegistry, providerRows, type ProviderId, type ProviderRow } from '@thibi/languages';
import { EXIT } from '../output.js';

/**
 * `thibi providers list --language <code>`.
 *
 * The command that answers "why did it pick that one, and what would the others do?" without
 * anybody reading code. Every column here is a probed or measured fact, and the `status`
 * column carries the date it was established — the matrix is a dated snapshot, and providers
 * do widen and narrow their language lists.
 */

/**
 * Per-word confidence is a property of the running adapter, so it comes from
 * `provider.capabilities()` rather than from the registry. Spike S2 measured Google's genuine
 * — 101/101 words, 101 distinct values, and calibrated across languages — and the registry
 * cannot say so without encoding a runtime capability into static data.
 */
function wordConfidenceOf(providerId: ProviderId, model: string | null): 'yes' | 'no' | 'unknown' {
  try {
    switch (providerId) {
      case 'google':
        return createGoogleProvider({ clock: systemClock() }).capabilities(model ?? undefined)
          .wordConfidence
          ? 'yes'
          : 'no';
      case 'openai':
        return createOpenAiProvider().capabilities(model ?? undefined).wordConfidence ? 'yes' : 'no';
      case 'groq':
        return createGroqProvider().capabilities(model ?? undefined).wordConfidence ? 'yes' : 'no';
      default:
        // faster-whisper lands in Phase 4b and will be the only `yes` here that means a real
        // per-word probability rather than a segment-level likelihood.
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function render(rows: ProviderRow[]): void {
  const header = ['PROVIDER', 'MODEL', 'STATUS', 'WORD TS', 'WORD CONF'];
  const body = rows.map((row) => [
    row.providerId,
    row.model ?? '—',
    row.status,
    // A rejected code tells us nothing about whether the provider *would* have returned word
    // offsets, so it prints as absent rather than as `unknown` — which reads like a gap in
    // our probing rather than a question the probe could not ask.
    row.model === null
      ? '—'
      : row.wordTimestamps === null
        ? 'unknown'
        : row.wordTimestamps
          ? 'yes'
          : 'no',
    row.model === null ? '—' : wordConfidenceOf(row.providerId, row.model),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => pad(c, widths[i]!)).join('  ').trimEnd();

  process.stdout.write(line(header) + '\n');
  for (const row of body) process.stdout.write(line(row) + '\n');
}

export function providersCommand(): Command {
  const command = new Command('providers').description('What each provider does for a language');

  command
    .command('list')
    .description('Per-provider status for one language')
    .requiredOption('-l, --language <code>', 'language code, e.g. my, my-MM or Burmese')
    .option('--json', 'machine-readable output')
    .action((opts) => {
      const registry = createRegistry();
      const language = registry.get(opts.language as string);
      if (!language) {
        process.stderr.write(
          `Unknown language '${opts.language}'. Try \`thibi lang list\`.\n`,
        );
        process.exitCode = EXIT.usage;
        return;
      }

      const rows = providerRows(language.code);
      if (rows.length === 0) {
        process.stdout.write(
          `No provider has been probed for ${language.code}. Run \`thibi probe languages\`.\n`,
        );
        return;
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              language: language.code,
              name: language.nameEn,
              tier: language.tier,
              providers: rows.map((row) => ({
                ...row,
                wordConfidence: wordConfidenceOf(row.providerId, row.model),
              })),
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      // The tier is a property of the language, not of any one provider, so it belongs in the
      // header rather than in a column. Say how it was earned: the harness can award beta and
      // experimental on its own and can never award verified — that one is human judgement.
      process.stdout.write(
        `${language.code}  ${language.nameEn}  ·  tier ${language.tier}` +
          `${language.support.humanReviewed ? ' (human-reviewed)' : ''}\n\n`,
      );
      render(rows);

      // The reasons are the point of the command, and they do not fit in a column.
      const explained = rows.filter((r) => r.capability.reason);
      if (explained.length > 0) process.stdout.write('\n');
      for (const row of explained) {
        process.stdout.write(`${row.providerId}: ${row.capability.reason}\n`);
      }
    });

  return command;
}
