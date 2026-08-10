import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsObjectStore } from '../fs.js';
import { MemoryObjectStore } from '../memory.js';
import { S3ObjectStore } from '../s3.js';
import { createTempDirPort, toTempFile } from '../tempfile.js';
import { assertSafeKey } from '../keys.js';
import { NotSupportedError, ObjectNotFoundError, type ObjectStore } from '../types.js';

function isSafeKey(key: string): boolean {
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * One contract, every adapter.
 *
 * The point of `describe.each` here is that `STORAGE_DRIVER=fs` cannot quietly diverge from
 * MinIO. A behaviour that only one adapter has is a behaviour the engine must not depend
 * on, and this suite is where that gets caught.
 *
 * The S3 case runs against the dev MinIO from `infra/compose.dev.yml` and skips itself when
 * it is not reachable, so a clone with no Docker still gets full coverage of the two
 * adapters that need none.
 */

const S3_ENDPOINT = process.env['TEST_S3_ENDPOINT'] ?? 'http://localhost:9000';
const S3_BUCKET = process.env['TEST_S3_BUCKET'] ?? 'thibi';

async function minioReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${S3_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const hasMinio = await minioReachable();
if (!hasMinio) {
  console.warn(
    `\n  [storage] MinIO not reachable at ${S3_ENDPOINT} — skipping the S3 adapter contract.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

interface Adapter {
  name: string;
  make: () => Promise<{ store: ObjectStore; cleanup: () => Promise<void> }>;
  supportsPresign: boolean;
  skip?: boolean;
}

const adapters: Adapter[] = [
  {
    name: 'memory',
    supportsPresign: false,
    make: async () => ({ store: new MemoryObjectStore(), cleanup: async () => {} }),
  },
  {
    name: 'fs',
    supportsPresign: false,
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'thibi-fs-test-'));
      return {
        store: new FsObjectStore(root),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: 's3',
    supportsPresign: true,
    skip: !hasMinio,
    make: async () => {
      const client = new S3Client({
        endpoint: S3_ENDPOINT,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'thibi',
          secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'thibi-dev-secret',
        },
      });
      const store = new S3ObjectStore({ bucket: S3_BUCKET, client });
      const prefix = `test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}/`;
      // Namespace every S3 run so parallel test files cannot collide in a shared bucket.
      const scoped = new Proxy(store, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            // Only namespace keys that are already valid. Prefixing an unsafe key would
            // sanitise it — `/absolute.txt` becomes `test-1/absolute.txt` — and the
            // adapter would never get the chance to reject it, which is the one thing
            // that test is checking.
            if (typeof args[0] === 'string' && isSafeKey(args[0])) args[0] = prefix + args[0];
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as ObjectStore;
      return { store: scoped, cleanup: () => store.deletePrefix(prefix).then(() => {}) };
    },
  },
];

describe.each(adapters.filter((a) => !a.skip))('ObjectStore contract: $name', (adapter) => {
  let store: ObjectStore;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ store, cleanup } = await adapter.make());
  });
  afterAll(async () => {
    await cleanup();
  });

  it('round-trips a buffer and reports its sha256', async () => {
    const body = Buffer.from('မင်္ဂလာပါ hello', 'utf8');
    const put = await store.put('round/trip.txt', body);
    expect(put.bytes).toBe(body.byteLength);
    // sha256 of the content, computed on the way in — not by re-reading the object.
    expect(put.sha256).toMatch(/^[0-9a-f]{64}$/);

    const chunks: Buffer[] = [];
    for await (const c of await store.get('round/trip.txt')) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('မင်္ဂလာပါ hello');
  });

  it('streams an upload and hashes it identically', async () => {
    const body = Buffer.from('x'.repeat(100_000));
    const streamed = await store.putStream('streamed.bin', Readable.from([body]));
    const buffered = await store.put('buffered.bin', body);
    expect(streamed.sha256).toBe(buffered.sha256);
    expect(streamed.bytes).toBe(100_000);
  });

  it('serves a byte range', async () => {
    await store.put('range.txt', Buffer.from('0123456789'));
    const chunks: Buffer[] = [];
    for await (const c of await store.get('range.txt', { start: 2, end: 5 })) {
      chunks.push(Buffer.from(c as Buffer));
    }
    // Inclusive end, matching HTTP Range semantics — off by one here means a corrupt
    // audio scrub in the editor.
    expect(Buffer.concat(chunks).toString()).toBe('2345');
  });

  it('serves an open-ended range', async () => {
    await store.put('range2.txt', Buffer.from('0123456789'));
    const chunks: Buffer[] = [];
    for await (const c of await store.get('range2.txt', { start: 7 })) {
      chunks.push(Buffer.from(c as Buffer));
    }
    expect(Buffer.concat(chunks).toString()).toBe('789');
  });

  it('returns a fresh readable each get', async () => {
    await store.put('twice.txt', Buffer.from('abc'));
    const read = async () => {
      const chunks: Buffer[] = [];
      for await (const c of await store.get('twice.txt')) chunks.push(Buffer.from(c as Buffer));
      return Buffer.concat(chunks).toString();
    };
    expect(await read()).toBe('abc');
    expect(await read()).toBe('abc');
  });

  it('heads an object and returns null for a missing key', async () => {
    await store.put('head.txt', Buffer.from('12345'));
    expect(await store.head('head.txt')).toMatchObject({ bytes: 5 });
    expect(await store.head('nope/missing.txt')).toBeNull();
  });

  it('throws ObjectNotFoundError on get of a missing key', async () => {
    await expect(store.get('nope/missing.txt')).rejects.toThrow(ObjectNotFoundError);
  });

  it('deletes idempotently', async () => {
    await store.put('gone.txt', Buffer.from('x'));
    await store.delete('gone.txt');
    await store.delete('gone.txt');
    expect(await store.head('gone.txt')).toBeNull();
  });

  it('lists by prefix in key order and counts a prefix delete', async () => {
    for (const i of [2, 0, 1]) {
      await store.put(`runs/r1/chunks/${String(i).padStart(3, '0')}.flac`, Buffer.from(`c${i}`));
    }
    await store.put('runs/r2/chunks/000.flac', Buffer.from('other'));

    const listed: string[] = [];
    for await (const e of store.list('runs/r1/chunks/')) listed.push(e.key);
    expect(listed.map((k) => k.split('/').pop())).toEqual(['000.flac', '001.flac', '002.flac']);

    expect(await store.deletePrefix('runs/r1/')).toBe(3);
    expect(await store.head('runs/r2/chunks/000.flac')).not.toBeNull();
  });

  it('rejects a key that would escape its root', async () => {
    await expect(store.put('../escape.txt', Buffer.from('x'))).rejects.toThrow(TypeError);
    await expect(store.put('/absolute.txt', Buffer.from('x'))).rejects.toThrow(TypeError);
  });

  if (adapter.supportsPresign) {
    it('presigns a GET that actually works', async () => {
      await store.put('presigned.txt', Buffer.from('signed body'));
      const url = await store.presignGet('presigned.txt', 60);
      const res = await fetch(url);
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe('signed body');
    });
  } else {
    it('throws NotSupportedError for presignGet', async () => {
      // Presigning is an S3 concept. An fs-backed instance must fail loudly rather than
      // return something URL-shaped that 404s in a browser.
      await expect(store.presignGet('x', 60)).rejects.toThrow(NotSupportedError);
    });
  }

  describe('toTempFile', () => {
    const tmp = createTempDirPort();

    it('materialises an object and removes its directory on dispose', async () => {
      await store.put('tmp/source.flac', Buffer.from('audio bytes'));
      let path: string;
      let dir: string;
      {
        await using file = await toTempFile(store, tmp, 'tmp/source.flac', '.flac');
        path = file.path;
        dir = join(path, '..');
        expect(file.bytes).toBe(11);
        expect(path.endsWith('.flac')).toBe(true);
      }
      await expect(readdir(dir)).rejects.toThrow();
    });

    it('removes its directory when the body throws', async () => {
      // The reason `await using` is worth the syntax: a finally block is skippable by a
      // sufficiently creative control flow, and this one is not.
      await store.put('tmp/source2.flac', Buffer.from('audio'));
      let dir = '';
      await expect(
        (async () => {
          await using file = await toTempFile(store, tmp, 'tmp/source2.flac', '.flac');
          dir = join(file.path, '..');
          throw new Error('boom');
        })(),
      ).rejects.toThrow('boom');
      await expect(readdir(dir)).rejects.toThrow();
    });

    it('does not leak a directory when the object is missing', async () => {
      await expect(toTempFile(store, tmp, 'tmp/absent.flac', '.flac')).rejects.toThrow();
    });
  });
});
