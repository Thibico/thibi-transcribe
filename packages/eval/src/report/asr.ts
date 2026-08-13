import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LANGUAGES } from '@thibi/languages';
import { THRESHOLDS, type Tier } from '../tier.js';
import type {
  HumanReview,
  TierChange,
  TiersFile,
  TiersLanguage,
  TiersRun,
} from '../results/tiers.js';

/**
 * `results/reports/asr-YYYY-MM-DD.md` — the human-readable half of a run.
 *
 * The order of the sections is the design. **Tier changes go first**, before the metadata,
 * before the table, before anything: a reader who reads only the top of the file must still
 * learn the thing that matters, which is what moved. Everything after it is the evidence for
 * that section, and a reader who stops early has stopped at the right place.
 *
 * The methodology boilerplate at the bottom is repeated verbatim in every report on purpose.
 * FLEURS is read Wikipedia sentences — clean audio, single careful speakers, no crosstalk,
 * no code-switching — so every number here overstates newsroom performance, and a caveat
 * that appears once in a doc nobody re-reads is a caveat that has stopped working.
 */

const TIER_ORDER: Tier[] = ['verified', 'beta', 'experimental', 'unsupported'];

export interface AsrReportInput {
  tiers: TiersFile;
  previous: TiersFile | null;
  changes: readonly TierChange[];
  /** Sign-offs that name an older run, listed so someone can re-review them. */
  staleReviews?: readonly HumanReview[];
}

export const reportPath = (resultsDir: string, date: string): string =>
  join(resultsDir, 'reports', `asr-${date}.md`);

export async function writeAsrReport(
  resultsDir: string,
  date: string,
  markdown: string,
): Promise<string> {
  const path = reportPath(resultsDir, date);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, 'utf8');
  return path;
}

export function renderAsrReport(input: AsrReportInput): string {
  const { tiers, previous, changes } = input;
  const date = tiers.generatedAt.slice(0, 10);
  const rows = Object.entries(tiers.languages);

  const out: string[] = [];
  out.push(`# ASR eval — ${date}`);
  out.push('');
  out.push(...tierChangesSection(changes, previous));
  out.push(...baselineBanner(tiers));
  out.push(...metadataSection(tiers, rows));
  out.push(...tableSection(rows));
  out.push(...sampleNotesSection(rows));
  out.push(...blockedSection(rows));
  out.push(...integritySection(rows));
  out.push(...staleReviewSection(input.staleReviews ?? []));
  out.push(...methodologySection(tiers));
  return `${out.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------------------

function tierChangesSection(changes: readonly TierChange[], previous: TiersFile | null): string[] {
  const out = ['## Tier changes since the last run', ''];
  if (previous === null) {
    out.push(
      `First run — there is no previous \`tiers.json\` to diff against, so every one of the ${changes.length} row(s) below is new rather than changed.`,
      '',
    );
  }
  if (changes.length === 0) {
    out.push('No tier changes.', '');
    return out;
  }
  out.push('| code | from | to | CER before | CER after | why |');
  out.push('|---|---|---|---|---|---|');
  for (const c of changes) {
    out.push(
      `| \`${c.code}\` | ${c.from ?? '—'} | **${c.to}** | ${num(c.cerBefore)} | ${num(c.cerAfter)} | ${c.why} |`,
    );
  }
  out.push('');
  return out;
}

/**
 * The baseline banner, and the reason it sits above the metadata rather than inside it.
 *
 * Every ratio in the table is against `my-MM`. A baseline that moved re-tiers every other
 * language at once, for a reason that has nothing to do with those languages, so a reader
 * has to meet that fact before the table and not in a footnote underneath it.
 */
function baselineBanner(tiers: TiersFile): string[] {
  const run = latestRun(tiers);
  if (!run?.baseline.suspect) return [];
  const { cerNospace, previousCerNospace, code } = run.baseline;
  return [
    `> **⚠ Baseline suspect.** \`${code}\` moved from ${num(previousCerNospace)} to ${num(cerNospace)}`,
    '> since the last run on this provider and model — more than the 25% that makes every ratio',
    '> below untrustworthy. `tiers.json` was **not written** from this run. Investigate the',
    '> baseline before reading anything else here.',
    '',
  ];
}

/**
 * The run that produced this report, and — since v2 — how much of the table it accounts for.
 *
 * The file accumulates across runs, so a report that only described the latest one would let
 * a reader take a carried-over row for a fresh measurement. **Naming the split is the point
 * of the "carried over" line**: it is the honest version of the warning risk 10 asked for,
 * and it is more useful than a warning because it appears on every run rather than only on a
 * shrinking one.
 */
