import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chooseProvider, LANGUAGES } from '@thibi/languages';
import type { AsrRunResult, LanguageResult } from '../runner.js';
import { assignTier, type Tier, type TierReason } from '../tier.js';

/**
 * `results/tiers.json` — the file that turns a measurement into a claim the product makes.
 *
 * It is the only route by which a CER reaches a user: `packages/languages` reads it at build
 * time and `/settings/languages` renders it. That is why four things here are stricter than
 * they look:
 *
 * - **`reason` is an enum, not prose.** "Not yet measured" and "measured and bad" must never
 *   render the same, and a UI cannot branch on a sentence.
 * - **A partial run writes nothing.** A budget-exhausted sweep has real numbers for the
 *   languages it reached and silence for the rest, and half a sweep is not a state anything
 *   downstream should have to reason about.
 * - **A drifting baseline is a hard stop.** Every ratio in a run is against `my-MM`, so a
 *   baseline that moved re-tiers every language measured against it at once, in a direction
 *   that has nothing to do with those languages.
 * - **A measurement taken with a provider the product would not choose never sets a tier.**
 *   See `deriveLanguages`. This is the rule that stops a deliberate Groq probe demoting
 *   Burmese.
 *
 * ## Why v2 merges
 *
 * v1 wrote one row per language *in the current run*, so a five-language sweep after a
 * hundred-language one published five rows and silently dropped ninety-five — the file the
 * registry compiles in, rewritten to say nothing about languages nobody had re-measured.
 * Risk 10.
 *
 * The fix is not "merge the rows", because a row carries a run's sampling context and a
 * baseline, and rows from two runs under one header is a document that lies in a different
 * way. Instead the file separates the three things v1 had conflated:
 *
 * | key | what it is | merged? |
 * |---|---|---|
 * | `runs` | per-run context: provider, model, split, n, baseline, sampling | accumulated |
 * | `measurements` | one entry per `code\|provider\|model`, the raw measured numbers | accumulated, newest run wins |
 * | `languages` | one row per language — the claim the product makes | **derived, never merged** |
 *
 * `languages` is recomputed from `measurements` on every publish, so it is a pure function of
 * the evidence and can never drift from it. Deleting it and republishing yields the same file.
 */

/** Bumped to 2 on 2026-08-13: `runs` + `measurements` + derived `languages`. */
export const TIERS_SCHEMA_VERSION = 2;

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
  /** The provider this row's numbers came from. Null when nothing usable was measured. */
  provider: string | null;
  model: string | null;
  /**
   * The provider this product *would* route the language to, per `chooseProvider`.
   *
   * Equal to `provider` on any row carrying a tier — that is the rule `deriveLanguages`
   * enforces. It differs only on a `not-run` row, where it says which provider a measurement
   * would have to come from before this language can claim anything.
   */
  chosenProvider: string | null;
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
  /** The split this row was measured on, resolved through `runs[evalRunId]`. */
  split: string | null;
  /** The worst clip of the sample, un-normalized, so a bad row can be looked at. */
  example: { id: number; ref: string; hyp: string } | null;
  humanReview: HumanReview | null;
  blockedFromVerifiedBy: string[];
  /**
   * Every other provider this language has been measured on — kept because "Groq is
   * unusable for Burmese" is a finding worth having, and deliberately unable to set a tier.
   */
  otherProviders: Array<{
    provider: string;
    model: string;
    tier: Tier;
    cerNospace: number | null;
    runId: string;
  }>;
  notes: string;
}

/** One run's context. Every measurement resolves its sampling and baseline through this. */
export interface TiersRun {
  runId: string;
  engineVersion: string;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  sampling: {
    strategy: 'tar-order' | 'id-seeded';
    split: string;
    n: number;
    /** Both strategies are reproducible; `id-seeded` needs the seed to be so. */
    deterministic: true;
    seed: number;
  };
  baseline: {
    code: string;
    cerNospace: number | null;
    n: number;
    ci95: readonly [number, number] | null;
    /** True when this run's baseline moved more than 25% from the previous run's. */
    suspect: boolean;
    previousCerNospace: number | null;
  };
}

