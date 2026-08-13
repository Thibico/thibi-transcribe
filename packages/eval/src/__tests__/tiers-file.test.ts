import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AsrRunResult, LanguageResult } from '../runner.js';
import {
  baselineSuspect,
  buildTiersFile,
  deriveLanguages,
  diffTiers,
  loadHumanReviews,
  readTiersFile,
  writeTiersFile,
  type HumanReview,
  type TiersFile,
} from '../results/tiers.js';

/**
 * `tiers.json` is the only route by which a measured CER reaches a user, so the assertions
 * here are about what the file is allowed to claim, not about how it is formatted.
 */

function language(over: Partial<LanguageResult> = {}): LanguageResult {
  return {
    languageCode: 'my-MM',
    cfg: 'my_mm',
    tsvOid: 'oid',
    n: 30,
    clipSeconds: 300,
    genderSplit: { FEMALE: 30 },
    genderUniform: true,
    distinctIds: 30,
    cer: 0.12,
    cerNospace: 0.12,
    cerCi95: [0.1, 0.14],
    wer: null,
    werKind: null,
    scriptIntegrity: 0.99,
    ratio: 1,
    costUsd: 0.16,
    cachedClips: 0,
    unmatched: 0,
    example: { id: 1, ref: 'မြန်မာ', hyp: 'မြန်မာ' },
    tier: { tier: 'beta', reason: 'measured', blockedFromVerifiedBy: ['humanReview'] },
    ...over,
  };
}

function run(languages: LanguageResult[], over: Partial<AsrRunResult> = {}): AsrRunResult {
  return {
    runId: 'run-2',
    startedAt: '2026-08-13T12:00:00.000Z',
    finishedAt: '2026-08-13T12:05:00.000Z',
    provider: 'google',
    model: 'chirp_2',
    split: 'dev',
    n: 30,
    baselineCode: 'my-MM',
    baselineAdded: false,
    languages,
    spentUsd: 0.16,
    budgetExhausted: false,
    ...over,
  };
}

const build = (
  languages: LanguageResult[],
  previous: TiersFile | null = null,
  reviews = {},
  over: Partial<AsrRunResult> = {},
) =>
  buildTiersFile({ run: run(languages, over), engineVersion: 'test', previous, humanReviews: reviews });

/** The baseline block now lives on the run, because that is whose baseline it is. */
const baselineOf = (f: TiersFile) => f.runs[f.latestRunId]!.baseline;

describe('the shape a UI branches on', () => {
  it('distinguishes not-measured from measured-and-bad', () => {
    const file = build([
      language(),
      language({
        languageCode: 'si-LK',
        cfg: null,
        n: 0,
        cer: null,
        cerNospace: null,
        cerCi95: null,
        scriptIntegrity: null,
        ratio: null,
        example: null,
        tier: { tier: 'experimental', reason: 'no-eval-set', blockedFromVerifiedBy: ['no-eval-set'] },
      }),
      language({
        languageCode: 'yo-NG',
        cerNospace: 0.8,
        tier: { tier: 'unsupported', reason: 'measured', blockedFromVerifiedBy: ['cer>0.6'] },
      }),
    ]);

    // Both are non-verified, and they must not render the same: one has no eval set, the
    // other was measured and is bad.
    expect(file.languages['si-LK']!.reason).toBe('no-eval-set');
    expect(file.languages['si-LK']!.cer).toBeNull();
    expect(file.languages['si-LK']!.provider).toBeNull();
    expect(file.languages['yo-NG']!.reason).toBe('measured');
    expect(file.languages['yo-NG']!.tier).toBe('unsupported');
  });

  it('carries the caveat that has to travel with the number', () => {
    const file = build([language()]);
    // All 380 rows of my_mm/dev are FEMALE (amendment 68). A tier row that does not say so
    // is a language-level claim made from one speaker gender.
    expect(file.languages['my-MM']!.notes).toMatch(/FEMALE/u);
    expect(file.languages['my-MM']!.genderUniform).toBe(true);
  });

  it('omits a language the run could not measure rather than inventing a row for it', () => {
    const file = build([language(), language({ languageCode: 'ha-NG', error: 'not run: budget exhausted' })]);
    expect(Object.keys(file.languages)).toEqual(['my-MM']);
  });
});