function metadataSection(tiers: TiersFile, rows: ReadonlyArray<[string, TiersLanguage]>): string[] {
  const run = latestRun(tiers);
  if (!run) return ['## Run', '', '_No run metadata in this file._', ''];

  const fresh = rows.filter(([, r]) => r.evalRunId === run.runId).length;
  const carried = rows.length - fresh;
  const s = run.sampling;

  return [
    '## Run',
    '',
    `- **Run id** \`${run.runId}\``,
    `- **Provider / model** \`${run.provider}/${run.model}\``,
    `- **Sample** ${s.n} clips per language, \`${s.split}\` split, ${s.strategy} — deterministic, and not chosen (see *Methodology*)`,
    `- **Languages** ${rows.length} — **${fresh} measured in this run**` +
      (carried > 0
        ? `, ${carried} carried over from earlier runs (each row names its own run id and date below)`
        : ''),
    `- **Engine** \`${run.engineVersion}\``,
    `- **Baseline** \`${run.baseline.code}\` CER ${num(run.baseline.cerNospace)} over n=${run.baseline.n}, CI95 ${ci(
      run.baseline.ci95,
    )}${run.baseline.suspect ? ' — **suspect**' : ''}`,
    '',
  ];
}

const latestRun = (tiers: TiersFile): TiersRun | null =>
  tiers.runs[tiers.latestRunId] ?? null;

function tableSection(rows: ReadonlyArray<[string, TiersLanguage]>): string[] {
  const out = ['## Languages', ''];
  const byTier = new Map<Tier, Array<[string, TiersLanguage]>>();
  for (const row of rows) {
    const list = byTier.get(row[1].tier) ?? [];
    list.push(row);
    byTier.set(row[1].tier, list);
  }

  for (const tier of TIER_ORDER) {
    const list = byTier.get(tier);
    if (!list || list.length === 0) continue;
    // Sorted by ratio: the table's job is to say how far each language is from the language
    // this product already ships, and that is the ratio, not the code.
    list.sort((a, b) => (a[1].ratio ?? Number.POSITIVE_INFINITY) - (b[1].ratio ?? Number.POSITIVE_INFINITY));
    out.push(`### ${tier} (${list.length})`, '');
    // `measured` and `provider` are columns rather than a footnote because the file
    // accumulates across runs: without them a row from a sweep three months ago is
    // indistinguishable from one measured this morning.
    out.push(
      '| code | name | endonym | n | CER | CI95 | ratio | WER | script | provider | measured | reason |',
    );
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [code, r] of list) {
      const entry = LANGUAGES[code];
      out.push(
        `| \`${code}\` | ${entry?.nameEn ?? '—'} | ${entry?.endonym ?? '—'} | ${r.n} | ${num(r.cerNospace)} | ${ci(
          r.cerCi95,
        )} | ${num(r.ratio, 2)} | ${werCell(r)} | ${num(r.scriptIntegrity, 2)} | ${
          r.provider ? `${r.provider}/${r.model}` : '—'
        } | ${r.evalDate || '—'} | ${r.reason} |`,
      );
    }
    out.push('');
  }
  return out;
}

/**
 * WER is `—` for a language with no word segmentation, and the kind travels with the number
 * for the rest. An ICU-segmented WER is not comparable with a whitespace one, and a column
 * that does not say which it is invites exactly that comparison.
 */
function werCell(r: TiersLanguage): string {
  if (r.wer === null) return '— *(no word segmentation)*';
  return `${num(r.wer)} *(${r.werKind})*`;
}

/**
 * What each sample actually is, next to the number derived from it.
 *
 * `tiers.json` carries these per row and the run summary prints them, but the report is the
 * artefact a person reads and quotes from — and the standing case is the one this product
 * exists for: every clip in `my_mm/dev` is `FEMALE` (amendment 68), so a Burmese CER is a
 * measurement of female speech and any tier derived from it inherits that. A caveat held
 * only in a JSON file is a caveat that has stopped working.
 */
function sampleNotesSection(rows: ReadonlyArray<[string, TiersLanguage]>): string[] {
  const noted = rows.filter(([, r]) => r.notes.length > 0);
  if (noted.length === 0) return [];
  return [
    '## What these samples are',
    '',
    ...noted.map(([code, r]) => `- \`${code}\` — ${r.notes}`),
    '',
  ];
}

