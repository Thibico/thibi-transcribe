import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTsv, type FleursRow } from '../fleurs/tsv.js';
import type { Clip } from '../fleurs/audio.js';
import {
  dedupeById,
  describeSample,
  joinTarOrder,
  sampleSeeded,
  selectSeeded,
} from '../sample.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const head = parseTsv(readFileSync(join(FIXTURES, 'my_mm_dev_head.tsv'), 'utf8')).rows;

function row(id: number, filename: string, gender = 'FEMALE', numSamples = 16_000): FleursRow {
  return { id, filename, raw: `raw ${id}`, plain: `plain ${id}`, graphemes: 'g', numSamples, gender };
}

describe('dedupeById', () => {
  it('keeps the first row per id, in file order', () => {
    const rows = [row(2, 'b.wav'), row(1, 'a.wav'), row(2, 'c.wav'), row(1, 'd.wav')];
    const { rows: out, duplicatesRemoved } = dedupeById(rows);
    expect(out.map((r) => r.filename)).toEqual(['b.wav', 'a.wav']);
    expect(duplicatesRemoved).toBe(2);
  });

  it('reports zero removals when every id is distinct', () => {
    expect(dedupeById([row(1, 'a.wav'), row(2, 'b.wav')]).duplicatesRemoved).toBe(0);
  });

  it('handles an empty split', () => {
    expect(dedupeById([])).toEqual({ rows: [], duplicatesRemoved: 0 });
  });

  /**
   * The measured reason this function exists. The 20-row fixture is real FLEURS data and
   * already carries duplicate ids; the full split is 380 rows over 148 ids.
   */
  it('finds real duplicate ids in the committed fixture', () => {
    const { duplicatesRemoved } = dedupeById(head);
    expect(duplicatesRemoved).toBeGreaterThan(0);
    expect(new Set(head.map((r) => r.id)).size).toBeLessThan(head.length);
  });
});

describe('sampleSeeded', () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(i + 1, `f${i + 1}.wav`));

  it('is reproducible for a given seed', () => {
    const a = sampleSeeded(rows, 10, 7);
    const b = sampleSeeded(rows, 10, 7);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });

  it('gives a different sample for a different seed', () => {
    const a = sampleSeeded(rows, 10, 1).map((r) => r.id);
    const b = sampleSeeded(rows, 10, 2).map((r) => r.id);
    expect(a).not.toEqual(b);
  });

  it('never returns the same id twice, even when the input repeats ids', () => {
    const dupes = [...rows, ...rows, ...rows];
    const picked = sampleSeeded(dupes, 20, 3);
    expect(new Set(picked.map((r) => r.id)).size).toBe(picked.length);
  });

  it('returns everything available when n exceeds the deduped split', () => {
    expect(sampleSeeded([row(1, 'a.wav'), row(1, 'b.wav')], 30, 1)).toHaveLength(1);
  });

  /**
   * Sorting by id before the shuffle is what makes the seed the only source of order. If
   * file order leaked through, a FLEURS reshuffle would silently change the sample a runlog
   * claims to reproduce.
   */
  it('does not depend on the order rows arrived in', () => {
    const shuffledInput = [...rows].reverse();
    const a = sampleSeeded(rows, 10, 5).map((r) => r.id);
    const b = sampleSeeded(shuffledInput, 10, 5).map((r) => r.id);
    expect(a).toEqual(b);
  });

  it('takes exactly n', () => {
    expect(sampleSeeded(rows, 12, 1)).toHaveLength(12);
    expect(sampleSeeded(rows, 0, 1)).toHaveLength(0);
  });
});

describe('joinTarOrder', () => {
  const clip = (filename: string): Clip => ({ filename, bytes: Buffer.from('RIFF') });

  it('pairs clips with their reference row and preserves tar order', () => {
    const rows = [row(1, 'a.wav'), row(2, 'b.wav'), row(3, 'c.wav')];
    const { pairs, unmatched } = joinTarOrder([clip('b.wav'), clip('a.wav')], rows);
    expect(pairs.map((p) => p.clip.filename)).toEqual(['b.wav', 'a.wav']);
    expect(pairs.map((p) => p.row.id)).toEqual([2, 1]);
    expect(unmatched).toEqual([]);
  });

  it('counts a clip with no TSV row instead of dropping it quietly', () => {
    const { pairs, unmatched } = joinTarOrder([clip('ghost.wav')], [row(1, 'a.wav')]);
    expect(pairs).toEqual([]);
    expect(unmatched).toEqual(['ghost.wav']);
  });

  /**
   * Tar order is not ours to choose without downloading more tarball, so a repeated
   * sentence stays in the sample and is reported by `describeSample` rather than silently
   * reducing the clip count the caller paid to download.
   */
  it('does not dedupe by id — that is the composition report\'s job', () => {
    const rows = [row(1, 'a.wav'), row(1, 'b.wav')];
    const { pairs } = joinTarOrder([clip('a.wav'), clip('b.wav')], rows);
    expect(pairs).toHaveLength(2);
    expect(describeSample(pairs.map((p) => p.row)).distinctIds).toBe(1);
  });
});

