import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResponseCache } from '../cache.js';
import type { Clip } from '../fleurs/audio.js';
import type { FleursRow, Split } from '../fleurs/tsv.js';
import { runAsrEval, type RunAsrDeps } from '../runner.js';
import {
  isComplete,
  MalformedRunlogError,
  parseRunlog,
  readRunlog,
  reconstructRun,
  RunlogWriter,
  runlogPath,
  type RunlogLine,
} from '../runlog.js';

/**
 * The runlog's job is one property: **a report re-derived from it must equal the report the
 * live run produced**, with the network off. Everything below is that claim, taken apart.
 */

const REF = 'မြန်မာစာ';

function row(id: number, filename: string, plain = REF): FleursRow {
  return {
    id,
    filename,
    raw: plain,
    plain,
    graphemes: '',
    numSamples: 16_000 * 10,
    gender: 'FEMALE',
  };
}

const clipFor = (filename: string): Clip => ({
  filename,
  bytes: Buffer.from(`audio:${filename}`),
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thibi-runlog-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A live run against fake data, with every event written to a real runlog file. */
async function liveRun(options: {
  hyp?: (filename: string) => string;
  budgetUsd?: number | null;
  usdPerMinute?: number | null;
  clipCount?: number;
} = {}) {
  const rows = Array.from({ length: options.clipCount ?? 3 }, (_, i) => row(i, `${i}.wav`));
  const writer = new RunlogWriter(runlogPath(dir, 'run-1'));
  let tick = 0;

  const deps: RunAsrDeps = {
    now: () => new Date(Date.UTC(2026, 7, 13, 12, 0, tick++)),
    cache: new ResponseCache(join(dir, 'cache')),
    loadTsv: async (_c: string, cfg: string, _s: Split) => ({
      rows: cfg === 'my_mm' ? rows : [],
      oid: `oid-${cfg}`,
      dropped: 0,
    }),
    fetchClips: async (cfg: string, _s: string, n: number) =>
      cfg === 'my_mm' ? rows.slice(0, n).map((r) => clipFor(r.filename)) : [],
    transcribe: async ({ clip }) => ({
      text: options.hyp?.(clip.filename) ?? REF,
      costUsd: 0.02,
    }),
    onEvent: (e) => writer.write(e),
  };

  await writer.write({
    t: 'run',
    runId: 'run-1',
    startedAt: '2026-08-13T12:00:00.000Z',
    argv: ['eval', 'asr', '--languages', 'my-MM'],
    engineVersion: 'test',
    provider: 'fake',
    model: 'fake-1',
    split: 'dev',
    n: options.clipCount ?? 3,
    baselineCode: 'my-MM',
    baselineAdded: false,
  });

  const result = await runAsrEval(deps, {
    languages: ['my-MM'],
    runId: 'run-1',
    n: options.clipCount ?? 3,
    cacheDir: join(dir, 'cache'),
    provider: 'fake',
    model: 'fake-1',
    ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }),
    ...(options.usdPerMinute === undefined ? {} : { usdPerMinute: options.usdPerMinute }),
  });

  await writer.write({
    t: 'end',
    finishedAt: result.finishedAt,
    spentUsd: result.spentUsd,
    budgetExhausted: result.budgetExhausted,
  });

  return { result, path: writer.path };
}

describe('round trip', () => {
  it('reconstructs a run that equals the one that was measured', async () => {
    // One clip wrong, so the CER, the interval and the tier are all non-degenerate — a
    // round trip over a perfect run would pass with a broken estimator.
    const { result, path } = await liveRun({
      hyp: (f) => (f === '1.wav' ? `${REF}က` : REF),
    });

    const replayed = await readRunlog(path);
    expect(replayed).toEqual(result);
    expect(replayed.languages[0]!.cerNospace).toBeGreaterThan(0);
    expect(replayed.languages[0]!.cerCi95).not.toBeNull();
  });

  it('carries the provider strings verbatim, un-normalized', async () => {
    const { path } = await liveRun({ hyp: () => '  MiXeD Case, ။ ' });
    const lines = parseRunlog(await readFile(path, 'utf8'));
    const asr = lines.filter((l) => l.t === 'asr');
    expect(asr).toHaveLength(3);
    expect(asr.every((l) => l.t === 'asr' && l.hyp === '  MiXeD Case, ။ ')).toBe(true);
  });

  /**
   * The reason `score` lines carry counts and not rates: the corpus estimator is the ratio
   * of sums, and the bootstrap resamples the pairs. Rates could reproduce neither.
   */
  it('stores per-clip edit counts, not per-clip rates', async () => {
    const { path } = await liveRun({ hyp: (f) => (f === '1.wav' ? `${REF}က` : REF) });
    const lines = parseRunlog(await readFile(path, 'utf8'));
    const scores = lines.filter((l) => l.t === 'score');
    expect(scores.map((l) => (l.t === 'score' ? l.edits : -1))).toEqual([0, 1, 0]);
    expect(scores.every((l) => l.t === 'score' && l.refLen > 0)).toBe(true);
  });
});

