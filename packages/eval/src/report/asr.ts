import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LANGUAGES } from '@thibi/languages';
import { THRESHOLDS, type Tier } from '../tier.js';
import type { HumanReview, TierChange, TiersFile, TiersLanguage } from '../results/tiers.js';

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
  out.push(...metadataSection(tiers, rows.length));
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
  if (!tiers.baseline.suspect) return [];
  const { cerNospace, previousCerNospace, code } = tiers.baseline;
  return [
    `> **⚠ Baseline suspect.** \`${code}\` moved from ${num(previousCerNospace)} to ${num(cerNospace)}`,
    '> between runs — more than the 25% that makes every ratio below untrustworthy. `tiers.json`',
    '> was **not written** from this run. Investigate the baseline before reading anything else here.',
    '',
  ];
}

function metadataSection(tiers: TiersFile, languageCount: number): string[] {
  const b = tiers.baseline;
  return [
    '## Run',
    '',
    `- **Run id** \`${tiers.runId}\``,
    `- **Provider / model** \`${b.provider}/${b.model}\``,
    `- **Sample** ${tiers.sampling.n} clips per language, \`${tiers.sampling.split}\` split, ${tiers.sampling.strategy} — deterministic, and not chosen (see *Methodology*)`,
    `- **Languages** ${languageCount}`,
    `- **Engine** \`${tiers.engineVersion}\``,
    `- **Baseline** \`${b.code}\` CER ${num(b.cerNospace)} over n=${b.n}, CI95 ${ci(b.ci95)}${
      b.suspect ? ' — **suspect**' : ''
    }`,
    '',
  ];
}

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
    out.push('| code | name | endonym | n | CER | CI95 | ratio | WER | script | reason |');
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const [code, r] of list) {
      const entry = LANGUAGES[code];
      out.push(
        `| \`${code}\` | ${entry?.nameEn ?? '—'} | ${entry?.endonym ?? '—'} | ${r.n} | ${num(r.cerNospace)} | ${ci(
          r.cerCi95,
        )} | ${num(r.ratio, 2)} | ${werCell(r)} | ${num(r.scriptIntegrity, 2)} | ${r.reason} |`,
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
  return [
    '## Methodology and caveats',
    '',
    '- **FLEURS is read Wikipedia sentences.** Clean audio, single careful speakers, no',
    '  crosstalk, and no code-switching — where real Hausa, Javanese and Cebuano usage is',
    '  heavily mixed with English, Indonesian and Tagalog. **Every number here overstates',
    '  newsroom performance**, and by more for the long tail.',
    `- **The sample is the first ${tiers.sampling.n} entries of the \`${tiers.sampling.split}\` tarball**, which is`,
    '  ordered lexicographically over random-hash filenames. It correlates with nothing in the',
    '  data, so it is random-but-reproducible: the same request yields the same clips on every',
    '  machine. It was not chosen, and it is not stratified — FLEURS dev carries no speaker id,',
    '  so a single speaker could dominate a sample and nothing here would reveal it.',
    `- **At n=${tiers.sampling.n} the interval is wide.** That is not a flaw; it is the mechanical reason`,
    '  `verified` also needs a human sign-off. Read the CI, not the point estimate.',
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
