import { Readable } from 'node:stream';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import { MemoryObjectStore, createTempDirPort } from '@thibi/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineContext } from '../../context.js';
import { IngestError } from '../errors.js';
import { ingestStream } from '../upload.js';

const BASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);

/** An ffprobe response for a real-looking one-audio-stream file. */
const PROBE_OK = JSON.stringify({
  format: { duration: '106.008', format_name: 'mov,mp4,m4a', bit_rate: '128000', size: '1700000' },
  streams: [{ codec_name: 'aac', codec_type: 'audio', channels: 2, sample_rate: '44100' }],
});

/** A PDF: ffprobe succeeds and reports no audio stream. */
const PROBE_NO_AUDIO = JSON.stringify({
  format: { duration: '0', format_name: 'pdf' },
  streams: [{ codec_name: 'mjpeg', codec_type: 'video' }],
});

type FfmpegBehaviour = 'ok' | 'no_audio' | 'missing' | 'unreadable';

describe.skipIf(!reachable)('ingestStream', () => {
  let test: TestDb;
  let ctx: EngineContext;
  let store: MemoryObjectStore;
  let behaviour: FfmpegBehaviour = 'ok';

  beforeAll(async () => {
    test = await createTestDb(BASE_URL);
    store = new MemoryObjectStore();
    ctx = {
      db: test.db,
      store,
      tmp: createTempDirPort(),
      ffmpeg: {
        run: async () => {
          if (behaviour === 'missing') {
            const err = new Error('spawn ffprobe ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          }
          if (behaviour === 'unreadable') throw new Error('Invalid data found');
          return { stdout: behaviour === 'no_audio' ? PROBE_NO_AUDIO : PROBE_OK, stderr: '' };
        },
      },
      clock: { now: () => new Date(1_760_000_000_000), sleep: async () => {} },
      logger: {
        child: () => ctx.logger,
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      events: { emit: () => {} },
    } as unknown as EngineContext;
  }, 60_000);

  // 60 s, matching the `beforeAll` above. `drop database … with (force)` is slow when the
  // machine is busy and is not the thing under test. It must be set HERE rather than in
  // vitest.config.ts: root-level `test.hookTimeout` is silently ignored when `test.projects`
  // is used — verified 2026-08-11 by setting it to 1 ms and watching every suite still pass.
  afterAll(async () => {
    await test?.drop();
  }, 60_000);

  const body = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

  const ingest = (filename: string, content: string, over: Record<string, unknown> = {}) =>
    ingestStream(ctx, {
      stream: body(content),
      filename,
      contentType: 'audio/mp4',
      source: 'upload',
      maxBytes: 1_000_000,
      ...over,
    });

  it('stores an asset under a uuid key with no user bytes in it', async () => {
    behaviour = 'ok';
    const asset = await ingest('မင်္ဂလာပါ.m4a', 'audio-one');

    // The DoD's key shape. This is what makes filename sanitisation unnecessary.
    expect(asset.storageKey).toMatch(/^media\/[0-9a-f-]{36}\/source\.m4a$/);
    // …and the filename survives byte-identical in the column beside it.
    expect(asset.filename).toBe('မင်္ဂလာပါ.m4a');
    expect(asset.deduped).toBe(false);
    expect(asset.durationMs).toBe(106_008);
  });

  it('dedupes identical content to one asset row', async () => {
    behaviour = 'ok';
    const first = await ingest('a.m4a', 'same-bytes');
    const second = await ingest('b-different-name.m4a', 'same-bytes');

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    // The first upload's filename is the one kept — the API contract says so, and the job
    // title is where the second uploader's name lives.
    expect(second.filename).toBe('a.m4a');

    const rows = await test.db.$client.query<{ n: string }>(
      'select count(*)::text as n from media_assets where sha256 = $1',
      [first.sha256],
    );
    expect(rows.rows[0]!.n).toBe('1');
  });

  it('drops the bytes it just wrote when the content was already stored', async () => {
    behaviour = 'ok';
    const first = await ingest('c.m4a', 'duplicate-cleanup');
    const second = await ingest('d.m4a', 'duplicate-cleanup');

    expect(second.deduped).toBe(true);
    // The loser's object must not survive: nothing references it, and an operator would be
    // paying to store a second copy of bytes the dedupe claims not to have kept.
    const orphans = [];
    for await (const o of store.list('media/')) orphans.push(o.key);
    expect(orphans).toContain(first.storageKey);
    expect(orphans.filter((k) => k !== first.storageKey)).not.toContain(second.storageKey);
  });

  it('skips the transfer entirely when the client pre-hashes a known file', async () => {
    behaviour = 'ok';
    const first = await ingest('e.m4a', 'pre-hash-me');

    const stream = body('pre-hash-me');
    const reused = await ingestStream(ctx, {
      stream,
      filename: 'e-again.m4a',
      contentType: 'audio/mp4',
      source: 'upload',
      maxBytes: 1_000_000,
      declaredSha: first.sha256,
    });

    expect(reused.deduped).toBe(true);
    expect(reused.id).toBe(first.id);
    // The whole point: the body was never read. This is what makes a CLI re-upload free.
    expect(stream.destroyed).toBe(true);
  });

  it('rejects a declared sha that disagrees with the bytes, and stores nothing', async () => {
    behaviour = 'ok';
    const before = await countAssets();
    await expect(
      ingest('f.m4a', 'actual-bytes', { declaredSha: 'f'.repeat(64) }),
    ).rejects.toThrow(/do not match the declared sha256/);
    expect(await countAssets()).toBe(before);
  });

  it('rejects a file over maxBytes without leaving an object', async () => {
    behaviour = 'ok';
    const err = await ingest('g.m4a', 'x'.repeat(500), { maxBytes: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).code).toBe('file_too_large');

    const keys = [];
    for await (const o of store.list('media/')) keys.push(o.key);
    expect(keys.some((k) => k.endsWith('/source.m4a') && k.includes('g'))).toBe(false);
  });

  it('rejects a file with no audio stream, naming the file', async () => {
    behaviour = 'no_audio';
    const err = await ingest('notes.mp4', 'not-really-audio').catch((e) => e);
    expect((err as IngestError).code).toBe('no_audio_stream');
    expect((err as Error).message).toContain('notes.mp4');
    // The uploader can act on this one.
    expect((err as IngestError).isOperatorFault).toBe(false);
  });

  it('blames the server, not the file, when ffprobe is missing', async () => {
    // The defect this exists to prevent: before Phase 8, a missing ffprobe degraded to
    // `hasAudio: false`, which reads downstream as "your file has no audio" and sends a
    // journalist to re-export a recording that was always fine.
    behaviour = 'missing';
    const err = await ingest('fine.m4a', 'perfectly-good-audio').catch((e) => e);
    expect((err as IngestError).code).toBe('ffprobe_missing');
    expect((err as IngestError).isOperatorFault).toBe(true);
    expect((err as Error).message).not.toContain('fine.m4a');
  });

  it('distinguishes unreadable media from a missing binary', async () => {
    behaviour = 'unreadable';
    const err = await ingest('corrupt.m4a', 'garbage').catch((e) => e);
    expect((err as IngestError).code).toBe('unreadable_media');
    expect((err as IngestError).isOperatorFault).toBe(false);
    expect((err as Error).message).toContain('corrupt.m4a');
  });

  it('refuses an unsupported type before touching the store', async () => {
    behaviour = 'ok';
    const before = await countAssets();
    await expect(ingest('notes.pdf', 'pdf-bytes', { contentType: 'application/pdf' })).rejects.toThrow(
      /not a supported media file/,
    );
    expect(await countAssets()).toBe(before);
  });

  async function countAssets(): Promise<number> {
    const r = await test.db.$client.query<{ n: string }>(
      'select count(*)::text as n from media_assets',
    );
    return Number(r.rows[0]!.n);
  }
});
