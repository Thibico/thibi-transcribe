import type { Readable } from 'node:stream';

/**
 * The object-store port. One interface, three adapters, one contract suite run against all
 * of them — so `STORAGE_DRIVER=fs` (the overview's Risk-4 cut list) is a supported
 * configuration rather than a degraded one, and tests never need a container.
 */

export interface PutOpts {
  contentType?: string;
  /** Advisory metadata. S3 stores it; fs and memory keep it in a sidecar. */
  metadata?: Record<string, string>;
  /**
   * Refuse the write once the body exceeds this many bytes, throwing `ObjectTooLargeError`
   * and leaving no object behind.
   *
   * This lives on the port rather than in a transform the caller supplies because every
   * adapter already runs a counting transform to compute `sha256`, so the cap costs one
   * comparison per chunk on a stream that is being walked anyway. The Phase 8 plan specified
   * a `HashingPassThrough` in the engine instead — written before Phase 1 put the hashing in
   * the store — which would have hashed every uploaded byte a second time to learn a number
   * `putStream` already returns.
   *
   * It is a cap, not a content-length check: an untrusted stream that lies about its size, or
   * declares none at all, is the case this exists for.
   */
  maxBytes?: number;
}

export interface PutResult {
  key: string;
  bytes: number;
  /** Computed during the upload stream, never by re-reading the object. */
  sha256: string;
}

export interface HeadResult {
  bytes: number;
  contentType?: string;
  etag: string;
}

export interface ObjectStore {
  put(key: string, body: Buffer, opts?: PutOpts): Promise<PutResult>;

  /**
   * Streaming upload with a sha256 passthrough.
   *
   * This exists so a 2 GB file never becomes a Buffer. The old app did
   * `Buffer.from(await file.arrayBuffer())` at `app/api/jobs/route.ts:47`, which allocates
   * the entire upload in memory and takes the process down on a long interview.
   */
  putStream(key: string, body: Readable, opts?: PutOpts): Promise<PutResult>;

  get(key: string, range?: { start: number; end?: number }): Promise<Readable>;
  head(key: string): Promise<HeadResult | null>;
  delete(key: string): Promise<void>;
  /** Returns the number of objects removed. Used to sweep `runs/{id}/chunks/`. */
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string): AsyncIterable<{ key: string; bytes: number }>;

  /** fs and memory throw NotSupportedError — presigning is an S3 concept, not a port one. */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
}

/**
 * A file on disk that removes itself.
 *
 * ffmpeg needs a path and object stores hand out streams, so something has to land bytes on
 * disk. The old app's answer was a `data/chunks/<runId>` directory removed in a `finally`,
 * which leaks on every SIGKILL and on every thrown error that skipped the finally.
 * `await using` makes the cleanup unskippable.
 */
export interface TempFile extends AsyncDisposable {
  readonly path: string;
  readonly bytes: number;
}

export interface TempDir extends AsyncDisposable {
  readonly path: string;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly key?: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export class ObjectNotFoundError extends StorageError {
  constructor(key: string) {
    super(`No such object: ${key}`, key);
    this.name = 'ObjectNotFoundError';
  }
}

/**
 * Thrown when `PutOpts.maxBytes` is exceeded. Distinct from a generic write failure because
 * the caller's response differs: this is the uploader's problem and names a limit, where a
 * failed write is the operator's. Ingest maps it to `file_too_large`.
 */
export class ObjectTooLargeError extends StorageError {
  constructor(
    key: string,
    readonly maxBytes: number,
  ) {
    super(`Object exceeds the ${maxBytes}-byte limit: ${key}`, key);
    this.name = 'ObjectTooLargeError';
  }
}

export class NotSupportedError extends StorageError {
  constructor(operation: string, driver: string) {
    super(`${operation} is not supported by the ${driver} storage driver`);
    this.name = 'NotSupportedError';
  }
}
