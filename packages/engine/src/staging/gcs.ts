import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Clock } from '../context.js';
import { NotConfiguredError, ProviderError, ProviderUnavailableError, RateLimitedError } from '../errors.js';
import { assertLifecycle, type RawLifecycle } from './lifecycle.js';
import {
  DEFAULT_MAX_JSON_BYTES,
  parseGsUri,
  type BucketInfo,
  type LifecycleCheck,
  type StagingBody,
  type StagingLocation,
  type StagingObject,
  type StagingStore,
} from './types.js';

/**
 * The GCS adapter. **The only file in the repository that knows what Google Cloud Storage
 * is** — everything above it sees the `StagingStore` port, which is what keeps `batch.ts`
 * testable against recorded fixtures.
 *
 * ## Why the JSON API over `fetch` rather than `@google-cloud/storage`
 *
 * The phase plan specified the client library. This is a deliberate deviation, recorded
 * rather than hidden, for three reasons:
 *
 *  1. **One HTTP stack for one credential.** `providers/google/index.ts` already talks to
 *     Google over `fetch` with a token from `google-auth-library`, and `auth.ts` caches and
 *     coalesces that token per credential. The client library would build its own auth
 *     client from the same service-account JSON, giving one credential two token lifetimes,
 *     two retry policies and two ways to fail. A second stack is a second thing to configure
 *     and a second thing to debug at 2am in a newsroom.
 *  2. **Six operations.** get metadata, upload, list, download, delete, and the lifecycle
 *     read — all of them one request. The spike proved every one of them against the live
 *     API before this file existed.
 *  3. **Errors travel through our taxonomy.** The client library throws its own error type,
 *     which `retry.ts` and `errors.ts` would then have to learn to classify. Here a 403 is a
 *     `NotConfiguredError` with a hint, exactly as it is for Speech.
 *
 * The cost of the deviation is that resumable uploads and connection pooling are ours to
 * not have. Neither matters at ~60 MB per run.
 */

const STORAGE = 'https://storage.googleapis.com/storage/v1';
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1';

/** Scopes: the same credential as Speech, plus read/write on objects. */
export const STAGING_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/devstorage.read_write',
];

export interface GcsStagingOptions {
  bucket: string;
  /** Mints a bearer token. Supplied by the caller so this file reads no credentials. */
  getToken: () => Promise<string>;
  clock: Clock;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Named in the IAM remediation message when metadata cannot be read. */
  serviceAccountEmail?: string;
  signal?: AbortSignal;
}

const LIFECYCLE_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
/** An upload is minutes, not seconds: a 60 MB FLAC on a newsroom's uplink. */
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

interface RawBucket {
  location?: string;
  locationType?: string;
  storageClass?: string;
  lifecycle?: RawLifecycle;
}

/**
 * GCS reports `locationType` as `region` / `multi-region` / `dual-region`. Anything else is
 * mapped to `unknown` rather than guessed: §5 refuses on anything that is not `region`, so a
 * value we do not recognise must not be silently treated as one that is.
 */
function normalizeLocationType(value: string | undefined): BucketInfo['locationType'] {
  switch (value) {
    case 'region':
    case 'multi-region':
    case 'dual-region':
      return value;
    default:
      return 'unknown';
  }
}

/**
 * A 403 reading bucket metadata is the expected first-run state, not an exception.
 *
 * Measured 2026-08-10: `roles/storage.objectAdmin` returns exactly this while writes and
 * deletes succeed. `info()` and `assertLifecycle()` therefore need to distinguish "denied"
 * from "failed", which a thrown error would flatten.
 */
export class BucketMetadataDenied extends Error {
  constructor(readonly bucket: string) {
    super(`storage.buckets.get denied on gs://${bucket}`);
    this.name = 'BucketMetadataDenied';
  }
}

/**
 * The bucket is not there.
 *
 * Distinct from `BucketMetadataDenied`, and the distinction is the whole point. The first
 * version of the validator caught every metadata failure and printed the IAM remediation, so
 * a **typo in a bucket name** was answered with "grant roles/storage.legacyBucketReader" —
 * advice that is not just useless but actively sends the operator to edit an IAM policy that
 * was never the problem. That is precisely the failure mode this codebase deleted from the
 * old app's region hint, reintroduced in a new place. Caught by running the command against
 * a made-up bucket name rather than by reading the code.
 */