/**
 * One measurement: a language, under one provider and model, in one run.
 *
 * This is the evidence layer, and it is append-mostly — a later run replaces the entry for
 * the same `code|provider|model` and touches nothing else. Everything a `TiersLanguage`
 * asserts is derived from here, so nothing is ever lost by publishing a narrow sweep.
 */
export interface TiersMeasurement {
  code: string;
  provider: string;
  model: string;
  runId: string;
  evalDate: string;
  tier: Tier;
  reason: TierReason;
  n: number;
  clipSeconds: number;
  genderSplit: Record<string, number>;
  genderUniform: boolean;
  distinctIds: number;
  cer: number | null;
  cerNospace: number | null;
  cerCi95: readonly [number, number] | null;
  wer: number | null;
  werKind: 'spaces' | 'icu' | null;
  ratio: number | null;
  scriptIntegrity: number | null;
  /** The worst clip of the sample, un-normalized, so a bad row can be looked at. */
  example: { id: number; ref: string; hyp: string } | null;
  blockedFromVerifiedBy: string[];
  notes: string;
}

export interface TiersFile {
  schemaVersion: number;
  generatedAt: string;
  /** The run that last updated this file. Individual rows name their own. */
  latestRunId: string;
  runs: Record<string, TiersRun>;
  measurements: Record<string, TiersMeasurement>;
  /** Derived from `measurements` on every publish. Never merged, never hand-edited. */
  languages: Record<string, TiersLanguage>;
}

/** `code|provider|model` — the identity of a measurement. */
export const measurementKey = (code: string, provider: string, model: string): string =>
  `${code}|${provider}|${model}`;

export interface BuildTiersInput {
  run: AsrRunResult;
  engineVersion: string;
  /** The file this run updates. Null on the first ever run. */
  previous: TiersFile | null;
  humanReviews?: Readonly<Record<string, HumanReview>>;
}

export function buildTiersFile(input: BuildTiersInput): TiersFile {
  const { run, engineVersion, previous } = input;
  const reviews = input.humanReviews ?? {};
  const baselineResult = run.languages.find((l) => l.languageCode === run.baselineCode);
  const previousBaseline = previousBaselineFor(previous, run);
  const evalDate = run.finishedAt.slice(0, 10);

  const thisRun: TiersRun = {
    runId: run.runId,
    engineVersion,
    provider: run.provider,
    model: run.model,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    sampling: {
      strategy: run.sampleStrategy,
      split: run.split,
      n: run.n,
      deterministic: true,
      seed: run.seed,
    },
    baseline: {
      code: run.baselineCode,
      cerNospace: baselineResult?.cerNospace ?? null,
      n: baselineResult?.n ?? 0,
      ci95: baselineResult?.cerCi95 ?? null,
      suspect: baselineSuspect(baselineResult?.cerNospace ?? null, previousBaseline),
      previousCerNospace: previousBaseline,
    },
  };

  // Accumulate. A run contributes what it measured and disturbs nothing else — which is the
  // whole of risk 10, and the reason the header can no longer be a single run's metadata.
  const measurements: Record<string, TiersMeasurement> = { ...(previous?.measurements ?? {}) };
  for (const l of run.languages) {
    // A language the run never reached contributes nothing. An absent measurement and one
    // saying `not-run` are different claims, and only the second is a measurement's output.
    if (l.error !== undefined) continue;
    measurements[measurementKey(l.languageCode, run.provider, run.model)] = toMeasurement(
      l,
      run,
      evalDate,
    );
  }

  const runs: Record<string, TiersRun> = { ...(previous?.runs ?? {}), [run.runId]: thisRun };

  return {
    schemaVersion: TIERS_SCHEMA_VERSION,
    generatedAt: run.finishedAt,
    latestRunId: run.runId,
    runs,
    measurements,
    languages: deriveLanguages(measurements, runs, reviews),
  };
}