function blockedSection(rows: ReadonlyArray<[string, TiersLanguage]>): string[] {
  const blocked = rows.filter(
    ([, r]) => r.tier !== 'verified' && r.reason === 'measured' && r.blockedFromVerifiedBy.length > 0,
  );
  const out = ['## Blocked from verified', ''];
  if (blocked.length === 0) {
    out.push('Nothing measured this run is short of verified.', '');
    return out;
  }
  out.push(
    'What each language still needs. This is the work queue for human review — and the only',
    'route to `verified` is a committed sign-off in `results/human-review/<code>.json` naming',
    'this run id.',
    '',
  );
  out.push('| code | tier | blocked by |');
  out.push('|---|---|---|');
  for (const [code, r] of blocked) {
    out.push(`| \`${code}\` | ${r.tier} | ${r.blockedFromVerifiedBy.map((b) => `\`${b}\``).join(', ')} |`);
  }
  out.push('');
  return out;
}

/**
 * The section that makes the integrity check comprehensible.
 *
 * Printing `0.02` tells a reader a threshold fired. Printing
 * `ASEAN YAK SOMPHA CHHA KOO NEPI ROKKA` beside the Burmese sentence it was supposed to be
 * tells them what the provider did, and it is the difference between a number and a
 * diagnosis. Rendered verbatim, un-normalized, on both sides.
 */
function integritySection(rows: ReadonlyArray<[string, TiersLanguage]>): string[] {
  const failures = rows.filter(
    ([, r]) => r.scriptIntegrity !== null && r.scriptIntegrity < THRESHOLDS.minScriptIntegrity,
  );
  const out = ['## Script integrity failures', ''];
  if (failures.length === 0) {
    out.push(
      `No language fell below the ${THRESHOLDS.minScriptIntegrity} floor. Note that integrity is a *screen*, not a`,
      'guarantee: it catches wrong-alphabet output and scores in-script non-words 1.00.',
      '',
    );
    return out;
  }
  for (const [code, r] of failures) {
    out.push(`### \`${code}\` — integrity ${num(r.scriptIntegrity, 2)}, CER ${num(r.cerNospace)}`, '');
    if (r.example) {
      out.push('```');
      out.push(`ref: ${r.example.ref}`);
      out.push(`hyp: ${r.example.hyp}`);
      out.push('```');
    } else {
      out.push('*No example clip was retained for this language.*');
    }
    out.push('');
  }
  return out;
}

function staleReviewSection(stale: readonly HumanReview[]): string[] {
  if (stale.length === 0) return [];
  return [
    '## Sign-off stale, re-review needed',
    '',
    'These reviews name an earlier run. A sign-off is against a measurement, not against a',
    'language, so re-running the harness invalidates them — deliberate friction, since the',
    'numbers a reviewer looked at are no longer the numbers in the file.',
    '',
    ...stale.map((r) => `- \`${r.code}\` — ${r.reviewer}, ${r.reviewedAt}, against run \`${r.evalRunId}\``),
    '',
  ];
}

function methodologySection(tiers: TiersFile): string[] {
  const run = latestRun(tiers);
  const n = run?.sampling.n ?? 30;
  const split = run?.sampling.split ?? 'dev';
  return [
    '## Methodology and caveats',
    '',
    '- **FLEURS is read Wikipedia sentences.** Clean audio, single careful speakers, no',
    '  crosstalk, and no code-switching — where real Hausa, Javanese and Cebuano usage is',
    '  heavily mixed with English, Indonesian and Tagalog. **Every number here overstates',
    '  newsroom performance**, and by more for the long tail.',
    `- **The sample is the first ${n} entries of the \`${split}\` tarball**, for this run — rows`,
    '  carried over from earlier runs carry their own `n`, and every row names the date it was',
    '  measured. The tarball is ordered lexicographically over random-hash filenames, which',
    '  correlates with nothing in the data, so it is random-but-reproducible: the same request',
    '  yields the same clips on every machine. It was not chosen, and it is not stratified —',
    '  FLEURS carries no speaker id, so a single speaker could dominate a sample and nothing',
    '  here would reveal it. **Every dev split measured so far is single-gender in its**',
    '  **entirety**, so the gender column cannot stand in for that check.',
    `- **At n=${n} the interval is wide.** That is not a flaw; it is the mechanical reason`,
    '  `verified` also needs a human sign-off. Read the CI, not the point estimate.',
    '- **A tier only ever reflects the provider this product would route the language to.** A',
    '  measurement taken with any other provider is kept and listed, and cannot set a tier: a',
    '  deliberate probe of a provider we would not use is a finding about that provider, not a',
    '  fact about the language.',
    '- **Audio is normalized exactly as the product normalizes it** (`loudnorm=I=-16:TP=-1.5:LRA=11`,',
    '  16 kHz mono) before every request, because loudnorm changes what the recogniser hears and a',
    '  CER measured without it describes a path no user takes.',
    '- **CER is computed with whitespace stripped** for Burmese, Khmer, Lao and Thai, and WER is',
    '  `null` for them: a whitespace tokenizer on scriptio-continua text is not an approximate',
    '  WER, it is a different quantity.',
    '- **Script integrity is a screen, not a guarantee.** It catches wrong-alphabet output and',
    '  scores in-script non-words 1.00. Only CER can call those wrong.',
    '- **The harness can award `beta` and `experimental`. It can never award `verified`.**',
    '',
  ];
}

const num = (v: number | null, digits = 3): string => (v === null ? '—' : v.toFixed(digits));

const ci = (v: readonly [number, number] | null): string =>
  v === null ? '—' : `[${v[0].toFixed(3)}, ${v[1].toFixed(3)}]`;
