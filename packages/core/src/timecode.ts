/**
 * Timecode formatting and parsing, in integer milliseconds.
 *
 * The old app's `lib/export.ts:15-22` formatted from float seconds and carried a live bug:
 * `formatTimestamp(59.9996, ',')` produced `00:00:59,1000` — a four-digit millisecond field
 * and malformed SRT, because the rounding never carried into the seconds. Working in
 * integer milliseconds and rounding exactly once, at the boundary where a float enters the
 * system, removes the whole class of error. `formatTimestamp` below is regression-tested
 * against that exact input.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

interface Parts {
  hours: number;
  minutes: number;
  seconds: number;
  ms: number;
  negative: boolean;
}

function split(totalMs: number): Parts {
  if (!Number.isFinite(totalMs)) throw new RangeError(`Not a finite duration: ${totalMs}`);
  const rounded = Math.round(totalMs);
  const negative = rounded < 0;
  let rest = Math.abs(rounded);
  const hours = Math.floor(rest / MS_PER_HOUR);
  rest -= hours * MS_PER_HOUR;
  const minutes = Math.floor(rest / MS_PER_MINUTE);
  rest -= minutes * MS_PER_MINUTE;
  const seconds = Math.floor(rest / MS_PER_SECOND);
  rest -= seconds * MS_PER_SECOND;
  return { hours, minutes, seconds, ms: rest, negative };
}

export interface FormatClockOptions {
  /** Include the millisecond field. Default true. */
  ms?: boolean;
  /** Always show hours, even below one hour. Default false — `01:23.400` reads better. */
  alwaysHours?: boolean;
}

/**
 * Human-facing clock: `01:23.400`, or `1:02:03.400` past an hour.
 *
 * This is the function the CLI's `--format text` and the editor's timecode gutter both
 * use, so a timestamp a journalist reads in the terminal matches the one in the browser.
 */
export function formatClock(totalMs: number, options: FormatClockOptions = {}): string {
  const { hours, minutes, seconds, ms, negative } = split(totalMs);
  const showHours = options.alwaysHours ?? hours > 0;
  const withMs = options.ms ?? true;

  const head = showHours
    ? `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`
    : `${pad(minutes, 2)}:${pad(seconds, 2)}`;

  return `${negative ? '-' : ''}${head}${withMs ? `.${pad(ms, 3)}` : ''}`;
}

/**
 * Subtitle-format timestamp: always `HH:MM:SS<sep>mmm`, zero-padded, hours never omitted.
 * SRT uses `,` and WebVTT uses `.`.
 */
export function formatTimestamp(totalMs: number, separator: ',' | '.' = ','): string {
  const { hours, minutes, seconds, ms } = split(Math.max(0, totalMs));
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(ms, 3)}`;
}

const CLOCK = /^(-)?(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;

/**
 * Parse `01:23.400`, `1:02:03,400`, `00:00:59` and friends back to integer milliseconds.
 * Returns null rather than throwing — this parses user input and a jump-to-timecode box
 * should not be able to crash the editor.
 */
export function parseClock(input: string): number | null {
  const match = CLOCK.exec(input.trim());
  if (!match) return null;
  const [, sign, hours, minutes, seconds, fraction] = match;
  // A one-digit fraction is tenths, two is hundredths. '4' is 400 ms, not 4 ms.
  const ms = fraction ? Number(fraction.padEnd(3, '0')) : 0;
  const total =
    Number(hours ?? 0) * MS_PER_HOUR +
    Number(minutes) * MS_PER_MINUTE +
    Number(seconds) * MS_PER_SECOND +
    ms;
  return sign ? -total : total;
}

/** Inclusive-start, exclusive-end overlap in ms. 0 when the intervals do not overlap. */
export function overlapMs(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

export function durationMs(a: { startMs: number; endMs: number }): number {
  return Math.max(0, a.endMs - a.startMs);
}
