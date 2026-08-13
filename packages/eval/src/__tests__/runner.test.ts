import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResponseCache } from '../cache.js';
import type { Clip } from '../fleurs/audio.js';
import { NoEvalSetError, type FleursRow, type Split } from '../fleurs/tsv.js';
import {
  runAsrEval,
  applyBaselineAndTiers,
  BASELINE_CODE,
  type LanguageResult,
  type RunAsrDeps,
  type RunEvent,
} from '../runner.js';

/**
 * The runner, finally under test.
 *
 * Until `loadTsv` and `fetchClips` became dependencies this module could only be exercised
 * by a run that billed a provider — which is why the package had 84 tests and none of them
 * touched the file that decides how many times money is spent. Everything below runs
 * offline in milliseconds.
 *
 * The fake data is deliberately trivial: the metrics themselves are proved in
 * `@thibi/core`'s 213 tests, and asserting a CER here would be asserting Levenshtein twice.
 * What is asserted is what only the runner does — over-fetching, the join, the cache, the
 * budget ceiling, the baseline, and the order of the events it reports.
 */

// Reference and hypothesis differ by exactly one Burmese character, so a wrong CER is
// visible without depending on the exact edit distance of a realistic sentence.
const REF = 'မြန်မာစာ';
const HYP = 'မြန်မာစာ';
const HYP_WRONG = 'မြန်မာစာက';

function row(id: number, filename: string, plain = REF, gender = 'FEMALE'): FleursRow {
  return {
    id,
    filename,
    raw: plain,
    plain,
    graphemes: '',
    numSamples: 16_000 * 10, // ten seconds
    gender,
  };
}

function clip(filename: string): Clip {
  return { filename, bytes: Buffer.from(`audio:${filename}`) };
}

interface Harness {
  deps: RunAsrDeps;
  events: RunEvent[];
  calls: { transcribe: string[]; fetchClips: Array<[string, number]>; loadTsv: string[] };
}

