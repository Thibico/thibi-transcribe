import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { EngineContext } from '../../context.js';
import { IngestError } from '../errors.js';
import { ingestStream, type IngestedAsset } from '../upload.js';
import { HARDENING, matchFilter, assertUrlAllowed, type UrlPolicy } from './policy.js';
import type { ResolvedMedia, YtDlpPort } from './resolve.js';
import { verifyResolveToken } from './token.js';

/**
 * At most two downloads at once, instance-wide.
 *
 * An in-process counting semaphore is the Phase 8 shape. Phase 9 replaces it with a pg-boss
 * singleton key on the same function, which is why the limit is injected rather than read
 * here: swapping one for the other is configuration, not a rewrite.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      // Idempotent: the release runs in a finally that can be reached twice on some abort
      // paths, and a double release would let a third download through.
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

export interface DownloadUrlInput {
  resolveToken: string;
  /** What the resolve returned, for `source_meta`. Its duration is not trusted; the token's is. */
  resolved: ResolvedMedia;
  projectId?: string | null;
  userId?: string | null;
  onProgress?: (loaded: number, total: number | null) => void;
}

export interface UrlDownloadDeps {
  ytdlp: YtDlpPort;
  policy: UrlPolicy;
  appSecret: string;
  semaphore: Semaphore;
}

/**
 * Download a resolved URL and ingest it as an asset.
 *
 * The signed token is what makes this safe to call: it carries the duration and estimate the
 * user actually approved, so a URL whose content changed between resolve and confirm cannot
 * escalate the bill. Everything else here is containment — no shell, an argv array, a
 * hardened flag set, a size cap enforced twice, and a wall-clock timeout that kills the child.
 */
export async function downloadUrl(
  ctx: EngineContext,
  deps: UrlDownloadDeps,
  input: DownloadUrlInput,
): Promise<IngestedAsset> {
  const claim = verifyResolveToken(input.resolveToken, deps.appSecret, ctx.clock.now().getTime());

  // Re-checked at download time, not just at resolve time: the policy may have changed, and
  // this is the call that actually reaches the network.
  await assertUrlAllowed(claim.url, deps.policy);

  // The third duration guard. `--match-filter`'s `<?` operator passes when the field is
  // missing, so it cannot be relied on alone; this one reads the duration the user approved.
  if (claim.durationMs > deps.policy.maxDurationSeconds * 1000) {
    throw new IngestError(
      'file_too_large',
      'That media is longer than this instance allows for import.',
    );
  }

  const release = await deps.semaphore.acquire();
  try {
    await using dir = await ctx.tmp.dir('url-import');
    const argv = [
      ...HARDENING,
      '--match-filter',
      matchFilter(deps.policy.maxDurationSeconds),
      '--max-filesize',
      String(deps.policy.maxFilesizeBytes),
      // No re-encode: normalize owns the container, and transcoding here would cost an hour
      // of CPU to produce something normalize throws away.
      '-f',
      'bestaudio/best',
      '--paths',
      `temp:${dir.path}`,
      '--paths',
      `home:${dir.path}`,
      '--output',
      '%(id)s.%(ext)s',
      '--newline',
      '--progress-template',
      'PROG %(progress.downloaded_bytes)d %(progress.total_bytes_estimate)d',
      claim.url,
    ];

    const child = deps.ytdlp.spawn(argv, {
      signal: AbortSignal.timeout(deps.policy.downloadTimeoutMs),
    });

    if (input.onProgress) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        // The same callback drives the CLI bar here and a `run_events` emission in Phase 9.
        const m = /^PROG (\d+) (\d+|NA)$/.exec(line.trim());
        if (m) input.onProgress?.(Number(m[1]), m[2] === 'NA' ? null : Number(m[2]));
      });
    } else {
      child.stdout.resume();
    }
    child.stderr.resume();

    try {
      await child.done;
    } catch (err) {
      throw new IngestError(
        'unreadable_media',
        'The download failed. The media may have been removed, or is region-locked.',
        err instanceof Error ? err.message : String(err),
      );
    }

    const file = await soleMediaFile(dir.path);

    // The filename yt-dlp produced is never trusted as a name: `--restrict-filenames` already
    // mangles non-Latin titles, and the real title lives in source_meta. The asset is named
    // from the resolved title with the downloaded extension.
    const ext = file.name.includes('.') ? file.name.split('.').pop()! : 'm4a';
    const filename = `${input.resolved.title.slice(0, 180).replace(/[/\\]/g, '-')}.${ext}`;

    return await ingestStream(ctx, {
      stream: createReadStream(file.path),
      filename,
      contentType: 'application/octet-stream',
      source: 'url',
      // The cap applies again on the way to the store: a `--max-filesize` that yt-dlp
      // ignored, or a site that lies about its size, must not become an unbounded write.
      maxBytes: deps.policy.maxFilesizeBytes,
      userId: input.userId ?? null,
      sourceMeta: {
        kind: 'url',
        submittedUrl: claim.url,
        webpageUrl: input.resolved.webpageUrl,
        extractor: input.resolved.extractor,
        extractorId: input.resolved.extractorId,
        title: input.resolved.title,
        uploader: input.resolved.uploader,
        uploaderUrl: input.resolved.uploaderUrl,
        uploadDate: input.resolved.uploadDate,
        durationMs: claim.durationMs,
        thumbnailUrl: input.resolved.thumbnailUrl,
        ytdlpVersion: input.resolved.ytdlpVersion,
        resolvedAt: input.resolved.resolvedAt,
        importedBy: input.userId ?? null,
      },
    });
  } finally {
    release();
  }
}

/**
 * The one media file yt-dlp left in the temp directory.
 *
 * Asserted rather than assumed: `--no-playlist` should guarantee one, and if a site ever
 * returns more, silently taking the first would import an arbitrary item and bill for it.
 */
async function soleMediaFile(dir: string): Promise<{ path: string; name: string }> {
  const entries = await readdir(dir);
  const files: Array<{ path: string; name: string }> = [];
  for (const name of entries) {
    if (name.endsWith('.part') || name.endsWith('.ytdl')) continue;
    const path = join(dir, name);
    if ((await stat(path)).isFile()) files.push({ path, name });
  }
  if (files.length === 0) {
    throw new IngestError('unreadable_media', 'The download produced no media file.');
  }
  if (files.length > 1) {
    throw new IngestError(
      'unreadable_media',
      `The download produced ${files.length} files; expected one.`,
    );
  }
  return files[0]!;
}
