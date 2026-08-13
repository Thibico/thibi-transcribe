import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LANGUAGES } from '@thibi/languages';
import type { AsrRunResult, LanguageResult } from '../runner.js';
import type { Tier, TierReason } from '../tier.js';

/**
 * `results/tiers.json` — the file that turns a measurement into a claim the product makes.
 *
 * It is the only route by which a CER reaches a user: `packages/languages` reads it at build
 * time and `/settings/languages` renders it. That is why three things here are stricter than
 * they look:
 *
 * - **`reason` is an enum, not prose.** "Not yet measured" and "measured and bad" must never
 *   render the same, and a UI cannot branch on a sentence.
 * - **A partial run writes nothing.** A budget-exhausted sweep has real numbers for the
 *   languages it reached and silence for the rest; merging those into the previous file
 *   would produce a document whose rows come from two different runs with one `runId` at
 *   the top saying otherwise.
 * - **A drifting baseline is a hard stop.** Every ratio in the file is against `my-MM`, so a
 *   baseline that moved re-tiers every other language at once, in a direction that has
 *   nothing to do with those languages. Catching it is worth refusing to write.
 */

export const TIERS_SCHEMA_VERSION = 1;

/** How far the baseline may move between runs before the file is refused. §5.9. */
export const BASELINE_DRIFT_LIMIT = 0.25;

export interface HumanReview {
  code: string;
  reviewer: string;
  reviewedAt: string;
  /** The run this sign-off is against. A review of a *language* would never go stale. */
  evalRunId: string;
  clipsReviewed: number;
  verdict: 'pass' | 'fail';
  nativeSpeaker: boolean;
  notes?: string;
}

export interface TiersLanguage {
  tier: Tier;
  reason: TierReason;
  provider: string | null;
  model: string | null;
  n: number;
  clipSeconds: number;
  genderSplit: Record<string, number>;
  /** One value across n rows is a finding, not a column — amendment 68. */
  genderUniform: boolean;
  distinctIds: number;
  cer: number | null;
  cerNospace: number | null;
  cerCi95: readonly [number, number] | null;
  wer: number | null;
  werKind: 'spaces' | 'icu' | null;
  ratio: number | null;
  scriptIntegrity: number | null;
  evalRunId: string;
  evalDate: string;
  /** The worst clip of the sample, un-normalized, so a bad row can be looked at. */
  example: { id: number; ref: string; hyp: string } | null;
  humanReview: HumanReview | null;
  blockedFromVerifiedBy: string[];
  notes: string;
}

export interface TiersFile {
  schemaVersion: number;
  generatedAt: string;
  runId: string;
  engineVersion: string;
  sampling: { strategy: 'tar-order'; split: string; n: number; deterministic: true };
  baseline: {
    code: string;
    provider: string;
    model: string;
    cerNospace: number | null;
    n: number;
    ci95: readonly [number, number] | null;
    /** True when this run's baseline moved more than 25% from the previous file's. */
    suspect: boolean;
    previousCerNospace: number | null;
  };
  languages: Record<string, TiersLanguage>;
}

export interface BuildTiersInput {
  run: AsrRunResult;
  engineVersion: string;
  /** The file this run is replacing, for baseline drift. Null on the first ever run. */
  previous: TiersFile | null;
  humanReviews?: Readonly<Record<string, HumanReview>>;
}

export function buildTiersFile(input: BuildTiersInput): TiersFile {
  const { run, engineVersion, previous } = input;
  const reviews = input.humanReviews ?? {};
  const baseline = run.languages.find((l) => l.languageCode === run.baselineCode);
  const previousBaseline = previous?.baseline.cerNospace ?? null;
  const evalDate = run.finishedAt.slice(0, 10);

  const languages: Record<string, TiersLanguage> = {};
  for (const l of run.languages) {
    // A language the run never reached has no row. An absent row and a row saying
    // `not-run` are different claims, and only the second one is a measurement's output.
    if (l.error !== undefined) continue;
    languages[l.languageCode] = toRow(l, run, evalDate, reviews[l.languageCode] ?? null);
  }

  return {
    schemaVersion: TIERS_SCHEMA_VERSION,
    generatedAt: run.finishedAt,
    runId: run.runId,
    engineVersion,
    sampling: { strategy: 'tar-order', split: run.split, n: run.n, deterministic: true },
    baseline: {
      code: run.baselineCode,
      provider: run.provider,
      model: run.model,
      cerNospace: baseline?.cerNospace ?? null,
      n: baseline?.n ?? 0,
      ci95: baseline?.cerCi95 ?? null,
      suspect: baselineSuspect(baseline?.cerNospace ?? null, previousBaseline),
      previousCerNospace: previousBaseline,
    },
    languages,
  };
}

/**
 * Has the baseline moved enough to distrust every ratio in the file?
 *
 * Relative to the *previous* value, because that is the number the last file's ratios were
 * computed against. A first run has nothing to drift from and is never suspect — which is
 * not the same as being trustworthy, and is why the report prints the baseline either way.
 */
export function baselineSuspect(current: number | null, previous: number | null): boolean {
  if (current === null || previous === null || previous === 0) return false;
  return Math.abs(current - previous) / previous > BASELINE_DRIFT_LIMIT;
}

