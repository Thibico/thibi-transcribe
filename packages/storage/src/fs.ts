import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertSafeKey } from './keys.js';
import {
  NotSupportedError,
  ObjectNotFoundError,
  StorageError,
  type HeadResult,
  type ObjectStore,
  type PutOpts,
  type PutResult,
} from './types.js';

/**
 * Filesystem-backed store for `STORAGE_DRIVER=fs`.
 *
 * The overview's Risk-4 cut list names this as the way to ship without MinIO, so it is a
 * first-class adapter held to the same contract suite, not a stub. It is also what makes
 * `toTempFile` cheap: on the same device it hardlinks instead of copying, so handing a
 * 200 MB normalized FLAC to ffmpeg costs an inode rather than 200 MB of I/O.
 */
export class FsObjectStore implements ObjectStore {
  readonly driver = 'fs';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Maps a key to a path, refusing anything that would escape the root. */
  private pathFor(key: string): string {
    assertSafeKey(key);
    const path = resolve(this.root, key);
    const rel = relative(this.root, path);
    if (rel.startsWith('..') || rel.startsWith(sep)) {
      throw new StorageError(`Object key escapes the storage root: ${key}`, key);
    }
    return path;
  }

  private metaPathFor(key: string): string {
    return `${this.pathFor(key)}.meta.json`;
  }

  async put(key: string, body: Buffer, opts: PutOpts = {}): Promise<PutResult> {
    return this.putStream(key, Readable.from([body]), opts);
  }

  async putStream(key: string, body: Readable, opts: PutOpts = {}): Promise<PutResult> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });

    // Write to a temp name and rename into place: a crash mid-write must not leave a
    // truncated object that `head` will happily report a size for.
    const tmp = `${path}.${process.pid}.${Date.now()}.partial`;
    const hash = createHash('sha256');
    let bytes = 0;

    // A Transform rather than a 'data' listener: this preserves backpressure, so a 2 GB
    // upload does not buffer in memory when the disk is slower than the source.
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.byteLength;
        callback(null, chunk);
      },
    });

    try {
      await pipeline(body, counting, createWriteStream(tmp));
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }

    if (opts.contentType || opts.metadata) {
      await writeFile(
        this.metaPathFor(key),
        JSON.stringify({ contentType: opts.contentType, metadata: opts.metadata }),
      );
    }

    return { key, bytes, sha256: hash.digest('hex') };
  }

  async get(key: string, range?: { start: number; end?: number }): Promise<Readable> {
    const path = this.pathFor(key);
    try {
      await stat(path);
    } catch {
      throw new ObjectNotFoundError(key);
    }
    return createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
  }

  async head(key: string): Promise<HeadResult | null> {
    const path = this.pathFor(key);
    let info;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    let contentType: string | undefined;
    try {
      const meta = JSON.parse(await readFile(this.metaPathFor(key), 'utf8')) as {
        contentType?: string;
      };
      contentType = meta.contentType;
    } catch {
      // No sidecar is normal.
    }
    return {
      bytes: info.size,
      ...(contentType !== undefined ? { contentType } : {}),
      // Not an S3 etag, but stable across reads and changing on write, which is all the
      // contract asks of it.
      etag: `${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}`,
    };
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => {});
    await unlink(this.metaPathFor(key)).catch(() => {});
  }

  async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    for await (const entry of this.list(prefix)) {
      await this.delete(entry.key);
      removed++;
    }
    return removed;
  }

  async *list(prefix: string): AsyncIterable<{ key: string; bytes: number }> {
    // Walk the whole root and filter: a prefix need not align with a directory boundary
    // ('runs/abc/chunks/0' is a legitimate prefix), so we cannot just readdir one folder.
    const found: Array<{ key: string; bytes: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (entry.name.endsWith('.meta.json') || entry.name.endsWith('.partial')) continue;
        const key = relative(this.root, full).split(sep).join('/');
        if (!key.startsWith(prefix)) continue;
        found.push({ key, bytes: (await stat(full)).size });
      }
    };
    await walk(this.root);
    for (const entry of found.sort((a, b) => a.key.localeCompare(b.key, 'en'))) yield entry;
  }

  async presignGet(): Promise<string> {
    throw new NotSupportedError('presignGet', this.driver);
  }

  /** The local path of an object, for `toTempFile`'s hardlink fast path. */
  localPath(key: string): string {
    return this.pathFor(key);
  }
}