/**
 * Risk 10. v1 wrote one row per language *in the current run*, so a narrow sweep after a wide
 * one republished the file with only the narrow sweep's languages in it — silently, totally,
 * and into the file the registry compiles.
 */
describe('a later run does not erase an earlier one', () => {
  it('keeps languages the new run never touched', () => {
    const wide = build([
      language(),
      language({ languageCode: 'ha-NG' }),
      language({ languageCode: 'yo-NG' }),
    ]);
    expect(Object.keys(wide.languages).sort()).toEqual(['ha-NG', 'my-MM', 'yo-NG']);

    const narrow = build([language()], wide, {}, { runId: 'run-3' });
    expect(Object.keys(narrow.languages).sort()).toEqual(['ha-NG', 'my-MM', 'yo-NG']);
    expect(narrow.languages['ha-NG']!.evalRunId).toBe('run-2');
    expect(narrow.languages['my-MM']!.evalRunId).toBe('run-3');
  });

  it('replaces a measurement of the same language, provider and model', () => {
    const first = build([language({ cerNospace: 0.12, cer: 0.12 })]);
    const second = build([language({ cerNospace: 0.05, cer: 0.05 })], first, {}, { runId: 'run-3' });
    expect(second.languages['my-MM']!.cerNospace).toBe(0.05);
    expect(Object.keys(second.measurements)).toEqual(['my-MM|google|chirp_2']);
  });

  it('keeps every run it has seen, so a row can resolve its own sampling context', () => {
    const first = build([language()]);
    const second = build([language({ languageCode: 'ha-NG' })], first, {}, { runId: 'run-3' });
    expect(Object.keys(second.runs).sort()).toEqual(['run-2', 'run-3']);
    expect(second.languages['my-MM']!.split).toBe('dev');
  });

  it('derives languages purely from measurements, so republishing is idempotent', () => {
    const file = build([language(), language({ languageCode: 'ha-NG' })]);
    const rederived = deriveLanguages(file.measurements, file.runs);
    expect(rederived).toEqual(file.languages);
  });
});

/**
 * The trapdoor merging opens, and the rule that closes it. Measuring `my-MM` on Groq is
 * something this project does deliberately — reproducing that failure on demand is worth a
 * flag — and it must not publish Groq's romanized non-words as Burmese's tier.
 */
describe('a provider the product would not use cannot set a tier', () => {
  const groqRun = { runId: 'run-groq', provider: 'groq', model: 'whisper-large-v3' };

  it('keeps the good provider’s row when a worse provider is measured afterwards', () => {
    const good = build([language({ cerNospace: 0.064 })]);
    const after = build(
      [
        language({
          cerNospace: 0.97,
          scriptIntegrity: 0.02,
          tier: { tier: 'unsupported', reason: 'script-integrity', blockedFromVerifiedBy: ['scriptIntegrity<0.8'] },
        }),
      ],
      good,
      {},
      groqRun,
    );

    const row = after.languages['my-MM']!;
    expect(row.tier).toBe('beta');
    expect(row.provider).toBe('google');
    expect(row.cerNospace).toBe(0.064);
  });

  it('keeps the rejected measurement rather than discarding it', () => {
    const good = build([language({ cerNospace: 0.064 })]);
    const after = build([language({ cerNospace: 0.97 })], good, {}, groqRun);

    // The finding survives — "Groq is unusable for Burmese" is worth having — it simply is
    // not a fact about Burmese.
    expect(Object.keys(after.measurements).sort()).toEqual([
      'my-MM|google|chirp_2',
      'my-MM|groq|whisper-large-v3',
    ]);
    expect(after.languages['my-MM']!.otherProviders).toEqual([
      expect.objectContaining({ provider: 'groq', cerNospace: 0.97 }),
    ]);
  });

  it('reports not-run when only a provider we would not route to has been measured', () => {
    const onlyGroq = build([language({ cerNospace: 0.97 })], null, {}, groqRun);
    const row = onlyGroq.languages['my-MM']!;
    expect(row.reason).toBe('not-run');
    expect(row.cerNospace).toBeNull();
    expect(row.chosenProvider).toBe('google');
    expect(row.notes).toMatch(/would route my-MM to google/u);
  });
});

