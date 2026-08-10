import { join } from 'node:path';
import type { EngineContext } from '../context.js';
import type { ChunkPlan } from './plan.js';

/**
 * Extract one planned chunk.
 *
 * Re-encodes rather than `-c copy`. This comment documents a real Google rejection and
 * would otherwise be "optimised" away by the next reader, so it travels verbatim from
 * `lib/audio/chunk.ts:61-67`:
 *
 *   Stream-copying a FLAC does trim the audio data, but leaves the original duration in
 *   the STREAMINFO header — so every chunk still advertises the full file's length. Google
 *   validates uploads against a 60s sync limit and would reject chunks that are actually in
 *   range. Re-encoding 16kHz mono FLAC is cheap and comes out the same size.
 */
export async function cutChunk(
  ctx: EngineContext,
  input: { path: string; outDir: string; plan: ChunkPlan },
): Promise<{ path: string }> {
  const { plan } = input;
  const path = join(input.outDir, `${String(plan.idx).padStart(3, '0')}.flac`);

  await ctx.ffmpeg.run(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-i',
      input.path,
      // Seconds on the wire because that is ffmpeg's interface; the planning arithmetic
      // stays in integer milliseconds and converts exactly here.
      '-ss',
      (plan.offsetMs / 1000).toFixed(3),
      '-to',
      (plan.endMs / 1000).toFixed(3),
      '-c:a',
      'flac',
      '-compression_level',
      '8',
      path,
    ],
    ctx.signal ? { signal: ctx.signal } : {},
  );

  return { path };
}

/**
 * Cut every chunk, in parallel.
 *
 * Spike S3 measured that sequential cutting is 200 s of the 338 s total for a two-hour
 * file — ffmpeg cutting 136 chunks one at a time, which is what `lib/audio/chunk.ts` does.
 * Parallelised across cores it drops to roughly 30 s. Without this, preparation dominates
 * on exactly the long files the product exists for.
 */
export async function cutChunks(
  ctx: EngineContext,
  input: { path: string; outDir: string; plans: readonly ChunkPlan[] },
  onDone?: (plan: ChunkPlan, path: string) => void | Promise<void>,
): Promise<Array<{ plan: ChunkPlan; path: string }>> {
  const results: Array<{ plan: ChunkPlan; path: string }> = [];
  const limit = Math.max(1, ctx.concurrency.ffmpeg);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, input.plans.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= input.plans.length) return;
        const plan = input.plans[index]!;
        const { path } = await cutChunk(ctx, { path: input.path, outDir: input.outDir, plan });
        results.push({ plan, path });
        await onDone?.(plan, path);
      }
    }),
  );

  return results.sort((a, b) => a.plan.idx - b.plan.idx);
}