describe('describeSample', () => {
  it('reports distinct ids, not just clip count', () => {
    const c = describeSample([row(1, 'a.wav'), row(1, 'b.wav'), row(2, 'c.wav')]);
    expect(c.clips).toBe(3);
    expect(c.distinctIds).toBe(2);
  });

  it('computes audio seconds from column 5 with no audio downloaded', () => {
    const c = describeSample([row(1, 'a.wav', 'FEMALE', 305_280), row(2, 'b.wav', 'MALE', 16_000)]);
    expect(c.totalSeconds).toBeCloseTo(305_280 / 16_000 + 1, 6);
  });

  /**
   * Amendment 68. A gender split of one value across n rows is a finding, not a column —
   * it means the split cannot serve as evidence of speaker diversity, which is exactly the
   * job §5 risk 2 assigned it.
   */
  it('flags a gender distribution with no width at all', () => {
    const uniform = describeSample([row(1, 'a.wav', 'FEMALE'), row(2, 'b.wav', 'FEMALE')]);
    expect(uniform.gender).toEqual({ FEMALE: 2 });
    expect(uniform.genderUniform).toBe(true);

    const mixed = describeSample([row(1, 'a.wav', 'FEMALE'), row(2, 'b.wav', 'MALE')]);
    expect(mixed.genderUniform).toBe(false);
  });

  it('is not uniform when there is nothing to be uniform about', () => {
    expect(describeSample([]).genderUniform).toBe(false);
  });

  /** The committed fixture is real data, and it is female-only like the rest of the split. */
  it('reports the real fixture as gender-uniform', () => {
    const c = describeSample(head);
    expect(c.genderUniform).toBe(true);
    expect(Object.keys(c.gender)).toEqual(['FEMALE']);
    expect(c.distinctIds).toBeLessThan(c.clips);
  });
});

/**
 * Risk 2's mitigation. Tar order is free and deterministic, and nothing had ever checked
 * whether it quietly selects something — this is the strategy that makes that checkable.
 */
describe('selectSeeded', () => {
  const pair = (id: number, filename: string) => ({
    clip: { filename, bytes: Buffer.from(filename) },
    row: {
      id,
      filename,
      raw: 'x',
      plain: 'x',
      graphemes: '',
      numSamples: 16_000,
      gender: 'FEMALE',
    },
  });

  const wide = Array.from({ length: 20 }, (_, i) => pair(100 + i, `${i}.wav`));

  it('takes N, and the same N for the same seed', () => {
    const a = selectSeeded(wide, 5, 7);
    const b = selectSeeded(wide, 5, 7);
    expect(a).toHaveLength(5);
    expect(a.map((p) => p.row.id)).toEqual(b.map((p) => p.row.id));
  });

  it('takes a different sample for a different seed', () => {
    const a = selectSeeded(wide, 5, 1).map((p) => p.row.id);
    const b = selectSeeded(wide, 5, 2).map((p) => p.row.id);
    expect(a).not.toEqual(b);
  });

  /** The whole point: it must not be the prefix it was handed. */
  it('does not simply return the first N', () => {
    const picked = selectSeeded(wide, 5, 1).map((p) => p.row.id);
    const prefix = wide.slice(0, 5).map((p) => p.row.id);
    expect(picked).not.toEqual(prefix);
  });

  /**
   * `my_mm/dev` carries 380 rows over 148 distinct sentences, so a shuffle over *rows* would
   * still let one sentence appear several times in a sample. Dedupe first.
   */
  it('keeps one clip per sentence id', () => {
    const dupes = [pair(1, 'a.wav'), pair(1, 'b.wav'), pair(2, 'c.wav'), pair(2, 'd.wav')];
    const picked = selectSeeded(dupes, 4, 1);
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((p) => p.row.id)).size).toBe(2);
  });

  it('returns everything it has when asked for more than it was given', () => {
    expect(selectSeeded(wide.slice(0, 3), 10, 1)).toHaveLength(3);
  });

  /**
   * File order varies with whatever FLEURS reshuffled last, so sorting by id before the
   * shuffle is what makes the seed the only source of order — and therefore what makes a
   * sample reproducible from a runlog on a machine that fetched a different prefix.
   */
  it('depends on the seed rather than on the order it was handed', () => {
    const shuffledInput = [...wide].reverse();
    expect(selectSeeded(shuffledInput, 5, 3).map((p) => p.row.id)).toEqual(
      selectSeeded(wide, 5, 3).map((p) => p.row.id),
    );
  });
});
