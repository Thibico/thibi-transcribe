/**
 * The scorer, checked against cases whose answer can be worked out by hand.
 *
 * This is an instrument, and an instrument that is wrong is worse than no instrument: Phase
 * 5 is going to move `reconcile.ts`'s thresholds on the numbers it prints. So every case
 * here has an arithmetic answer stated in the test rather than a golden value recorded from
 * a first run.
 */
import { describe, expect, it } from 'vitest';
import { parseRttm, scoreDiarization } from '../score.js';
import type { Turn } from '../types.js';

describe('parseRttm', () => {
  it('reads SPEAKER lines and ignores comments and other types', () => {
    const turns = parseRttm(
      [
        ';; a comment',
        'SPEAKER interview 1 0.000 4.120 <NA> <NA> spk_A <NA> <NA>',
        'SPKR-INFO interview 1 <NA> <NA> <NA> unknown spk_A <NA> <NA>',
        'SPEAKER interview 1 4.500 2.250 <NA> <NA> spk_B <NA> <NA>',
        '',
      ].join('\n'),
    );
    expect(turns).toEqual([
      { fileId: 'interview', startMs: 0, endMs: 4120, speakerKey: 'spk_A' },
      { fileId: 'interview', startMs: 4500, endMs: 6750, speakerKey: 'spk_B' },
    ]);
  });

  it('refuses a truncated line rather than inventing a turn', () => {
    expect(() => parseRttm('SPEAKER f 1 0.0 1.0')).toThrow(/at least 8/);
  });

  it('refuses a non-numeric time', () => {
    expect(() => parseRttm('SPEAKER f 1 start 1.0 <NA> <NA> A <NA> <NA>')).toThrow(/non-numeric/);
  });
});

describe('scoreDiarization', () => {
  const ref: Turn[] = [
    { startMs: 0, endMs: 10_000, speakerKey: 'A' },
    { startMs: 10_000, endMs: 20_000, speakerKey: 'B' },
  ];

  it('scores a perfect hypothesis with permuted labels as zero', () => {
    // The case the Hungarian mapping exists for: right diarization, shuffled numbering.
    const hyp: Turn[] = [
      { startMs: 0, endMs: 10_000, speakerKey: 'SPEAKER_01' },
      { startMs: 10_000, endMs: 20_000, speakerKey: 'SPEAKER_00' },
    ];
    const s = scoreDiarization(ref, hyp);
    expect(s.der).toBe(0);
    expect(s.jer).toBe(0);
    expect(s.mapping).toEqual([
      { reference: 'A', hypothesis: 'SPEAKER_01', overlapMs: 10_000 },
      { reference: 'B', hypothesis: 'SPEAKER_00', overlapMs: 10_000 },
    ]);
  });

  it('counts a missing second half as miss, not confusion', () => {
    const s = scoreDiarization(ref, [{ startMs: 0, endMs: 10_000, speakerKey: 'X' }]);
    expect(s.missMs).toBe(10_000);
    expect(s.confusionMs).toBe(0);
    expect(s.falseAlarmMs).toBe(0);
    expect(s.der).toBeCloseTo(0.5, 10);
    // B was never mapped, so its Jaccard is 0 and its JER is 1; A's is perfect. Mean 0.5.
    expect(s.jer).toBeCloseTo(0.5, 10);
  });

  it('counts a swapped attribution as confusion', () => {
    const s = scoreDiarization(ref, [
      { startMs: 0, endMs: 15_000, speakerKey: 'P' },
      { startMs: 15_000, endMs: 20_000, speakerKey: 'Q' },
    ]);
    // P maps to A (10 s overlap beats Q's 5 s), Q maps to B. The 10-15 s slice has B in the
    // reference and P in the hypothesis: one speaker each, none of them the mapped pair.
    expect(s.confusionMs).toBe(5000);
    expect(s.missMs).toBe(0);
    expect(s.falseAlarmMs).toBe(0);
    expect(s.der).toBeCloseTo(0.25, 10);
  });

  it('counts speech invented in silence as false alarm', () => {
    const s = scoreDiarization(ref, [
      ...ref,
      { startMs: 20_000, endMs: 24_000, speakerKey: 'ghost' },
    ]);
    expect(s.falseAlarmMs).toBe(4000);
    expect(s.der).toBeCloseTo(0.2, 10);
  });

  it('counts overlap twice in the denominator, so a non-overlapping system cannot score zero', () => {
    // The honesty note that belongs with any published figure: a source that never emits
    // overlap has a floor equal to the overlap fraction, and it is not visible in the DER.
    const overlapping: Turn[] = [
      { startMs: 0, endMs: 10_000, speakerKey: 'A' },
      { startMs: 4000, endMs: 6000, speakerKey: 'B' },
    ];
    const s = scoreDiarization(overlapping, [{ startMs: 0, endMs: 10_000, speakerKey: 'A' }]);
    expect(s.totalMs).toBe(12_000);
    expect(s.missMs).toBe(2000);
    expect(s.der).toBeCloseTo(2000 / 12_000, 10);
  });

  it('never invents a mapping for a hypothesis speaker that overlaps nothing', () => {
    const s = scoreDiarization(ref, [
      { startMs: 0, endMs: 20_000, speakerKey: 'one' },
      { startMs: 40_000, endMs: 41_000, speakerKey: 'elsewhere' },
    ]);
    expect(s.mapping).toHaveLength(1);
    expect(s.mapping[0]!.hypothesis).toBe('one');
    expect(s.hypothesisSpeakers).toBe(2);
  });

  it('refuses to score against an empty reference', () => {
    expect(() => scoreDiarization([], ref)).toThrow(/no speech/);
  });
});