function harness(options: {
  rows?: Record<string, FleursRow[]>;
  dropped?: number;
  clips?: Record<string, Clip[]>;
  hyp?: (filename: string) => string;
  costUsd?: number;
  cacheDir: string;
}): Harness {
  const calls: Harness['calls'] = { transcribe: [], fetchClips: [], loadTsv: [] };
  const events: RunEvent[] = [];
  let tick = 0;

  const deps: RunAsrDeps = {
    now: () => new Date(Date.UTC(2026, 7, 13, 12, 0, tick++)),
    cache: new ResponseCache(options.cacheDir),
    loadTsv: async (_cacheDir: string, cfg: string, _split: Split) => {
      calls.loadTsv.push(cfg);
      const rows = options.rows?.[cfg];
      if (!rows) throw new NoEvalSetError(cfg);
      return { rows, oid: `oid-${cfg}`, dropped: options.dropped ?? 0 };
    },
    fetchClips: async (cfg: string, _split: string, n: number) => {
      calls.fetchClips.push([cfg, n]);
      return (options.clips?.[cfg] ?? []).slice(0, n);
    },
    transcribe: async ({ clip: c }) => {
      calls.transcribe.push(c.filename);
      return { text: options.hyp?.(c.filename) ?? HYP, costUsd: options.costUsd ?? 0.01 };
    },
    onEvent: (e) => {
      events.push(e);
    },
  };
  return { deps, events, calls };
}

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'thibi-runner-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('runAsrEval', () => {
  it('scores the clips that joined and reports the ones that did not', async () => {
    // A tar member with no TSV row — the shape amendment 70 measured on the first real
    // pull, where 30 clips produced 29 scoreable pairs. The orphan is paired with
    // `dropped: 1` deliberately: an unmatched tar member exists *because* the parser refused
    // a record, so a fixture with an orphan and no dropped record is one that cannot occur,
    // and the over-fetch it would then skip is the whole mechanism under test.
    const h = harness({
      cacheDir,
      rows: { my_mm: [row(1, 'a.wav'), row(2, 'b.wav')] },
      dropped: 1,
      clips: { my_mm: [clip('a.wav'), clip('orphan.wav'), clip('b.wav')] },
    });

    const result = await runAsrEval(h.deps, {
      languages: ['my-MM'],
      n: 2,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
    });

    const my = result.languages.find((l) => l.languageCode === 'my-MM')!;
    expect(my.n).toBe(2);
    expect(my.unmatched).toBe(1);
    expect(my.cer).toBe(0);
    expect(my.tsvOid).toBe('oid-my_mm');
    expect(h.calls.transcribe).toEqual(['a.wav', 'b.wav']);
  });

  /**
   * The over-fetch is the runner's answer to amendment 70, and it is the kind of arithmetic
   * that looks right and is off by one. With 1 dropped record in 5, asking for 4 clips must
   * ask the tarball for more than 4.
   */
  it('over-fetches in proportion to the records the TSV had to drop', async () => {
    const rows = [1, 2, 3, 4].map((i) => row(i, `${i}.wav`));
    const h = harness({
      cacheDir,
      rows: { my_mm: rows },
      dropped: 1,
      clips: { my_mm: rows.map((r) => clip(r.filename)) },
    });

    await runAsrEval(h.deps, {
      languages: ['my-MM'],
      n: 4,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
    });

    const [, requested] = h.calls.fetchClips[0]!;
    expect(requested).toBeGreaterThan(4);
    // Bounded by what exists: never ask for more clips than the split has records.
    expect(requested).toBeLessThanOrEqual(5);
  });

  it('adds the baseline to a run that did not ask for it, and says so', async () => {
    const lines: string[] = [];
    const h = harness({
      cacheDir,
      rows: { my_mm: [row(1, 'a.wav')], ha_ng: [row(2, 'b.wav', 'hausa text')] },
      clips: { my_mm: [clip('a.wav')], ha_ng: [clip('b.wav')] },
      hyp: (f) => (f === 'b.wav' ? 'hausa text' : HYP),
    });

    const result = await runAsrEval(h.deps, {
      languages: ['ha-NG'],
      n: 1,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
      onProgress: (l) => lines.push(l),
    });

    expect(result.baselineAdded).toBe(true);
    expect(result.languages[0]!.languageCode).toBe(BASELINE_CODE);
    expect(lines.some((l) => l.includes('baseline my-MM added'))).toBe(true);
  });

  it('reports a language with no FLEURS config as no-eval-set, not as an error', async () => {
    const h = harness({
      cacheDir,
      rows: { my_mm: [row(1, 'a.wav')] },
      clips: { my_mm: [clip('a.wav')] },
    });

    const result = await runAsrEval(h.deps, {
      languages: ['si-LK'],
      n: 1,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
    });

    const si = result.languages.find((l) => l.languageCode === 'si-LK')!;
    expect(si.error).toBeUndefined();
    expect(si.cfg).toBeNull();
    expect(si.tier?.tier).toBe('experimental');
    expect(si.tier?.reason).toBe('no-eval-set');
  });

  it('computes ratio against the baseline measured in the same run', async () => {
    const h = harness({
      cacheDir,
      rows: {
        my_mm: [row(1, 'a.wav')],
        ha_ng: [row(2, 'b.wav', 'abcd')],
      },
      clips: { my_mm: [clip('a.wav')], ha_ng: [clip('b.wav')] },
      // Burmese perfect, Hausa one substitution in four characters.
      hyp: (f) => (f === 'b.wav' ? 'abcx' : HYP),
    });

    const result = await runAsrEval(h.deps, {
      languages: ['my-MM', 'ha-NG'],
      n: 1,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
    });

    const my = result.languages.find((l) => l.languageCode === 'my-MM')!;
    const ha = result.languages.find((l) => l.languageCode === 'ha-NG')!;
    expect(my.cerNospace).toBe(0);
    expect(ha.cerNospace).toBeCloseTo(0.25, 10);
    // A baseline of 0 leaves the ratio undefined rather than infinite — a perfect baseline
    // is a measurement, not a division.
    expect(ha.ratio).toBeNull();
  });

  it('never returns verified, whatever the numbers say', async () => {
    const h = harness({
      cacheDir,
      rows: { my_mm: Array.from({ length: 30 }, (_, i) => row(i, `${i}.wav`)) },
      clips: { my_mm: Array.from({ length: 30 }, (_, i) => clip(`${i}.wav`)) },
    });

    const result = await runAsrEval(h.deps, {
      languages: ['my-MM'],
      n: 30,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
    });

    const my = result.languages[0]!;
    expect(my.cerNospace).toBe(0);
    expect(my.tier?.tier).not.toBe('verified');
    expect(my.tier?.blockedFromVerifiedBy).toContain('humanReview');
  });
});