describe('recomputation', () => {
  /**
   * The point of the file. If the reader trusted the stored aggregates it would reproduce
   * the old report perfectly and go on reproducing it after someone changed the estimator.
   */
  it('recomputes the CER rather than reading back the stored one', async () => {
    const { path } = await liveRun({ hyp: (f) => (f === '1.wav' ? `${REF}က` : REF) });

    const lines = parseRunlog(await readFile(path, 'utf8')).map((l) =>
      l.t === 'summary' ? { ...l, result: { ...l.result, cer: 0.999, cerNospace: 0.999 } } : l,
    );

    const replayed = reconstructRun(lines as RunlogLine[]);
    expect(replayed.languages[0]!.cerNospace).toBeLessThan(0.1);
  });

  it('recomputes the tier, so a threshold change costs no API calls', async () => {
    const { path } = await liveRun();
    const lines = parseRunlog(await readFile(path, 'utf8'));

    const withoutReview = reconstructRun(lines);
    expect(withoutReview.languages[0]!.tier?.tier).not.toBe('verified');

    // The same log, re-read with a sign-off that did not exist when it was written.
    const withReview = reconstructRun(lines, '<memory>', {
      'my-MM': { verdict: 'pass', reviewer: 'someone' },
    });
    expect(withReview.languages[0]!.tier?.blockedFromVerifiedBy).not.toContain('humanReview');
  });

  /**
   * The trap this file walked into once. A language the budget stopped part-way leaves
   * `score` lines behind — the clips it did buy — and a reader that recomputed from them
   * would put the partial CER in the report as though it were the whole measurement.
   */
  it('does not resurrect the clips of a language the budget cut off', async () => {
    const { result, path } = await liveRun({
      clipCount: 4,
      budgetUsd: 0.05,
      usdPerMinute: 0.12, // ten-second clips at $0.02 each
    });
    expect(result.budgetExhausted).toBe(true);

    const lines = parseRunlog(await readFile(path, 'utf8'));
    expect(lines.filter((l) => l.t === 'score').length).toBeGreaterThan(0);

    const replayed = reconstructRun(lines);
    expect(replayed.languages[0]!.n).toBe(0);
    expect(replayed.languages[0]!.cer).toBeNull();
    expect(replayed.languages[0]!.error).toMatch(/budget exhausted/u);
  });
});

describe('a log from a run that died', () => {
  it('drops a truncated final line rather than refusing the whole file', () => {
    const good = JSON.stringify({ t: 'budget', spentUsd: 1, limitUsd: 2 });
    const lines = parseRunlog(`${good}\n{"t":"asr","lang":"my-MM","id":1,"cacheH`);
    expect(lines).toHaveLength(1);
  });

  it('reports itself incomplete and still totals what was spent', async () => {
    const { path } = await liveRun();
    const text = await readFile(path, 'utf8');
    const withoutFooter = text
      .split('\n')
      .filter((l) => !l.includes('"t":"end"'))
      .join('\n');
    await writeFile(path, withoutFooter, 'utf8');

    const lines = parseRunlog(withoutFooter);
    expect(isComplete(lines)).toBe(false);

    const replayed = reconstructRun(lines);
    expect(replayed.spentUsd).toBeCloseTo(0.06, 10);
    expect(replayed.languages[0]!.n).toBe(3);
  });

  it('refuses a log with no header, naming the file', () => {
    expect(() => reconstructRun([{ t: 'budget', spentUsd: 0, limitUsd: 1 }], '/tmp/x.jsonl')).toThrow(
      MalformedRunlogError,
    );
  });
});

describe('the writer', () => {
  it('appends, creating the runs directory on first write', async () => {
    const writer = new RunlogWriter(runlogPath(dir, 'fresh'));
    await writer.write({ t: 'budget', spentUsd: 1, limitUsd: 2 });
    await writer.write({ t: 'budget', spentUsd: 2, limitUsd: 2 });
    const text = await readFile(runlogPath(dir, 'fresh'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(2);
  });
});