function toRow(
  l: LanguageResult,
  run: AsrRunResult,
  evalDate: string,
  review: HumanReview | null,
): TiersLanguage {
  const measured = l.cfg !== null && l.n > 0;
  return {
    tier: l.tier?.tier ?? 'experimental',
    reason: l.tier?.reason ?? 'not-run',
    provider: measured ? run.provider : null,
    model: measured ? run.model : null,
    n: l.n,
    clipSeconds: l.clipSeconds,
    genderSplit: l.genderSplit,
    genderUniform: l.genderUniform,
    distinctIds: l.distinctIds,
    cer: l.cer,
    cerNospace: l.cerNospace,
    cerCi95: l.cerCi95,
    wer: l.wer,
    werKind: l.werKind,
    ratio: l.ratio,
    scriptIntegrity: l.scriptIntegrity,
    evalRunId: run.runId,
    evalDate,
    example: l.example,
    humanReview: review,
    blockedFromVerifiedBy: l.tier?.blockedFromVerifiedBy ?? ['not-run'],
    notes: noteFor(l),
  };
}

/**
 * The caveat that has to travel with the number.
 *
 * Not decoration: `my-MM`'s only measurement is female-only (all 380 rows of `my_mm/dev`
 * are `FEMALE`, amendment 68) and a tier row that does not say so is a language-level claim
 * made from one speaker gender. The five non-FLEURS Google locales get the other standing
 * note, because "we have no eval set" is the single most misreadable state in the file.
 */
function noteFor(l: LanguageResult): string {
  if (l.cfg === null) {
    return 'No FLEURS config for this language. Not measured, which is not the same as measured and poor — supply --manifest to measure it.';
  }
  const notes: string[] = [];
  if (l.genderUniform && l.n > 0) {
    const only = Object.keys(l.genderSplit)[0] ?? 'one gender';
    notes.push(`Every clip in this sample is ${only}; the split cannot show speaker concentration.`);
  }
  if (l.n > 0 && l.distinctIds < l.n) {
    notes.push(`${l.n} clips cover ${l.distinctIds} distinct sentences.`);
  }
  if (l.unmatched > 0) {
    notes.push(`${l.unmatched} fetched clip(s) had no reference text and were dropped.`);
  }
  return notes.join(' ');
}

// ---------------------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------------------

export const tiersPath = (resultsDir: string): string => join(resultsDir, 'tiers.json');

/** The previous file, or null when there is none. A missing file is a first run, not an error. */
export async function readTiersFile(resultsDir: string): Promise<TiersFile | null> {
  try {
    return JSON.parse(await readFile(tiersPath(resultsDir), 'utf8')) as TiersFile;
  } catch {
    return null;
  }
}

export async function writeTiersFile(resultsDir: string, file: TiersFile): Promise<string> {
  const path = tiersPath(resultsDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Committed sign-offs from `results/human-review/<code>.json`, filtered to this run.
 *
 * A review names the run it was made against, and only that run's reviews count. Re-running
 * the harness therefore invalidates every sign-off, which is deliberate friction: `verified`
 * is a claim about a measurement, and the measurement just changed.
 */
export async function loadHumanReviews(
  resultsDir: string,
  runId: string,
): Promise<{ current: Record<string, HumanReview>; stale: HumanReview[] }> {
  const dir = join(resultsDir, 'human-review');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { current: {}, stale: [] };
  }

  const current: Record<string, HumanReview> = {};
  const stale: HumanReview[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let review: HumanReview;
    try {
      review = JSON.parse(await readFile(join(dir, name), 'utf8')) as HumanReview;
    } catch {
      continue;
    }
    if (!review.code || !LANGUAGES[review.code]) continue;
    // A failing review is not a sign-off. It stays out of `current` so it cannot unlock
    // `verified`, and out of `stale` so the report does not ask anyone to redo it.
    if (review.verdict !== 'pass') continue;
    if (review.evalRunId === runId) current[review.code] = review;
    else stale.push(review);
  }
  return { current, stale };
}

export interface TierChange {
  code: string;
  from: Tier | null;
  to: Tier;
  cerBefore: number | null;
  cerAfter: number | null;
  why: string;
}

/**
 * What moved since the last file — the first thing the report prints.
 *
 * A new language is a change (`from: null`); a language that disappeared from the run is
 * not, because a sweep that did not measure Hausa has said nothing about Hausa.
 */
export function diffTiers(previous: TiersFile | null, next: TiersFile): TierChange[] {
  const changes: TierChange[] = [];
  for (const [code, row] of Object.entries(next.languages)) {
    const before = previous?.languages[code] ?? null;
    if (before && before.tier === row.tier) continue;
    changes.push({
      code,
      from: before?.tier ?? null,
      to: row.tier,
      cerBefore: before?.cerNospace ?? null,
      cerAfter: row.cerNospace,
      why: whyChanged(before?.tier ?? null, row),
    });
  }
  return changes.sort((a, b) => a.code.localeCompare(b.code, 'en'));
}

function whyChanged(from: Tier | null, row: TiersLanguage): string {
  if (from === null) return `first measurement — ${row.reason}`;
  if (row.reason === 'script-integrity') return 'script integrity below the floor';
  if (row.reason === 'no-eval-set') return 'no eval set for this language';
  if (row.blockedFromVerifiedBy.length > 0) return `blocked by ${row.blockedFromVerifiedBy.join(', ')}`;
  return 'cleared every verified gate';
}
