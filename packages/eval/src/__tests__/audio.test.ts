import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchClips } from '../fleurs/audio.js';

/**
 * `mini.tar.gz` is generated with a fixed seed and **incompressible** payloads, which is
 * the only property that matters: a tarball of silence gzips to nothing, every byte range
 * covers the whole archive, and the truncation behaviour this suite exists to test would
 * never fire.
 *
 * Layout: a `dev/` directory entry, eight `dev/clipNN.wav` of ~4 KB each, and a
 * `dev/README.txt` that must be skipped rather than taken as a clip.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const TARBALL = readFileSync(join(FIXTURES, 'mini.tar.gz'));

let server: Server;
let url: string;
/** Every Range header the server saw, so the doubling retry is observable. */
let ranges: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = req.headers.range;
    ranges.push(range ?? '(none)');
    const m = /^bytes=(\d+)-(\d+)$/u.exec(range ?? '');
    if (!m) {
      res.writeHead(200, { 'content-length': String(TARBALL.length) });
      res.end(TARBALL);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), TARBALL.length - 1);
    const slice = TARBALL.subarray(start, end + 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${TARBALL.length}`,
      'content-length': String(slice.length),
    });
    res.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no port');
  url = `http://127.0.0.1:${addr.port}/dev.tar.gz`;
}, 20_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchClips over a ranged tarball', () => {
  it('returns exactly N clips and stops there', async () => {
    ranges = [];
    const clips = await fetchClips('my_mm', 'dev', 3, { url, bytesPerClip: 5_000 });
    expect(clips).toHaveLength(3);
    expect(clips.map((c) => c.filename)).toEqual(['clip00.wav', 'clip01.wav', 'clip02.wav']);
  });

  it('skips the directory entry and the non-wav member without stalling', async () => {
    // README.txt sits after the eight wavs; asking for all eight proves the walk reached
    // the end without hanging on an undrained entry, and that `dev/` never became a clip.
    const clips = await fetchClips('my_mm', 'dev', 8, { url, bytesPerClip: 8_000 });
    expect(clips).toHaveLength(8);
    expect(clips.every((c) => c.filename.endsWith('.wav'))).toBe(true);
    expect(clips.map((c) => c.filename)).not.toContain('README.txt');
    expect(clips.map((c) => c.filename)).not.toContain('dev');
  });

  it('returns real bytes — a RIFF header per clip', async () => {
    const [clip] = await fetchClips('my_mm', 'dev', 1, { url, bytesPerClip: 6_000 });
    expect(clip!.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(clip!.bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(clip!.bytes.length).toBeGreaterThan(4_000);
  });

  /**
   * A ranged read cuts the gzip member mid-stream, so "unexpected end of file" is the
   * normal termination path. Asking for two clips from a prefix that comfortably holds two
   * must resolve, not reject — the discriminator is how many clips came back, never the
   * error type.
   */
  it('treats a truncated gzip as success when it still yielded N', async () => {
    const clips = await fetchClips('my_mm', 'dev', 2, { url, bytesPerClip: 4_500 });
    expect(clips).toHaveLength(2);
  });

  /**
   * The doubling loop is what stops an unusually long-clip config from quietly returning a
   * short sample and shrinking a CER's denominator without saying so.
   */
  it('doubles the byte range when the first prefix falls short', async () => {
    ranges = [];
    const attempts: Array<{ limit: number; got: number }> = [];
    const clips = await fetchClips('my_mm', 'dev', 6, {
      url,
      bytesPerClip: 700, // deliberately far too small: ~4.2 KB per clip in this fixture
      headroom: 0, // without this the opening range swallows the whole fixture
      onAttempt: (_a, limit, got) => attempts.push({ limit, got }),
    });

    expect(clips).toHaveLength(6);
    expect(attempts.length).toBeGreaterThan(1);
    // Each attempt asked for twice the previous budget...
    for (let i = 1; i < attempts.length; i++) {
      expect(attempts[i]!.limit).toBe(attempts[i - 1]!.limit * 2);
    }
    // ...and the server really was asked for a wider range each time.
    expect(ranges.length).toBe(attempts.length);
    expect(new Set(ranges).size).toBe(ranges.length);
  });

  it('gives up with a message naming the byte budget when N is unreachable', async () => {
    // Only eight wavs exist, so twenty can never be satisfied however wide the range gets.
    await expect(
      fetchClips('my_mm', 'dev', 20, { url, bytesPerClip: 500 }),
    ).rejects.toThrow(/could not reach 20 clips within \d+ bytes/u);
  });

  it('asks for nothing at all when n is zero', async () => {
    ranges = [];
    expect(await fetchClips('my_mm', 'dev', 0, { url })).toEqual([]);
    expect(ranges).toHaveLength(0);
  });

  it('surfaces a non-partial HTTP status as an error', async () => {
    const bad = `http://127.0.0.1:1/dev.tar.gz`;
    await expect(fetchClips('my_mm', 'dev', 1, { url: bad })).rejects.toThrow();
  });
});
