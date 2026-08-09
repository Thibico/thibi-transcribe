import { describe, expect, it } from 'vitest';
import { durationMs, formatClock, formatTimestamp, overlapMs, parseClock } from '../timecode.js';

describe('formatTimestamp', () => {
  /**
   * The named regression. `lib/export.ts:15-22` in the old app formatted from float seconds
   * and produced `00:00:59,1000` for this input — a four-digit millisecond field and
   * malformed SRT, because rounding 999.6 ms to 1000 never carried into the seconds.
   */
  it('carries a rounded millisecond into the seconds field', () => {
    expect(formatTimestamp(59_999.6)).toBe('00:01:00,000');
    expect(formatTimestamp(59_999.6, '.')).toBe('00:01:00.000');
    // And the whole cascade: 59.9996 s of a 59th minute of a 23rd hour.
    expect(formatTimestamp(23 * 3600_000 + 59 * 60_000 + 59_999.6)).toBe('24:00:00,000');
  });

  it('always pads to HH:MM:SS,mmm', () => {
    expect(formatTimestamp(0)).toBe('00:00:00,000');
    expect(formatTimestamp(1)).toBe('00:00:00,001');
    expect(formatTimestamp(3_723_400)).toBe('01:02:03,400');
  });

  it('clamps a negative to zero rather than emitting an unparseable cue', () => {
    expect(formatTimestamp(-5)).toBe('00:00:00,000');
  });
});

describe('formatClock', () => {
  it('omits hours below an hour and shows them above', () => {
    expect(formatClock(83_400)).toBe('01:23.400');
    expect(formatClock(3_723_400)).toBe('01:02:03.400');
    expect(formatClock(83_400, { alwaysHours: true })).toBe('00:01:23.400');
  });

  it('can drop the millisecond field', () => {
    expect(formatClock(83_400, { ms: false })).toBe('01:23');
  });

  it('signs a negative offset', () => {
    expect(formatClock(-1500)).toBe('-00:01.500');
  });

  it('rejects a non-finite duration rather than emitting NaN:NaN', () => {
    expect(() => formatClock(Number.NaN)).toThrow(RangeError);
    expect(() => formatClock(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('parseClock', () => {
  it.each([
    ['01:23.400', 83_400],
    ['01:02:03,400', 3_723_400],
    ['00:00:59', 59_000],
    ['1:2:3', 3_723_000],
    ['-00:01.500', -1500],
    // A one-digit fraction is tenths and a two-digit fraction hundredths: '4' is 400 ms.
    ['00:01.4', 1400],
    ['00:01.04', 1040],
    ['00:01.004', 1004],
  ])('%s -> %d ms', (input, expected) => {
    expect(parseClock(input)).toBe(expected);
  });

  it('returns null rather than throwing on junk', () => {
    for (const junk of ['', 'abc', '::', '1', '99:99:99:99', 'DROP TABLE runs']) {
      expect(parseClock(junk)).toBeNull();
    }
  });

  it('round-trips with formatClock', () => {
    for (const ms of [0, 1, 999, 83_400, 3_723_400, 7_199_999]) {
      expect(parseClock(formatClock(ms, { alwaysHours: true }))).toBe(ms);
    }
  });
});

describe('interval helpers', () => {
  it('measures overlap and returns 0 for disjoint intervals', () => {
    expect(overlapMs({ startMs: 0, endMs: 100 }, { startMs: 50, endMs: 150 })).toBe(50);
    expect(overlapMs({ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 })).toBe(0);
    expect(overlapMs({ startMs: 0, endMs: 100 }, { startMs: 500, endMs: 600 })).toBe(0);
  });

  it('never reports a negative duration', () => {
    expect(durationMs({ startMs: 100, endMs: 50 })).toBe(0);
  });
});
