import type { EngineContext } from '../context.js';

/**
 * Silence boundaries are preferred split points — cutting mid-word costs accuracy at both
 * edges of the seam.
 *
 * Ported from `lib/audio/chunk.ts:36-59`, seconds converted to integer milliseconds. The
 * two operational notes in the original travel with it because neither is re-derivable
 * from reading the ffmpeg invocation.
 */
export async function detectSilences(
  ctx: EngineContext,
  input: { path: string },
): Promise<number[]> {
  try {
    // silencedetect reports on stderr and the null muxer produces no output file.
    const { stderr } = await ctx.ffmpeg.run(
      'ffmpeg',
      [
        '-v',
        'info',
        '-i',
        input.path,
        '-af',
        'silencedetect=n=-35dB:d=0.5',
        '-f',
        'null',
        '-',
      ],
      { maxBuffer: 10 * 1024 * 1024, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );

    const points: number[] = [];
    for (const match of stderr.matchAll(/silence_(?:start|end):\s*([0-9.]+)/g)) {
      const seconds = Number.parseFloat(match[1]!);
      if (Number.isFinite(seconds)) points.push(Math.round(seconds * 1000));
    }
    return points.sort((a, b) => a - b);
  } catch (err) {
    // Fall back to hard cuts. A file we cannot analyse is still transcribable; it just
    // splits on the clock instead of on pauses.
    ctx.logger.warn({ err }, 'silences: detection failed, falling back to hard cuts');
    return [];
  }
}
