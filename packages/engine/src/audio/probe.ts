import type { EngineContext } from '../context.js';
import { UnsupportedMediaError } from '../errors.js';

export interface ProbeStream {
  codecName: string | null;
  codecType: string | null;
  channels?: number;
  sampleRate?: number;
}

export interface ProbeResult {
  /** null is a legitimate answer, not an error. See below. */
  durationMs: number | null;
  formatName: string | null;
  bitRate: number | null;
  bytes: number | null;
  hasAudio: boolean;
  streams: ProbeStream[];
  /** Stored whole in `media_assets.probe_raw`, so a later question needs no re-probe. */
  raw: unknown;
}

/**
 * ffprobe a file for duration, format and stream layout.
 *
 * Ported from `lib/audio/probe.ts:16-38`, keeping its graceful-nulls-not-throws behaviour.
 * The *justification* changes, though: the old comment said the UI falls back to the
 * `<audio>` element's own duration, and there is no browser here. So a null duration now
 * routes conservatively — the plan stage refuses to choose single-request `sync` without
 * one, and takes the chunked path instead.
 *
 * One new guard: a file with no audio stream throws. The old path would happily hand a PDF
 * to ffmpeg and surface a raw ffmpeg stderr dump to the journalist who uploaded it.
 */
export async function probe(
  ctx: EngineContext,
  input: { path: string },
): Promise<ProbeResult> {
  let parsed: {
    format?: { duration?: string; format_name?: string; bit_rate?: string; size?: string };
    streams?: Array<{
      codec_name?: string;
      codec_type?: string;
      channels?: number;
      sample_rate?: string;
    }>;
  };

  try {
    const { stdout } = await ctx.ffmpeg.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration,format_name,bit_rate,size:stream=codec_name,codec_type,channels,sample_rate',
        '-of',
        'json',
        input.path,
      ],
      ctx.signal ? { signal: ctx.signal } : {},
    );
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch (err) {
    // ffprobe missing or the file unreadable. Degrade rather than crash the ingest, but
    // say so — an unknown duration changes routing and cost estimation downstream.
    ctx.logger.warn({ err, path: input.path }, 'probe: ffprobe failed');
    return {
      durationMs: null,
      formatName: null,
      bitRate: null,
      bytes: null,
      hasAudio: false,
      streams: [],
      raw: null,
    };
  }

  const streams: ProbeStream[] = (parsed.streams ?? []).map((s) => ({
    codecName: s.codec_name ?? null,
    codecType: s.codec_type ?? null,
    ...(s.channels !== undefined ? { channels: s.channels } : {}),
    ...(s.sample_rate !== undefined ? { sampleRate: Number(s.sample_rate) } : {}),
  }));

  const hasAudio = streams.some((s) => s.codecType === 'audio');
  if (!hasAudio) {
    throw new UnsupportedMediaError(
      `No audio stream in ${input.path.split('/').pop()}. ` +
        `Supported inputs are audio and video files with an audio track.`,
      { hint: 'If this is a video, confirm it has an audio track: ffprobe -show_streams <file>' },
    );
  }

  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? '');
  const bitRate = Number.parseInt(parsed.format?.bit_rate ?? '', 10);
  const bytes = Number.parseInt(parsed.format?.size ?? '', 10);

  return {
    // Integer milliseconds, rounded exactly once, here.
    durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null,
    formatName: parsed.format?.format_name ?? null,
    bitRate: Number.isFinite(bitRate) ? bitRate : null,
    bytes: Number.isFinite(bytes) ? bytes : null,
    hasAudio,
    streams,
    raw: parsed,
  };
}
