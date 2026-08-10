import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { EngineContext } from '../context.js';

/**
 * Normalize to 16 kHz mono FLAC with loudness normalisation, and produce waveform peaks in
 * the same pass.
 *
 * The downmix is not cosmetic, and this finding is not re-derivable by reading the ffmpeg
 * invocation, so it travels verbatim from `lib/audio/chunk.ts:19-24`:
 *
 *   Normalizing to 16 kHz mono is not cosmetic: feeding a provider the raw 48 kHz stereo
 *   upload produced measurably worse transcripts than the same audio downmixed first. FLAC
 *   keeps it lossless while shrinking the payload, which matters against Google's 10 MB
 *   per-request cap.
 *
 * Two changes from the original. `loudnorm` is added, because ASR wants a consistent input
 * level. And normalization is decoupled from chunking and cached — which is what lets
 * Phase 3's diarization and Phase 4's local ASR consume the *same bytes* on the *same
 * timeline*, the precondition for reconciliation working at all.
 */

export const NORMALIZE = {
  kind: 'norm_16k_mono_flac',
  filter: 'aformat=channel_layouts=mono,aresample=16000,loudnorm=I=-16:TP=-1.5:LRA=11',
  codecArgs: ['-c:a', 'flac', '-compression_level', '8'],
} as const;

/**
 * `recipe_version = kind@sha256(filter + codecArgs)[0:8]`.
 *
 * Deriving it from the arguments means changing the loudnorm parameters invalidates every
 * cached derivative automatically. Nobody has to remember to bump a number, and nobody can
 * forget.
 */
export const RECIPE_VERSION = `${NORMALIZE.kind}@${createHash('sha256')
  .update(NORMALIZE.filter + NORMALIZE.codecArgs.join(' '))
  .digest('hex')
  .slice(0, 8)}`;

/** 20 buckets per second of min/max int8 — about 144 KB per audio-hour. */
export const PEAK_BUCKETS_PER_SECOND = 20;
const SAMPLE_RATE = 16_000;

export interface NormalizeOutput {
  flacPath: string;
  /** Interleaved min,max pairs as signed bytes. */
  peaks: Int8Array;
}

/**
 * Single-pass loudnorm, not two-pass.
 *
 * Two-pass (measure, then apply) is more accurate and doubles decode time. ASR wants a
 * consistent input level, not broadcast compliance. `normalize.twoPass` exists as the
 * escape hatch and defaults off.
 */
export async function runNormalize(
  ctx: EngineContext,
  inputPath: string,
  workDir: string,
): Promise<NormalizeOutput> {
  const flacPath = join(workDir, 'normalized.flac');

  // One invocation produces both outputs: the decode and the filter are the expensive
  // part, and running them twice to get waveform peaks separately is pure waste. This is
  // the reason FfmpegPort needs spawn() and not just run().
  const args = [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-filter_complex',
    `[0:a]${NORMALIZE.filter},asplit=2[a][b]`,
    '-map',
    '[a]',
    ...NORMALIZE.codecArgs,
    flacPath,
    '-map',
    '[b]',
    '-f',
    's16le',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    'pipe:1',
  ];

  const proc = ctx.ffmpeg.spawn('ffmpeg', args, ctx.signal ? { signal: ctx.signal } : {});
  const peaks = await reducePeaks(proc.stdout);
  await proc.done;

  return { flacPath, peaks };
}

/**
 * Reduce raw s16le PCM to min/max buckets.
 *
 * Consumed as a stream rather than buffered: a two-hour file is ~230 MB of PCM, which must
 * never become a Buffer just to compute 144 KB of peaks.
 */
export async function reducePeaks(
  stdout: NodeJS.ReadableStream,
  bucketsPerSecond = PEAK_BUCKETS_PER_SECOND,
): Promise<Int8Array> {
  const samplesPerBucket = Math.round(SAMPLE_RATE / bucketsPerSecond);
  const out: number[] = [];

  let min = 127;
  let max = -128;
  let inBucket = 0;
  // A 16-bit sample can straddle a chunk boundary; carry the odd byte across.
  let carry: number | null = null;

  const pushBucket = (): void => {
    out.push(min, max);
    min = 127;
    max = -128;
    inBucket = 0;
  };

  for await (const chunk of stdout as AsyncIterable<Buffer>) {
    let offset = 0;
    if (carry !== null && chunk.length > 0) {
      const sample = (chunk.readUInt8(0) << 8) | carry;
      const signed = sample >= 0x8000 ? sample - 0x10000 : sample;
      const scaled = signed >> 8;
      if (scaled < min) min = scaled;
      if (scaled > max) max = scaled;
      if (++inBucket >= samplesPerBucket) pushBucket();
      offset = 1;
      carry = null;
    }

    for (; offset + 1 < chunk.length; offset += 2) {
      const scaled = chunk.readInt16LE(offset) >> 8;
      if (scaled < min) min = scaled;
      if (scaled > max) max = scaled;
      if (++inBucket >= samplesPerBucket) pushBucket();
    }

    if (offset < chunk.length) carry = chunk.readUInt8(offset);
  }

  if (inBucket > 0) pushBucket();
  return Int8Array.from(out);
}

/** A readable over a finished normalize output, for uploading to the store. */
export function openNormalized(output: NormalizeOutput): NodeJS.ReadableStream {
  return createReadStream(output.flacPath);
}