describe('the response cache', () => {
  it('makes a second identical run free', async () => {
    const rows = [row(1, 'a.wav'), row(2, 'b.wav')];
    const clips = rows.map((r) => clip(r.filename));
    const opts = {
      languages: ['my-MM'],
      n: 2,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
    } as const;

    const first = harness({ cacheDir, rows: { my_mm: rows }, clips: { my_mm: clips } });
    const a = await runAsrEval(first.deps, opts);
    expect(a.spentUsd).toBeCloseTo(0.02, 10);

    const second = harness({ cacheDir, rows: { my_mm: rows }, clips: { my_mm: clips } });
    const b = await runAsrEval(second.deps, opts);
    expect(second.calls.transcribe).toEqual([]);
    expect(b.spentUsd).toBe(0);
    expect(b.languages[0]!.cachedClips).toBe(2);
    expect(b.languages[0]!.cer).toBe(a.languages[0]!.cer);
  });

  /**
   * A cache keyed on the model would otherwise serve a `chirp_2` transcript for a
   * `chirp_3` request and report the older model's accuracy under the newer model's name.
   */
  it('is not shared across models', async () => {
    const rows = [row(1, 'a.wav')];
    const clips = [clip('a.wav')];
    const base = { languages: ['my-MM'], n: 1, cacheDir, provider: 'fake' } as const;

    const first = harness({ cacheDir, rows: { my_mm: rows }, clips: { my_mm: clips } });
    await runAsrEval(first.deps, { ...base, model: 'fake-1' });

    const second = harness({ cacheDir, rows: { my_mm: rows }, clips: { my_mm: clips } });
    await runAsrEval(second.deps, { ...base, model: 'fake-2' });
    expect(second.calls.transcribe).toEqual(['a.wav']);
  });
});

describe('the budget ceiling', () => {
  /**
   * The abort path, implemented since 2026-08-13 and never once fired.
   *
   * Every clip here is ten seconds at $0.12/minute — $0.02 each — against a $0.03 ceiling.
   * One clip fits, the second is projected to cross the line and is refused, and the run
   * ends having spent $0.02 of $0.03. The earlier ledger-only check ran both and spent
   * $0.04, which is a budget reported as enforced after it was exceeded.
   */
  it('stops before the call that would exceed the ceiling', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i, `${i}.wav`));
    const h = harness({
      cacheDir,
      rows: { my_mm: rows },
      clips: { my_mm: rows.map((r) => clip(r.filename)) },
      costUsd: 0.02,
    });

    const result = await runAsrEval(h.deps, {
      languages: ['my-MM'],
      n: 5,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
      budgetUsd: 0.03,
      usdPerMinute: 0.12,
    });

    expect(h.calls.transcribe).toHaveLength(1);
    expect(result.budgetExhausted).toBe(true);
    expect(result.spentUsd).toBeLessThanOrEqual(0.03);
    expect(result.languages[0]!.error).toMatch(/budget exhausted/u);
    expect(h.events.some((e) => e.t === 'budget')).toBe(true);
  });

  it('refuses a first clip that alone would exceed the ceiling', async () => {
    const h = harness({
      cacheDir,
      rows: { my_mm: [row(1, 'a.wav')], ha_ng: [row(2, 'b.wav', 'abcd')] },
      clips: { my_mm: [clip('a.wav')], ha_ng: [clip('b.wav')] },
      costUsd: 1,
    });

    const result = await runAsrEval(h.deps, {
      languages: ['my-MM', 'ha-NG'],
      n: 1,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
      budgetUsd: 0.5,
      usdPerMinute: 6, // ten seconds = $1, twice the ceiling
    });

    expect(h.calls.transcribe).toEqual([]);
    expect(result.spentUsd).toBe(0);
    expect(result.languages.map((l) => l.error)).toEqual([
      'stopped part-way: budget exhausted',
      'not run: budget exhausted',
    ]);
  });

  /**
   * Without a rate there is nothing to project from, so the ceiling can only be enforced
   * one clip late. That is a real weakening and it is asserted rather than hidden: a run
   * against a provider with no row in the rate table must not silently behave as though the
   * budget were exact.
   */
  it('falls back to the retrospective check when no rate is known', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(i, `${i}.wav`));
    const h = harness({
      cacheDir,
      rows: { my_mm: rows },
      clips: { my_mm: rows.map((r) => clip(r.filename)) },
      costUsd: 0.02,
    });

    const result = await runAsrEval(h.deps, {
      languages: ['my-MM'],
      n: 3,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
      budgetUsd: 0.03,
    });

    expect(h.calls.transcribe).toHaveLength(2);
    expect(result.spentUsd).toBeCloseTo(0.04, 10);
  });
});

