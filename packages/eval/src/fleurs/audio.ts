import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';

/**
 * The ranged-tarball stream.
 *
 * FLEURS publishes no per-file audio URL and its rows API returns `Scan size limit
 * exceeded` for this dataset, so a byte prefix of the split tarball is the only cheap route
 * to audio: `my_mm` dev is 281 MB and a 30-clip sample needs ~27 MB of it. Request a
 * prefix, gunzip it, walk it with `tar-stream`, take N complete entries, abort.
 *
 * Four things bite whoever writes this from scratch, all of them the reason this file has
 * more comment than code:
 *
 * - **`.pipe()` does not forward errors.** All three streams need handlers, and `abort()`
 *   surfaces as an `AbortError` on the *source*, never on the tar extractor.
 * - **A skipped entry must be drained**, or `tar-stream` never emits the next one and the
 *   promise hangs until the test timeout rather than failing.
 * - **Truncated gzip is the success path.** Cutting a gzip member mid-stream is what a
 *   ranged read *does*; the discriminator is `out.length`, never the error type.
 * - **The first entry is the `<split>/` directory**, so `header.type === 'file'` is load
 *   bearing, not defensive.
 *
 * Determinism: tar order is lexicographic over random-hash filenames, so it correlates with
 * nothing in the data. "The first N entries" is therefore a random-but-reproducible sample —
 * the same `(cfg, split, n)` yields the same clips on every machine, with no seed.
 */

const HF = 'https://huggingface.co';
const REPO = 'datasets/google/fleurs';

/** Measured ~730 KB compressed per clip; margin for configs with longer sentences. */
const BYTES_PER_CLIP = 900_000;
const HEADROOM = 1_000_000;
const MAX_ATTEMPTS = 4;

export interface Clip {
  filename: string;
  bytes: Buffer;
}

export interface FetchClipsOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overrides the derived URL. Tests point this at a local range-capable server. */
  url?: string;
  bytesPerClip?: number;
  /**
   * Flat allowance added to the first range, on top of `n * bytesPerClip`.
   *
   * Injectable for the same reason `bytesPerClip` is, and the retry test is the reason it
   * had to become one: at a fixed 1 MB, the opening range covers any fixture small enough
   * to commit, so the doubling loop below could never be reached by a test — the code path
   * that protects a real sweep's sample size was the one path nothing could exercise.
   */
  headroom?: number;
  /** Reported so a caller can log what the range doubling actually cost. */
  onAttempt?: (attempt: number, limit: number, got: number) => void;
}

/**
 * Exactly `n` clips, or an error naming the byte budget it gave up at.
 *
 * The doubling loop exists because `BYTES_PER_CLIP` is a measurement of one config, and a
 * language whose sentences run long would otherwise silently return fewer clips than the
 * sample size asked for — which would shrink the denominator of a CER without saying so.
 */
export async function fetchClips(
  cfg: string,
  split: string,
  n: number,
  opts: FetchClipsOptions = {},
): Promise<Clip[]> {
  if (n <= 0) return [];
  const perClip = opts.bytesPerClip ?? BYTES_PER_CLIP;
  let limit = n * perClip + (opts.headroom ?? HEADROOM);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { clips, error } = await streamPrefix(cfg, split, n, limit, opts);
    opts.onAttempt?.(attempt, limit, clips.length);
    if (clips.length >= n) return clips.slice(0, n);
    lastError = error;
    limit *= 2;
  }
  throw new Error(
    `FLEURS ${cfg}/${split}: could not reach ${n} clips within ${limit} bytes after ${MAX_ATTEMPTS} attempts` +
      (lastError instanceof Error ? ` (last stream error: ${lastError.message})` : ''),
    lastError instanceof Error ? { cause: lastError } : undefined,
  );
}

/**
 * Returns whatever the prefix yielded, plus the error that ended the stream if one did.
 *
 * It deliberately does **not** reject on a short read, and that is a correction to §5.3's
 * snippet rather than a variation on it. There, `streamPrefix` rejects whenever
 * `out.length < n`, which makes `fetchClips`'s `if (clips.length >= n) return` always true
 * and its `limit *= 2` unreachable: the doubling retry the plan describes could never fire,
 * and a config of long clips would surface as `unexpected end of file` instead of a wider
 * second request. Deciding "enough or not" belongs to the caller that owns the budget.
 *
 * HTTP-level failures still throw from here, before any streaming — those are not something
 * a wider range would fix.
 */
async function streamPrefix(
  cfg: string,
  split: string,
  n: number,
  limit: number,
  opts: FetchClipsOptions,
): Promise<{ clips: Clip[]; error: unknown }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.url ?? `${HF}/${REPO}/resolve/main/data/${cfg}/audio/${split}.tar.gz`;

  const ac = new AbortController();
  const res = await fetchImpl(url, {
    headers: { Range: `bytes=0-${limit - 1}` },
    signal: ac.signal,
    redirect: 'follow',
  });
  // 200 is accepted because a server may ignore Range; the prefix logic still holds, it
  // just costs the whole file. 206 is the path that saves the 281 MB.
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`FLEURS audio ${cfg}/${split}: HTTP ${res.status}`);
  }
  if (!res.body) throw new Error(`FLEURS audio ${cfg}/${split}: empty body`);

  const out: Clip[] = [];
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  const gunzip = createGunzip();
  const tar = extract();

  let streamError: unknown = null;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Cutting a gzip member mid-stream is what a ranged read *does*, so an error here is
    // the ordinary end of the prefix. It is recorded and returned rather than thrown: only
    // the caller knows whether the clips collected so far are enough.
    const settle = (err: unknown) => {
      if (settled) return;
      streamError = err;
      settled = true;
      resolve();
    };

    source.on('error', settle);
    gunzip.on('error', settle);
    tar.on('error', settle);
    tar.on('finish', finish);

    tar.on('entry', (header, stream, next) => {
      const take = out.length < n && header.type === 'file' && header.name.endsWith('.wav');
      if (!take) {
        stream.on('end', next);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (d: Buffer) => chunks.push(d));
      stream.on('end', () => {
        out.push({
          filename: header.name.split('/').pop()!,
          bytes: Buffer.concat(chunks),
        });
        if (out.length >= n) {
          ac.abort();
          finish();
          return;
        }
        next();
      });
    });

    source.pipe(gunzip).pipe(tar);
  }).finally(() => {
    ac.abort();
  });

  return { clips: out, error: streamError };
}