describe('the baseline', () => {
  it('is not suspect on a first run, having nothing to drift from', () => {
    expect(baselineSuspect(0.12, null)).toBe(false);
    expect(baselineOf(build([language()])).suspect).toBe(false);
  });

  it('is suspect when it moves more than a quarter in either direction', () => {
    expect(baselineSuspect(0.16, 0.12)).toBe(true); // +33%
    expect(baselineSuspect(0.08, 0.12)).toBe(true); // −33%
    expect(baselineSuspect(0.13, 0.12)).toBe(false); // +8%
  });

  it('flags the run, because every ratio in it is against that baseline', () => {
    const previous = build([language({ cerNospace: 0.12 })]);
    const next = build([language({ cerNospace: 0.3 })], previous);
    expect(baselineOf(next).suspect).toBe(true);
    expect(baselineOf(next).previousCerNospace).toBe(0.12);
  });
});

describe('human review', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'thibi-tiers-'));
    await mkdir(join(dir, 'human-review'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const review = (over: Partial<HumanReview> = {}): HumanReview => ({
    code: 'my-MM',
    reviewer: 'Someone <s@example.com>',
    reviewedAt: '2026-08-13',
    evalRunId: 'run-2',
    clipsReviewed: 12,
    verdict: 'pass',
    nativeSpeaker: true,
    ...over,
  });

  const put = (name: string, r: HumanReview) =>
    writeFile(join(dir, 'human-review', name), JSON.stringify(r), 'utf8');

  it('counts a sign-off only against the run it names', async () => {
    await put('my-MM.json', review());
    await put('ha-NG.json', review({ code: 'ha-NG', evalRunId: 'run-1' }));

    const { current, stale } = await loadHumanReviews(dir, 'run-2');
    expect(Object.keys(current)).toEqual(['my-MM']);
    expect(stale.map((r) => r.code)).toEqual(['ha-NG']);
  });

  it('never lets a failing review unlock anything', async () => {
    await put('my-MM.json', review({ verdict: 'fail' }));
    const { current, stale } = await loadHumanReviews(dir, 'run-2');
    expect(current).toEqual({});
    // Nor does it ask anyone to redo it: a failed review is an answer, not a gap.
    expect(stale).toEqual([]);
  });

  it('treats a missing directory as no reviews, not as an error', async () => {
    const { current, stale } = await loadHumanReviews(join(dir, 'nope'), 'run-2');
    expect(current).toEqual({});
    expect(stale).toEqual([]);
  });

  it('appears in the file only for the language it names', async () => {
    const file = build([language(), language({ languageCode: 'ha-NG' })], null, {
      'my-MM': review(),
    });
    expect(file.languages['my-MM']!.humanReview?.reviewer).toContain('Someone');
    expect(file.languages['ha-NG']!.humanReview).toBeNull();
  });
});

describe('the tier diff', () => {
  it('reports a new language as a change, and an unchanged tier as nothing', () => {
    const previous = build([language()]);
    const next = build([language(), language({ languageCode: 'ha-NG' })], previous);
    const changes = diffTiers(previous, next);
    expect(changes.map((c) => c.code)).toEqual(['ha-NG']);
    expect(changes[0]!.from).toBeNull();
  });

  it('reports a demotion with both CERs, so the reason is visible', () => {
    const previous = build([language({ cerNospace: 0.12 })]);
    const next = build(
      [
        language({
          cerNospace: 0.9,
          tier: { tier: 'unsupported', reason: 'measured', blockedFromVerifiedBy: ['cer>0.6'] },
        }),
      ],
      previous,
    );
    const [change] = diffTiers(previous, next);
    expect(change).toMatchObject({ code: 'my-MM', from: 'beta', to: 'unsupported', cerBefore: 0.12 });
    expect(change!.cerAfter).toBe(0.9);
  });

  /** A sweep that did not measure Hausa has said nothing about Hausa. */
  it('does not report a language that simply was not in this run', () => {
    const previous = build([language(), language({ languageCode: 'ha-NG' })]);
    const next = build([language()], previous);
    expect(diffTiers(previous, next)).toEqual([]);
  });
});

describe('reading and writing', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'thibi-tiers-io-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips, and treats an absent file as a first run', async () => {
    expect(await readTiersFile(dir)).toBeNull();
    const file = build([language()]);
    await writeTiersFile(dir, file);
    expect(await readTiersFile(dir)).toEqual(file);
  });
});
