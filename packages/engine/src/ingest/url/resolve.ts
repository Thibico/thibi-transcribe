import type { Readable } from 'node:stream';
import { IngestError } from '../errors.js';
import { assertUrlAllowed, HARDENING, type UrlPolicy } from './policy.js';

/**
 * The yt-dlp subprocess, as a port.
 *
 * Note there is no `bin` parameter, unlike `FfmpegPort`. The port *is* yt-dlp, so no call site
 * can pass a different binary — the argv is the only thing a caller controls, and it is always
 * an array, never a string, never a shell.
 *
 * Optional on the context: an instance with `INGEST_URL_ENABLED=false`, or simply without
 * yt-dlp installed, is a supported configuration rather than a broken one.
 */
export interface YtDlpPort {
  run(
    args: string[],
    opts?: { signal?: AbortSignal; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }>;
  spawn(
    args: string[],
    opts?: { signal?: AbortSignal },
  ): { stdout: Readable; stderr: Readable; done: Promise<void> };
}

export interface ResolvedMedia {
  webpageUrl: string;
  extractor: string;
  extractorId: string;
  title: string;
  uploader: string | null;
  uploaderUrl: string | null;
  /** 'YYYY-MM-DD', converted from yt-dlp's YYYYMMDD. */
  uploadDate: string | null;
  durationMs: number;
  filesizeApproxBytes: number | null;
  thumbnailUrl: string | null;
  ytdlpVersion: string;
  resolvedAt: string;
}

interface RawInfo {
  webpage_url?: string;
  extractor?: string;
  extractor_key?: string;
  id?: string;
  title?: string;
  uploader?: string;
  uploader_url?: string;
  upload_date?: string;
  duration?: number | null;
  filesize_approx?: number | null;
  thumbnail?: string;
  is_live?: boolean;
  _version?: { version?: string };
}

/**
 * Read a URL's metadata without downloading any media.
 *
 * `--dump-json --simulate` costs one metadata request, and everything the confirmation needs —
 * the real title, the real duration, therefore the real cost — comes from it. That is why URL
 * import is two steps rather than one: **knowing the duration before committing to the
 * download is the safety property**, because duration is unknown until metadata returns and
 * that is exactly the moment a surprise bill is created.
 */
export async function resolveUrl(
  deps: { ytdlp: YtDlpPort; policy: UrlPolicy; clock: { now(): Date } },
  url: string,
): Promise<ResolvedMedia> {
  // Before anything is spawned.
  await assertUrlAllowed(url, deps.policy);

  let stdout: string;
  try {
    ({ stdout } = await deps.ytdlp.run(
      ['--dump-json', '--simulate', '--no-warnings', ...HARDENING, url],
      {
        signal: AbortSignal.timeout(deps.policy.resolveTimeoutMs),
        maxBuffer: 8 << 20,
      },
    ));
  } catch (err) {
    throw new IngestError(
      'unreadable_media',
      'Could not read that URL. It may be private, region-locked, or unsupported.',
      err instanceof Error ? err.message : String(err),
    );
  }

  let info: RawInfo;
  try {
    // `--no-playlist` keeps this to one object, but a site that ignores it would emit
    // newline-delimited JSON; taking the first line is safer than JSON.parse throwing on
    // the second.
    info = JSON.parse(stdout.trim().split('\n')[0] ?? '') as RawInfo;
  } catch {
    throw new IngestError('unreadable_media', 'yt-dlp returned something that is not JSON.');
  }

  if (info.is_live) {
    throw new IngestError('live_stream', 'Live streams cannot be imported.');
  }
  // The independent check the `<?` match filter cannot make. Without a duration there is no
  // estimate, and importing something whose cost cannot be shown defeats the two-step flow.
  if (info.duration == null || !Number.isFinite(info.duration) || info.duration <= 0) {
    throw new IngestError(
      'unknown_duration',
      'The site did not report a duration, so the cost of this import cannot be estimated.',
    );
  }
  if (info.duration > deps.policy.maxDurationSeconds) {
    throw new IngestError(
      'file_too_large',
      `That media is ${Math.round(info.duration / 60)} minutes, over this instance's ` +
        `${Math.round(deps.policy.maxDurationSeconds / 60)}-minute import limit.`,
    );
  }

  // The resolved page can be a different host from the submitted URL — a shortener, or an
  // extractor following through to the real site — so the allowlist is applied again to what
  // it actually landed on.
  const webpageUrl = info.webpage_url ?? url;
  if (webpageUrl !== url) await assertUrlAllowed(webpageUrl, deps.policy);

  return {
    webpageUrl,
    extractor: info.extractor ?? info.extractor_key ?? 'unknown',
    extractorId: info.id ?? '',
    title: info.title ?? 'Untitled',
    uploader: info.uploader ?? null,
    uploaderUrl: info.uploader_url ?? null,
    uploadDate: formatUploadDate(info.upload_date),
    durationMs: Math.round(info.duration * 1000),
    filesizeApproxBytes: info.filesize_approx ?? null,
    // Stored, never fetched by the server: rendering it would make the app issue an outbound
    // request per job-list row, which is a tracking beacon the operator did not agree to.
    thumbnailUrl: info.thumbnail ?? null,
    ytdlpVersion: info._version?.version ?? 'unknown',
    resolvedAt: deps.clock.now().toISOString(),
  };
}

function formatUploadDate(raw: string | undefined): string | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}
