import { describe, expect, it } from 'vitest';
import { estimateAsr, formatDryRun, formatDuration } from '../estimate.js';
import type { FleursRow } from '../fleurs/tsv.js';

const row = (id: number, seconds: number): FleursRow => ({
  id,
  filename: `f${id}.wav`,
  raw: 'raw',
  plain: 'plain',
  graphemes: 'g',
  numSamples: seconds * 16_000,
  gender: 'FEMALE',
});

/** Ten clips averaging 10 s, total 100 s. */
const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, 6 + i * 2));

describe('estimateAsr', () => {
  it('projects from mean clip length when sampling part of a split', () => {
    const e = estimateAsr({
      languageCode: 'my-MM',
      cfg: 'my_mm',
      rows,
      droppedRecords: 0,
      n: 5,
      usdPerMinute: 0.016,
    });
    expect(e.meanClipSeconds).toBe(15);
    expect(e.estimatedSeconds).toBe(75);
    expect(e.exact).toBe(false);
    expect(e.estimatedUsd).toBeCloseTo((75 / 60) * 0.016, 9);
  });

  /**
   * The only case where the plan's "exact audio seconds" is achievable: the request covers
   * the whole split, so which rows tar order picks stops mattering.
   */
  it('is exact, and sums rather than projects, when n covers the split', () => {
    const e = estimateAsr({
      languageCode: 'my-MM',
      cfg: 'my_mm',
      rows,
      droppedRecords: 0,
      n: 50,
      usdPerMinute: null,
    });
    expect(e.exact).toBe(true);
    expect(e.estimatedSeconds).toBe(150);
    expect(e.clipsAvailable).toBe(10);
    expect(e.estimatedUsd).toBeNull();
  });

  /**
   * Dropped records keep their audio in the tarball, so a tar-order sample hits them and the
   * join throws them away. Measured on the real split: 30 clips fetched, 29 scoreable.
   */
  it('predicts the clips the join will discard', () => {
    const e = estimateAsr({
      languageCode: 'my-MM',
      cfg: 'my_mm',
      rows,
      droppedRecords: 2, // 2 of 12 records carry no reference
      n: 6,
      usdPerMinute: null,
    });
    expect(e.expectedUnscoreable).toBeCloseTo((6 * 2) / 12, 9);
  });

  it('reports a language with no FLEURS config as a row, not an error', () => {
    const e = estimateAsr({
      languageCode: 'si-LK',
      cfg: null,
      rows: [],
      droppedRecords: 0,
      n: 30,
      usdPerMinute: 0.016,
    });
    expect(e.noEvalSet).toBe(true);
    expect(e.estimatedUsd).toBeNull();
    expect(e.estimatedSeconds).toBe(0);
  });

  it('caps the clip count at what the split actually holds', () => {
    const e = estimateAsr({
      languageCode: 'my-MM',
      cfg: 'my_mm',
      rows: rows.slice(0, 3),
      droppedRecords: 0,
      n: 30,
      usdPerMinute: null,
    });
    expect(e.clipsAvailable).toBe(3);
    expect(e.exact).toBe(true);
  });

  it('survives an empty split without dividing by zero', () => {
    const e = estimateAsr({
      languageCode: 'my-MM',
      cfg: 'my_mm',
      rows: [],
      droppedRecords: 0,
      n: 30,
      usdPerMinute: 0.016,
    });
    expect(e.meanClipSeconds).toBe(0);
    expect(e.estimatedSeconds).toBe(0);
    expect(e.expectedUnscoreable).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatDuration(582)).toBe('9m 42s');
    expect(formatDuration(605)).toBe('10m 05s');
    expect(formatDuration(60)).toBe('1m 00s');
  });

  it('carries 59.7s up to a whole minute rather than printing 0m 60s', () => {
    expect(formatDuration(59.7)).toBe('1m 00s');
  });

  /** `0m 00s` in a no-eval-set row reads as a measurement of nothing, not an absence. */
  it('renders nothing as an em dash', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('formatDryRun', () => {
  const est = (code: string, n: number, secs: number, usd: number | null) => ({
    languageCode: code,
    cfg: code.toLowerCase().replace('-', '_'),
    noEvalSet: false,
    clipsRequested: n,
    clipsAvailable: 400,
    meanClipSeconds: secs / n,
    estimatedSeconds: secs,
    exact: false,
    droppedRecords: 0,
    expectedUnscoreable: 0,
    usdPerMinute: 0.016,
    estimatedUsd: usd,
  });

  it('totals clips, audio and spend', () => {
    const out = formatDryRun([est('ha-NG', 30, 582, 0.155), est('yo-NG', 30, 558, 0.149)], 'google/chirp_2');
    expect(out).toContain('ha-NG');
    expect(out).toContain('TOTAL');
    expect(out).toContain('60');
    expect(out).toContain('$0.304');
  });

  /** An estimate that does not announce itself is the failure mode this whole file guards. */
  it('marks projected durations and explains why they are projections', () => {
    const out = formatDryRun([est('ha-NG', 30, 582, 0.155)], 'google/chirp_2');
    expect(out).toContain('~9m 42s');
    expect(out).toContain('tar order');
    expect(out).toContain('No audio was downloaded');
  });

  it('does not mark a total that is a genuine sum', () => {
    const exact = { ...est('ha-NG', 30, 582, 0.155), exact: true };
    const out = formatDryRun([exact], 'google/chirp_2');
    expect(out).toContain(' 9m 42s');
    expect(out).not.toContain('~');
    expect(out).not.toContain('estimated. The ASR sample');
  });

  it('renders a no-eval-set language without inventing a zero', () => {
    const none = { ...est('si-LK', 30, 0, null), noEvalSet: true, cfg: null, clipsAvailable: 0 };
    const out = formatDryRun([none], 'google/chirp_2');
    expect(out).toContain('si-LK');
    expect(out).toContain('no eval set');
    expect(out).not.toContain('0m 00s');
  });

  /**
   * Warned on *any* referenceless record rather than above an expected-loss threshold. A
   * threshold would be a chosen-not-measured number deciding whether a user hears that their
   * sample can shrink — and the one real pull lost a clip at n=30 where 0.3 was expected.
   */
  it('warns whenever the split holds a record with no reference, however few', () => {
    const lossy = { ...est('my-MM', 30, 450, 0.12), droppedRecords: 4, expectedUnscoreable: 0.31 };
    const out = formatDryRun([lossy], 'google/chirp_2');
    expect(out).toContain('note  my-MM');
    expect(out).toContain('no reference text');
    expect(out).toContain('may score fewer than 30');
  });

  it('stays quiet when every record has a reference', () => {
    const clean = { ...est('ha-NG', 30, 582, 0.155), droppedRecords: 0, expectedUnscoreable: 0 };
    expect(formatDryRun([clean], 'google/chirp_2')).not.toContain('note  ');
  });

  it('says unpriced rather than $0.000 when no rate exists', () => {
    const out = formatDryRun([{ ...est('ha-NG', 30, 582, null), usdPerMinute: null }], 'google/chirp_2');
    expect(out).toContain('unpriced');
  });
});