describe('the event stream', () => {
  it('reports clip, asr and score per clip, then one summary per language', async () => {
    const rows = [row(1, 'a.wav'), row(2, 'b.wav')];
    const h = harness({
      cacheDir,
      rows: { my_mm: rows },
      clips: { my_mm: rows.map((r) => clip(r.filename)) },
      hyp: (f) => (f === 'b.wav' ? HYP_WRONG : HYP),
    });

    await runAsrEval(h.deps, {
      languages: ['my-MM'],
      n: 2,
      cacheDir,
      provider: 'fake',
      model: 'fake-1',
    });

    expect(h.events.map((e) => e.t)).toEqual([
      'clip',
      'asr',
      'score',
      'clip',
      'asr',
      'score',
      'summary',
    ]);

    // The hypothesis travels on the event, un-normalized: the runlog has to be able to show
    // a reader the string the provider actually returned.
    const asr = h.events.filter((e) => e.t === 'asr');
    expect(asr.map((e) => (e.t === 'asr' ? e.hyp : ''))).toEqual([HYP, HYP_WRONG]);

    // Per-clip edit counts, not rates. A rate cannot be summed back into a corpus CER, and
    // the bootstrap resamples the pairs.
    const scores = h.events.filter((e) => e.t === 'score');
    expect(scores.map((e) => (e.t === 'score' ? e.edits : -1))).toEqual([0, 1]);
  });
});

describe('applyBaselineAndTiers', () => {
  const measured = (code: string, cerNospace: number): LanguageResult => ({
    languageCode: code,
    cfg: 'x',
    tsvOid: 'oid',
    n: 30,
    clipSeconds: 300,
    genderSplit: { FEMALE: 30 },
    genderUniform: true,
    distinctIds: 30,
    cer: cerNospace,
    cerNospace,
    cerCi95: [cerNospace * 0.95, cerNospace * 1.05],
    wer: null,
    werKind: null,
    scriptIntegrity: 0.99,
    ratio: null,
    costUsd: 0,
    cachedClips: 0,
    unmatched: 0,
    example: null,
  });

  it('is the only route to verified, and only with a human review', () => {
    const results = [measured(BASELINE_CODE, 0.1), measured('ha-NG', 0.105)];
    applyBaselineAndTiers(results);
    expect(results[1]!.tier?.tier).toBe('beta');
    expect(results[1]!.tier?.blockedFromVerifiedBy).toEqual(['humanReview']);

    const withReview = [measured(BASELINE_CODE, 0.1), measured('ha-NG', 0.105)];
    applyBaselineAndTiers(withReview, { 'ha-NG': { verdict: 'pass' } });
    expect(withReview[1]!.tier?.tier).toBe('verified');
  });

  it('divides by the baseline measured in this run, not a remembered one', () => {
    const results = [measured(BASELINE_CODE, 0.2), measured('ha-NG', 0.3)];
    applyBaselineAndTiers(results);
    expect(results[1]!.ratio).toBeCloseTo(1.5, 10);
  });
});