export class BucketNotFound extends Error {
  constructor(readonly bucket: string) {
    super(`gs://${bucket} does not exist`);
    this.name = 'BucketNotFound';
  }
}

export function createGcsStaging(options: GcsStagingOptions): StagingStore {
  const doFetch = options.fetchImpl ?? fetch;
  const { bucket } = options;

  let bucketCache: RawBucket | null = null;
  let deniedCache = false;
  let missingCache = false;
  let lifecycleCache: { at: number; result: LifecycleCheck } | null = null;

  function signalFor(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  }

  async function request(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const token = await options.getToken();
    const { timeoutMs, ...rest } = init;
    return doFetch(url, {
      ...rest,
      headers: { ...(rest.headers ?? {}), Authorization: `Bearer ${token}` },
      signal: signalFor(timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  }

  /** Map a GCS error response onto the engine's taxonomy, keeping Google's own message. */
  async function toStagingError(response: Response, what: string): Promise<Error> {
    const body = await response.text().catch(() => '');
    let detail = body.slice(0, 500);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      /* keep the raw body */
    }
    const message = `Google Cloud Storage ${response.status} on ${what}: ${detail || response.statusText}`;

    if (response.status === 429 || response.status === 503) return new RateLimitedError(message);
    if (response.status >= 500) return new ProviderUnavailableError(message);
    if (response.status === 401 || response.status === 403) {
      return new NotConfiguredError(message, {
        hint:
          `The service account needs storage.objects.create, storage.objects.get, ` +
          `storage.objects.delete and storage.buckets.get on gs://${bucket}. ` +
          `roles/storage.objectAdmin grants the first three but NOT storage.buckets.get — ` +
          `add roles/storage.legacyBucketReader for that.`,
      });
    }
    return new ProviderError(message, response.status);
  }

  async function loadBucket(): Promise<RawBucket> {
    if (bucketCache) return bucketCache;
    if (missingCache) throw new BucketNotFound(bucket);
    if (deniedCache) throw new BucketMetadataDenied(bucket);

    const response = await request(`${STORAGE}/b/${encodeURIComponent(bucket)}?projection=full`);
    if (response.status === 404) {
      await response.text().catch(() => '');
      missingCache = true;
      throw new BucketNotFound(bucket);
    }
    // Note GCS answers 403 for a bucket in another project that the caller cannot see, so
    // "denied" genuinely can mean "not yours" as well as "not permitted". Both lead to the
    // same next step, which is why they share a branch; 404 does not.
    if (response.status === 403 || response.status === 401) {
      await response.text().catch(() => '');
      deniedCache = true;
      throw new BucketMetadataDenied(bucket);
    }
    if (!response.ok) throw await toStagingError(response, `bucket.get(${bucket})`);

    bucketCache = (await response.json()) as RawBucket;
    return bucketCache;
  }

  return {
    scheme: 'gs',
    bucket,

    uri(key: string): string {
      return `gs://${bucket}/${key}`;
    },

    async info(): Promise<BucketInfo> {
      const raw = await loadBucket();
      return {
        name: bucket,
        // GCS returns ASIA-SOUTHEAST1. Measured 2026-08-10; every comparison folds case and
        // the port's contract is that this field is already lower-cased.
        location: (raw.location ?? '').toLowerCase(),
        locationType: normalizeLocationType(raw.locationType),
        storageClass: raw.storageClass ?? 'unknown',
      };
    },

    async put(
      key: string,
      body: StagingBody,
      opts: { contentType?: string } = {},
    ): Promise<StagingLocation> {
      const url =
        `${UPLOAD}/b/${encodeURIComponent(bucket)}/o` +
        `?uploadType=media&name=${encodeURIComponent(key)}`;

      const isPath = !(body instanceof Uint8Array);
      const bytes = isPath ? (await stat(body.path)).size : body.byteLength;

      const response = await request(url, {
        method: 'POST',
        headers: {
          'Content-Type': opts.contentType ?? 'application/octet-stream',
          'Content-Length': String(bytes),
        },
        // A fresh stream per call, so `withRetry` around this method re-reads the file
        // rather than uploading zero bytes on the second attempt. See StagingBody.
        body: isPath ? toWebStream(body.path) : body,
        // Node requires this to send a stream body; without it fetch rejects outright.
        ...(isPath ? { duplex: 'half' } : {}),
        timeoutMs: UPLOAD_TIMEOUT_MS,
      } as RequestInit & { timeoutMs: number });

      if (!response.ok) throw await toStagingError(response, `objects.insert(${key})`);
      await response.json().catch(() => ({}));

      return { key, uri: `gs://${bucket}/${key}`, bytes };
    },

    async list(prefix: string): Promise<StagingObject[]> {
      const out: StagingObject[] = [];
      let pageToken: string | undefined;

      do {
        const url =
          `${STORAGE}/b/${encodeURIComponent(bucket)}/o` +
          `?prefix=${encodeURIComponent(prefix)}&maxResults=1000` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
        const response = await request(url);
        if (!response.ok) throw await toStagingError(response, `objects.list(${prefix})`);

        const page = (await response.json()) as {
          items?: Array<{ name: string; size?: string }>;
          nextPageToken?: string;
        };
        for (const item of page.items ?? []) {
          out.push({
            key: item.name,
            uri: `gs://${bucket}/${item.name}`,
            bytes: Number(item.size ?? 0),
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);

      return out;
    },

    async readJson<T = unknown>(uri: string, opts: { maxBytes?: number } = {}): Promise<T> {
      const parsed = parseGsUri(uri);
      if (!parsed) throw new TypeError(`Not a gs:// URI: ${uri}`);
      if (parsed.bucket !== bucket) {
        // Google writes output where we told it to. A different bucket means the operation
        // is not the one we submitted, and following the URI anyway would read a stranger's
        // object with our credentials.
        throw new ProviderError(
          `Batch output URI points at gs://${parsed.bucket}, but staging is gs://${bucket}. ` +
            `Refusing to read it.`,
        );
      }

      const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
      const url =
        `${STORAGE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(parsed.key)}?alt=media`;
      const response = await request(url);
      if (!response.ok) throw await toStagingError(response, `objects.get(${parsed.key})`);

      // Check the declared size before buffering, so an oversized object costs one header
      // rather than the heap. Content-Length is absent for a chunked response, hence the
      // second check below on the body we actually received.
      const declared = Number(response.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new ProviderError(
          `Batch output ${uri} is ${formatBytes(declared)}, over the ${formatBytes(maxBytes)} ` +
            `limit. A 2-hour transcript is 15-25 MB; this is not one.`,
        );
      }

      const text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) {
        throw new ProviderError(
          `Batch output ${uri} is ${formatBytes(Buffer.byteLength(text))}, over the ` +
            `${formatBytes(maxBytes)} limit.`,
        );
      }
      return JSON.parse(text) as T;
    },

    async deletePrefix(prefix: string): Promise<{ deleted: number }> {
      const objects = await this.list(prefix);
      let deleted = 0;
      for (const object of objects) {
        const url =
          `${STORAGE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object.key)}`;
        const response = await request(url, { method: 'DELETE' });
        // 404 means someone else got there first — the lifecycle rule, or a previous sweep.
        // That is the desired end state, so count it and move on.
        if (response.ok || response.status === 404) {
          deleted++;
          await response.text().catch(() => '');
          continue;
        }
        throw await toStagingError(response, `objects.delete(${object.key})`);
      }
      return { deleted };
    },

    async assertLifecycle(_prefix: string): Promise<LifecycleCheck> {
      const now = options.clock.now().getTime();
      if (lifecycleCache && now - lifecycleCache.at < LIFECYCLE_TTL_MS) {
        return lifecycleCache.result;
      }

      let result: LifecycleCheck;
      try {
        const raw = await loadBucket();
        result = assertLifecycle(bucket, raw.lifecycle ?? null, {
          permitted: true,
          ...(options.serviceAccountEmail ? { serviceAccount: options.serviceAccountEmail } : {}),
        });
      } catch (err) {
        // A missing bucket is not a lifecycle problem and must not be dressed up as one.
        if (err instanceof BucketNotFound) throw err;
        if (!(err instanceof BucketMetadataDenied)) throw err;
        result = assertLifecycle(bucket, null, {
          permitted: false,
          ...(options.serviceAccountEmail ? { serviceAccount: options.serviceAccountEmail } : {}),
        });
      }

      lifecycleCache = { at: now, result };
      return result;
    },
  };
}

/**
 * A file as a web stream, which is what `fetch` accepts as a body.
 *
 * `Readable.toWeb` rather than handing `fetch` the Node stream directly: undici tolerates
 * the latter but the types do not describe it, and a cast here would hide a real difference
 * in back-pressure behaviour on a 60 MB upload.
 */
function toWebStream(path: string): ReadableStream {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(1)} KB`;
}
