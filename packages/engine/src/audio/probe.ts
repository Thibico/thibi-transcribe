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
  /**
   * Why the probe degraded, or null when it succeeded.
   *
   * Without this, the degraded return below is indistinguishable from a file that genuinely
   * has no audio, and ingest answers "this file has no audio stream" when the real problem is
   * that nobody installed ffprobe. Those need opposite responses: one is a 400 the uploader
   * can act on, the other a 500 only an operator can. Added in Phase 8 for that reason —
   * `ffprobe_missing` is an ENOENT from the spawn, `unreadable` is ffprobe running and
   * failing, which is a genuine problem with the bytes.
   */
  failure: { reason: 'ffprobe_missing' | 'unreadable'; detail: string } | null;
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
    //
    // Which of the two it was is now recorded rather than flattened. ENOENT means the binary
    // is absent, which is the operator's problem and must never be reported as a defect in
    // the user's file; anything else means ffprobe ran and refused the bytes.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const reason = code === 'ENOENT' ? 'ffprobe_missing' : 'unreadable';
    ctx.logger.warn({ err, path: input.path, reason }, 'probe: ffprobe failed');
    return {
      durationMs: null,
      formatName: null,
      bitRate: null,
      bytes: null,
      hasAudio: false,
      streams: [],
      raw: null,
      failure: { reason, detail: err instanceof Error ? err.message : String(err) },
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
    failure: null,
  };
}
