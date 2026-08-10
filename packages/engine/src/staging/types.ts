/**
 * The staging port — the bucket `batchRecognize` reads its input from and writes its output
 * to.
 *
 * This is **not** a second `ObjectStore`. `ObjectStore` is ours: it holds assets,
 * derivatives and archived responses for as long as the newsroom wants them, and only our
 * code ever reads it. Staging is a **wire format**. Google requires a `gs://` URI it can
 * reach, so bytes leave our storage, sit in someone else's for the length of one operation,
 * and are swept. Every method here exists to serve that round trip and nothing else — there
 * is no `get` by key, no listing of the whole bucket, no presigning.
 *
 * Keeping them separate is what allows `STORAGE_DRIVER=fs` and `s3` to stay honest: a
 * newsroom running MinIO on a laptop still stages to GCS, because that is where Google can
 * read from, and neither port has to grow a mode for the other's job.
 */

/**
 * The body of a staged object.
 *
 * **Deliberately not a `Readable`**, which is what the phase plan's §4 specified. The one
 * upload this port performs is the one most worth retrying — a ~60 MB normalized FLAC over a
 * newsroom's connection, immediately before an operation we do not want to submit twice —
 * and a stream can only be consumed once, so a retry around a `Readable` body silently
 * uploads zero bytes on the second attempt. A path can be re-opened per attempt; a
 * `Uint8Array` can be re-sent. Those are the two cases that exist.
 */
export type StagingBody = Uint8Array | { readonly path: string };

export interface StagingLocation {
  /** Key relative to the bucket root, e.g. `thibi-staging/<runId>/audio.flac`. */
  key: string;
  /** Absolute `gs://bucket/key`. This is what goes on the wire to Google. */
  uri: string;
  bytes: number;
}

export interface StagingObject {
  key: string;
  uri: string;
  bytes: number;
}

/**
 * The result of checking the bucket's lifecycle configuration.
 *
 * `no-permission` is a distinct outcome from `missing` and both are refusals, but only
 * `no-permission` is fixed with an IAM grant rather than a lifecycle rule, so conflating
 * them would send an admin to edit a rule that is already correct. Measured 2026-08-10:
 * `roles/storage.objectAdmin` produces exactly this case.
 */
export type LifecycleCheck =
  | { ok: true; rule: { ageDays: number; prefixes: string[] }; warning?: string }
  | {
      ok: false;
      reason: 'missing' | 'too-long' | 'no-permission';
      message: string;
      /** Copy-pasteable. Empty for `no-permission`, where the fix is an IAM binding. */
      command: string;
      lifecycleJson: string;
    };

export interface BucketInfo {
  name: string;
  /** Lower-cased. GCS returns `ASIA-SOUTHEAST1`; every comparison folds case. */
  location: string;
  locationType: 'region' | 'multi-region' | 'dual-region' | 'unknown';
  storageClass: string;
}

export interface StagingStore {
  readonly scheme: 'gs';
  readonly bucket: string;

  /** Bucket metadata. Cached per process — it cannot change under a running operation. */
  info(): Promise<BucketInfo>;

  /** Absolute URI for a key. Pure; never touches the network. */
  uri(key: string): string;

  put(key: string, body: StagingBody, opts?: { contentType?: string }): Promise<StagingLocation>;

  /** Objects under a prefix. Used only as the fallback in §9 when `results` lacks our key. */
  list(prefix: string): Promise<StagingObject[]>;

  /**
   * Read a JSON object back out by absolute `gs://` URI — the URI Google hands us, which
   * carries a uuid we cannot predict.
   *
   * On the port rather than in the provider, so `batch.ts` is testable against recorded
   * fixtures and exactly one file in the tree knows what GCS is.
   */
  readJson<T = unknown>(uri: string, opts?: { maxBytes?: number }): Promise<T>;

  deletePrefix(prefix: string): Promise<{ deleted: number }>;

  /** §6. Cached per bucket for an hour against `ctx.clock`. */
  assertLifecycle(prefix: string): Promise<LifecycleCheck>;
}

/**
 * A 2-hour transcript is 15–25 MB of JSON. 256 MB means something is wrong upstream, and
 * discovering that by exhausting the heap is a worse way to find out than a message that
 * names the size.
 */
export const DEFAULT_MAX_JSON_BYTES = 256 * 1024 * 1024;

/** Where everything this product writes into someone else's bucket goes. */
export const STAGING_ROOT = 'thibi-staging/';

export function stagingPrefixFor(runId: string): string {
  return `${STAGING_ROOT}${runId}/`;
}

/** Parse `gs://bucket/some/key` into its parts. Returns null for anything else. */
export function parseGsUri(uri: string): { bucket: string; key: string } | null {
  if (!uri.startsWith('gs://')) return null;
  const rest = uri.slice('gs://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}
