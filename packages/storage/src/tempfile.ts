import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FsObjectStore } from './fs.js';
import type { ObjectStore, TempDir, TempFile } from './types.js';

/**
 * Disposable temporary files and directories.
 *
 * ffmpeg needs a path; object stores hand out streams. The old app bridged that with a
 * `data/chunks/<runId>` directory removed in a `finally`, which leaks on SIGKILL and on any
 * path that skips the finally. `await using` makes cleanup part of the language:
 *
 *     await using input = await toTempFile(store, tmp, key, '.m4a');
 *     await ctx.ffmpeg.run('ffmpeg', ['-i', input.path, …]);
 *     // removed here, including when the ffmpeg call throws
 *
 * A `maintenance.tmp-sweep` job (Phase 9) removes orphaned `thibi-*` directories older than
 * a day, covering the case where the process dies between creation and disposal.
 */

export interface TempDirPort {
  dir(prefix: string): Promise<TempDir>;
}

/** The real implementation. Tests can substitute a port pointing at a fixture directory. */
export function createTempDirPort(root: string = tmpdir()): TempDirPort {
  return {
    async dir(prefix: string): Promise<TempDir> {
      const path = await mkdtemp(join(root, prefix));
      return {
        path,
        async [Symbol.asyncDispose]() {
          await rm(path, { recursive: true, force: true });
        },
      };
    },
  };
}

/**
 * Materialise an object as a local file that deletes itself.
 *
 * Fast path: when the store is filesystem-backed and on the same device, hardlink instead
 * of copying. A 200 MB normalized FLAC then costs an inode rather than 200 MB of I/O, which
 * matters because every chunk of every run passes through here.
 */
export async function toTempFile(
  store: ObjectStore,
  tmp: TempDirPort,
  key: string,
  ext = '.bin',
): Promise<TempFile> {
  const dir = await tmp.dir('thibi-');
  const path = join(dir.path, `${randomUUID()}${ext}`);

  let linked = false;
  if (store instanceof FsObjectStore) {
    try {
      await link(store.localPath(key), path);
      linked = true;
    } catch {
      // Cross-device, or the object does not exist as a plain file. Fall back to copying,
      // which will surface a missing object as ObjectNotFoundError from store.get().
    }
  }

  if (!linked) {
    try {
      await pipeline(await store.get(key), createWriteStream(path));
    } catch (err) {
      // Do not leak the directory when the copy itself fails.
      await dir[Symbol.asyncDispose]();
      throw err;
    }
  }

  const { size } = await stat(path);
  return {
    path,
    bytes: size,
    async [Symbol.asyncDispose]() {
      await dir[Symbol.asyncDispose]();
    },
  };
}

/** Upload a local file and return the store result. The caller owns the local file. */
export async function fromTempFile(
  store: ObjectStore,
  key: string,
  path: string,
  contentType?: string,
): Promise<{ key: string; bytes: number; sha256: string }> {
  const { createReadStream } = await import('node:fs');
  return store.putStream(
    key,
    createReadStream(path),
    contentType ? { contentType } : {},
  );
}
