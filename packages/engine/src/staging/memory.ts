import { readFile } from 'node:fs/promises';
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
 * An in-memory `StagingStore`, for tests and for the integration harness.
 *
 * It implements the *same* port rather than a convenient subset, and in particular it keeps
 * the two behaviours that are easy to get wrong and expensive to discover late:
 *
 *  - `readJson` enforces `maxBytes` and refuses a URI for a different bucket.
 *  - `info().location` is lower-cased, matching the GCS adapter's contract, so a test
 *    written against the fake catches a case-folding bug in the real comparison.
 *
 * The lifecycle configuration is settable, so the refusal paths in §6 are exercised without
 * a bucket to misconfigure.
 */

/** Not a real GCS region, on purpose. See the constructor. */
export const FAKE_REGION = 'fake-region-1';

export interface FakeStagingOptions {
  bucket?: string;
  location?: string;
  locationType?: BucketInfo['locationType'];
  storageClass?: string;
  /** `null` models a bucket with no rules at all; omit `permitted` to model a 403. */
  lifecycle?: RawLifecycle | null;
  /** False models `roles/storage.objectAdmin`: writes work, metadata reads 403. */
  metadataPermitted?: boolean;
  serviceAccountEmail?: string;
}

export class FakeStagingStore implements StagingStore {
  readonly scheme = 'gs' as const;
  readonly bucket: string;

  /** Exposed so tests can assert what was staged without going through the port. */
  readonly objects = new Map<string, Uint8Array>();
  /** Every prefix passed to `deletePrefix`, in order. The sweep is a tested behaviour. */
  readonly deletedPrefixes: string[] = [];

  private readonly options: Required<Omit<FakeStagingOptions, 'lifecycle' | 'serviceAccountEmail'>> & {
    lifecycle: RawLifecycle | null;
    serviceAccountEmail?: string;
  };

  constructor(options: FakeStagingOptions = {}) {
    this.bucket = options.bucket ?? 'fake-staging';
    this.options = {
      bucket: this.bucket,
      // Deliberately not a real region name. CI forbids naming one outside
      // `apps/cli/src/config.ts`, and beyond obeying that rule an obviously-fake default is
      // better here anyway: a test that passed only because the fake happened to default to
      // the same region as the real configuration would be passing for the wrong reason.
      // Tests that exercise the region comparison pass a recorded location explicitly.
      location: options.location ?? FAKE_REGION,
      locationType: options.locationType ?? 'region',
      storageClass: options.storageClass ?? 'STANDARD',
      lifecycle:
        options.lifecycle === undefined
          ? { rule: [{ action: { type: 'Delete' }, condition: { age: 1 } }] }
          : options.lifecycle,
      metadataPermitted: options.metadataPermitted ?? true,
      ...(options.serviceAccountEmail ? { serviceAccountEmail: options.serviceAccountEmail } : {}),
    };
  }

  uri(key: string): string {
    return `gs://${this.bucket}/${key}`;
  }

  async info(): Promise<BucketInfo> {
    if (!this.options.metadataPermitted) {
      throw new Error(`storage.buckets.get denied on gs://${this.bucket}`);
    }
    return {
      name: this.bucket,
      location: this.options.location.toLowerCase(),
      locationType: this.options.locationType,
      storageClass: this.options.storageClass,
    };
  }

  async put(key: string, body: StagingBody, _opts?: { contentType?: string }): Promise<StagingLocation> {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await readFile(body.path));
    this.objects.set(key, bytes);
    return { key, uri: this.uri(key), bytes: bytes.byteLength };
  }

  async list(prefix: string): Promise<StagingObject[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({ key, uri: this.uri(key), bytes: bytes.byteLength }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async readJson<T = unknown>(uri: string, opts: { maxBytes?: number } = {}): Promise<T> {
    const parsed = parseGsUri(uri);
    if (!parsed) throw new TypeError(`Not a gs:// URI: ${uri}`);
    if (parsed.bucket !== this.bucket) {
      throw new Error(
        `Batch output URI points at gs://${parsed.bucket}, but staging is gs://${this.bucket}. ` +
          `Refusing to read it.`,
      );
    }
    const body = this.objects.get(parsed.key);
    if (!body) throw new Error(`No such staged object: ${uri}`);

    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
    if (body.byteLength > maxBytes) {
      throw new Error(
        `Batch output ${uri} is ${(body.byteLength / 1024).toFixed(1)} KB, over the ` +
          `${(maxBytes / 1024).toFixed(1)} KB limit.`,
      );
    }
    return JSON.parse(Buffer.from(body).toString('utf8')) as T;
  }

  async deletePrefix(prefix: string): Promise<{ deleted: number }> {
    this.deletedPrefixes.push(prefix);
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deleted++;
      }
    }
    return { deleted };
  }

  async assertLifecycle(_prefix: string): Promise<LifecycleCheck> {
    return assertLifecycle(this.bucket, this.options.lifecycle, {
      permitted: this.options.metadataPermitted,
      ...(this.options.serviceAccountEmail
        ? { serviceAccount: this.options.serviceAccountEmail }
        : {}),
    });
  }

  /** Seed a staged object directly, for tests that start after the upload. */
  seedJson(key: string, value: unknown): string {
    this.objects.set(key, new Uint8Array(Buffer.from(JSON.stringify(value))));
    return this.uri(key);
  }
}
