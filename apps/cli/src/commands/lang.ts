import { Command } from 'commander';
import {
  createRegistry,
  type LanguageFilter,
  type ProviderId,
  type ResolvedLanguage,
  type Tier,
} from '@thibi/languages';

const TIERS = ['verified', 'beta', 'experimental', 'unsupported'] as const;
const PROVIDERS = ['google', 'openai', 'groq', 'faster-whisper'] as const;

function assertTier(value: string): Tier {
  if (!(TIERS as readonly string[]).includes(value)) {
    throw new Error(`Unknown tier '${value}'. Expected one of ${TIERS.join(', ')}.`);
  }
  return value as Tier;
}

function assertProvider(value: string): ProviderId {
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`Unknown provider '${value}'. Expected one of ${PROVIDERS.join(', ')}.`);
  }
  return value as ProviderId;
}

/** Pad by display intent. Endonyms in complex scripts do not have a useful column width. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function supportedProviders(language: ResolvedLanguage): string[] {
  return (Object.keys(language.providers) as ProviderId[])
    .filter((p) => language.providers[p]?.supported)
    .sort();
}

function printTable(languages: ResolvedLanguage[]): void {
  const rows = languages.map((l) => [
    l.code,
    l.nameEn,
    l.endonym ?? '—',
    l.script,
    l.direction,
    l.tier,
    supportedProviders(l).join(',') || '—',
  ]);
  const header = ['CODE', 'NAME', 'ENDONYM', 'SCRIPT', 'DIR', 'TIER', 'PROVIDERS'];
  // Endonym is excluded from width computation: complex-script glyph counts do not
  // predict terminal columns, and padding to them wrecks the alignment of everything
  // after it. A fixed gutter is more readable than a wrong measurement.
  const widths = header.map((h, i) =>
    i === 2 ? 0 : Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );

  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 2 ? c + '  ' : pad(c, widths[i]!))).join('  ').trimEnd();

  process.stdout.write(line(header) + '\n');
  for (const row of rows) process.stdout.write(line(row) + '\n');
  process.stdout.write(`${rows.length} language${rows.length === 1 ? '' : 's'}\n`);
}

function printDetail(language: ResolvedLanguage): void {
  const out = process.stdout;
  const s = language.scriptEntry;
  out.write(`${language.code}  ${language.nameEn}  ${language.endonym ?? '—'}\n`);
  if (language.altNames.length) out.write(`  also        ${language.altNames.join(' · ')}\n`);
  out.write(
    `  script      ${s.code} (${s.direction}${s.complex ? ', complex' : ''})` +
      `   clusters ${s.clusters}` +
      (language.altScripts.length ? `   also written in ${language.altScripts.join(', ')}` : '') +
      '\n',
  );
  out.write(
    `  typography  ${language.typography.fontFamily ?? 'system default'} · ` +
      `line-height ${language.typography.lineHeight} · min ${language.typography.minFontPx}px\n`,
  );
  out.write(
    `  text        segmentation ${language.text.wordSegmentation} · ` +
      `normalizers ${language.text.normalizers.join(',')} · ` +
      `${language.text.reportWer ? 'WER reported' : 'WER not comparable, reported as null'}` +
      `${language.text.zawgyiApplies ? ' · zawgyi conversion applies' : ''}\n`,
  );
  out.write(
    `  subtitle    ${language.subtitle.cpsMax} cps · ` +
      `${language.subtitle.charsPerLineMax} chars/line · ${language.subtitle.maxLines} lines · ` +
      `break by ${language.subtitle.lineBreak}\n`,
  );
  out.write(`  fleurs      ${language.fleurs.config ?? 'none — no eval set for this language'}\n`);

  const support = language.support;
  // Rounded, because these are floats now that a real eval writes them: the first measured
  // run printed `CER 0.06431302001349225`, seventeen digits of which fifteen are noise from
  // a 30-clip sample whose interval is ±0.017.
  const measured =
    support.cer === null
      ? 'unmeasured'
      : `CER ${support.cer.toFixed(3)}` +
        `${support.cerRatio ? ` (${support.cerRatio.toFixed(2)}× baseline)` : ''}` +
        `${support.evalN ? ` on ${support.evalN} clips` : ''}` +
        `${support.evalDate ? `, ${support.evalDate}` : ''}`;
  out.write(
    `  tier        ${language.tier} (${measured}) · from ${language.tierSource}` +
      `${language.enabled ? '' : ' · disabled'}\n`,
  );
  if (support.notes) out.write(`  notes       ${support.notes}\n`);

  const providerIds = (Object.keys(language.providers) as ProviderId[]).sort();
  if (providerIds.length === 0) {
    out.write('  providers   none probed yet — run `thibi probe languages`\n');
  } else {
    out.write('  providers\n');
    for (const id of providerIds) {
      const c = language.providers[id]!;
      const words =
        c.wordTimestamps === null ? 'word timings unknown' : c.wordTimestamps ? 'word timings' : 'no word timings';
      out.write(
        `    ${pad(id, 8)} ${c.status}` +
          `${c.supported ? '' : ' (not supported)'} · ${c.verdict} · sends '${c.providerCode}'` +
          `${c.models ? ` · ${c.models.join(', ')}` : ''} · ${words} · adaptation ${c.adaptation}` +
          ` · ${c.probedAt}\n`,
      );
      if (c.reason) out.write(`             ${c.reason}\n`);
      if (c.evidence) out.write(`             evidence: ${c.evidence}\n`);
    }
  }
}

export function langCommand(): Command {
  const lang = new Command('lang').description('Inspect the language registry');

  lang
    .command('list')
    .description('List languages, optionally filtered')
    .option('-t, --tier <tier...>', 'verified | beta | experimental | unsupported')
    .option('-p, --provider <id>', 'languages this provider supports')
    .option('-x, --exclusive-to <id>', 'supported by this provider and by no other')
    .option('-n, --not-supported-by <id>', 'exclude languages this provider supports')
    .option('-s, --script <iso15924>', 'e.g. Arab, Mymr, Latn')
    .option('--enabled-only', 'hide languages an admin has disabled')
    .option('--json', 'emit JSON instead of a table')
    .action((opts) => {
      const filter: LanguageFilter = {};
      if (opts.tier) filter.tier = (opts.tier as string[]).map(assertTier);
      if (opts.provider) filter.provider = assertProvider(opts.provider as string);
      if (opts.exclusiveTo) filter.exclusiveTo = assertProvider(opts.exclusiveTo as string);
      if (opts.notSupportedBy) filter.notSupportedBy = assertProvider(opts.notSupportedBy as string);
      if (opts.script) filter.script = opts.script as string;
      if (opts.enabledOnly) filter.enabledOnly = true;

      const languages = createRegistry().list(filter);
      if (opts.json) process.stdout.write(JSON.stringify(languages, null, 2) + '\n');
      else printTable(languages);
    });

  lang
    .command('show <code>')
    .description('Everything the registry knows about one language')
    .option('--json', 'emit JSON instead of a summary')
    .action((code: string, opts) => {
      const language = createRegistry().get(code);
      if (!language) {
        process.stderr.write(
          `Unknown language '${code}'. Try \`thibi lang list\`, or an ISO code, English ` +
            `name or endonym — the registry accepts all three.\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (opts.json) process.stdout.write(JSON.stringify(language, null, 2) + '\n');
      else printDetail(language);
    });

  return lang;
}