/**
 * The baseline to compare drift against: the last run that measured **the same thing** —
 * same provider, model, split, sample size and sampling strategy.
 *
 * Drift means "this measurement moved", so everything that defines the measurement has to
 * match or the alarm fires on changes that are not drift. Two of those were found by firing
 * it: a Groq baseline against a Google one, and — measured 2026-08-13 — switching
 * `--sample-strategy` from `tar-order` to `id-seeded`, which moved `my-MM` from 0.064 to
 * 0.084 and blocked the publish with a warning about a baseline that had not drifted at all.
 * An alarm that cries wolf on a deliberate, documented action is an alarm that gets ignored
 * on the day it is right.
 *
 * The cost is real and worth stating: change `--n` or the strategy and this run has nothing
 * comparable to check against, so the drift guard is silent for it. That is the honest
 * behaviour — there is no previous measurement of this thing — but it does mean a strategy
 * change is a good moment to look at the baseline yourself.
 */
function previousBaselineFor(previous: TiersFile | null, run: AsrRunResult): number | null {
  if (!previous) return null;
  const candidates = Object.values(previous.runs)
    .filter(
      (r) =>
        r.provider === run.provider &&
        r.model === run.model &&
        r.sampling.split === run.split &&
        r.sampling.n === run.n &&
        r.sampling.strategy === run.sampleStrategy,
    )
    .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
  return candidates[0]?.baseline.cerNospace ?? null;
}

/**
 * Turn the evidence into the claim — the one function that decides what a language's tier is.
 *
 * **A measurement only sets a tier if it was taken with the provider the product would
 * actually use for that language.** `chooseProvider` answers that, and it is the same
 * function the CLI and the Phase 11 picker call, so the tier describes what a user will
 * actually get rather than what some sweep happened to point at.
 *
 * Without this rule the file has a trapdoor: deliberately measuring `my-MM` on Groq — which
 * the project does, because reproducing that failure on demand is worth a flag — would
 * publish Groq's romanized non-words as Burmese's tier and mark the product's best language
 * unsupported. The Groq numbers are still kept, in `measurements` and on the row's
 * `otherProviders`, because "Groq is unusable for Burmese" is a finding worth having; it is
 * simply not a fact about Burmese.
 *
 * Where the chosen provider has no measurement, the language is reported `not-run` however
 * many other providers have been measured, because a CER from a provider we would not route
 * to says nothing about what the user would receive.
 */
export function deriveLanguages(
  measurements: Readonly<Record<string, TiersMeasurement>>,
  runs: Readonly<Record<string, TiersRun>>,
  reviews: Readonly<Record<string, HumanReview>> = {},
): Record<string, TiersLanguage> {
  const byCode = new Map<string, TiersMeasurement[]>();
  for (const m of Object.values(measurements)) {
    const list = byCode.get(m.code) ?? [];
    list.push(m);
    byCode.set(m.code, list);
  }

  const languages: Record<string, TiersLanguage> = {};
  for (const [code, all] of byCode) {
    const choice = chooseProvider(code);
    const chosen = choice
      ? all.find((m) => m.provider === choice.providerId && (choice.model === null || m.model === choice.model)) ??
        all.find((m) => m.provider === choice.providerId)
      : undefined;

    const others = all
      .filter((m) => m !== chosen)
      .map((m) => ({
        provider: m.provider,
        model: m.model,
        tier: m.tier,
        cerNospace: m.cerNospace,
        runId: m.runId,
      }));

    if (!chosen) {
      languages[code] = notRunRow(code, choice?.providerId ?? null, others, all);
      continue;
    }

    // A sign-off is against a measurement, so it counts only when it names the run that
    // produced the row it would promote.
    const review = reviews[code];
    const applicable = review && review.evalRunId === chosen.runId ? review : null;

    /**
     * Re-run `assignTier` rather than adjusting the stored tier.
     *
     * The measurement was tiered during the run, when no sign-off could exist — so its
     * `tier` is the best the harness can award on its own and its blockers always include
     * `humanReview`. Applying a review is therefore not "remove a blocker and promote": it
     * is the same decision with one more input, and computing it any other way would put a
     * second copy of the threshold rules in this file.
     */
    const tiered = assignTier({
      cerNospace: chosen.cerNospace,
      ci95: chosen.cerCi95,
      ratio: chosen.ratio,
      scriptIntegrity: chosen.scriptIntegrity,
      n: chosen.n,
      ...(chosen.reason === 'no-eval-set' ? { noEvalSet: true } : {}),
      humanReview: applicable,
    });

    // A row with no numbers names no provider. `si-LK` has an entry because a run asked for
    // it and FLEURS had nothing; saying `provider: google` there implies a Google
    // measurement exists, and the whole point of the `no-eval-set` reason is that one does
    // not. `chosenProvider` still says where a measurement would have to come from.
    const measured = chosen.reason !== 'no-eval-set' && chosen.n > 0;
    languages[code] = {
      tier: tiered.tier,
      reason: tiered.reason,
      provider: measured ? chosen.provider : null,
      model: measured ? chosen.model : null,
      chosenProvider: choice?.providerId ?? null,
      n: chosen.n,
      clipSeconds: chosen.clipSeconds,
      genderSplit: chosen.genderSplit,
      genderUniform: chosen.genderUniform,
      distinctIds: chosen.distinctIds,
      cer: chosen.cer,
      cerNospace: chosen.cerNospace,
      cerCi95: chosen.cerCi95,
      wer: chosen.wer,
      werKind: chosen.werKind,
      ratio: chosen.ratio,
      scriptIntegrity: chosen.scriptIntegrity,
      evalRunId: chosen.runId,
      evalDate: chosen.evalDate,
      split: runs[chosen.runId]?.sampling.split ?? null,
      example: chosen.example,
      humanReview: applicable,
      blockedFromVerifiedBy: tiered.blockedFromVerifiedBy,
      otherProviders: others,
      notes: chosen.notes,
    };
  }
  return languages;
}

function notRunRow(
  code: string,
  chosenProvider: string | null,
  others: TiersLanguage['otherProviders'],
  all: readonly TiersMeasurement[],
): TiersLanguage {
  const measuredOn = all.map((m) => m.provider).join(', ');
  return {
    tier: 'experimental',
    reason: 'not-run',
    provider: null,
    model: null,
    chosenProvider,
    n: 0,
    clipSeconds: 0,
    genderSplit: {},
    genderUniform: false,
    distinctIds: 0,
    cer: null,
    cerNospace: null,
    cerCi95: null,
    wer: null,
    werKind: null,
    ratio: null,
    scriptIntegrity: null,
    evalRunId: '',
    evalDate: '',
    split: null,
    example: null,
    humanReview: null,
    blockedFromVerifiedBy: ['not-run'],
    otherProviders: others,
    notes:
      chosenProvider === null
        ? `No provider supports ${code}, so nothing here describes what a user would get. Measured on ${measuredOn}.`
        : `Measured on ${measuredOn}, but this product would route ${code} to ${chosenProvider}, which has not been measured. A CER from a provider we would not use is not a claim about this language.`,
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

function toMeasurement(l: LanguageResult, run: AsrRunResult, evalDate: string): TiersMeasurement {
  return {
    code: l.languageCode,
    provider: run.provider,
    model: run.model,
    runId: run.runId,
    evalDate,
    tier: l.tier?.tier ?? 'experimental',
    reason: l.tier?.reason ?? 'not-run',
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
    example: l.example,
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

export class UnsupportedTiersSchemaError extends Error {
  constructor(
    readonly path: string,
    readonly found: unknown,
  ) {
    super(
      `${path}: schemaVersion ${String(found)} is not supported (expected ${TIERS_SCHEMA_VERSION}). ` +
        `It is derived from the runlogs in results/runs, so republish it with ` +
        `\`thibi eval report --run <runId>\` rather than editing it.`,
    );
    this.name = 'UnsupportedTiersSchemaError';
  }
}

/**
 * The previous file, or null when there is none.
 *
 * A **missing** file is a first run, not an error. A file of the **wrong schema version** is
 * an error and must stay one: v1 had no `measurements`, so reading it as v2 yields a file
 * whose evidence layer is empty and whose next publish silently drops every language v1 had
 * measured — which is risk 10 reappearing through the fix for risk 10. Republishing from the
 * runlog regenerates it.
 */
export async function readTiersFile(resultsDir: string): Promise<TiersFile | null> {
  let raw: string;
  try {
    raw = await readFile(tiersPath(resultsDir), 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as TiersFile;
  if (parsed.schemaVersion !== TIERS_SCHEMA_VERSION) {
    throw new UnsupportedTiersSchemaError(tiersPath(resultsDir), parsed.schemaVersion);
  }
  return parsed;
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
