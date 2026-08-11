import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertSafeKey } from './keys.js';
import {
  ObjectNotFoundError,
  type HeadResult,
  type ObjectStore,
  type PutOpts,
  type PutResult,
  ObjectTooLargeError,
} from './types.js';

export interface S3ObjectStoreOptions {
  bucket: string;
  /** The client used for all server-side I/O — inside the compose network. */
  client: S3Client;
  /**
   * A second client whose endpoint is the *public* URL, used only for signing.
   *
   * SigV4 signs the `Host` header, so a URL signed against `http://minio:9000` fails with
   * `SignatureDoesNotMatch` the moment a browser requests it through Caddy at
   * `https://example.org/s3`. Two clients is the fix; one client is a silent breakage that
   * only shows up in a browser. Phase 10 wires this up with the presigned-audio route —
   * until then it is optional and `presignGet` falls back to the I/O client.
   */
  signingClient?: S3Client;
}

/** S3-compatible store. MinIO in production; also works against real S3. */
export class S3ObjectStore implements ObjectStore {
  readonly driver = 's3';
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly signingClient: S3Client;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.client = options.client;
    this.signingClient = options.signingClient ?? options.client;
  }

  async put(key: string, body: Buffer, opts: PutOpts = {}): Promise<PutResult> {
    return this.putStream(key, Readable.from([body]), opts);
  }

  async putStream(key: string, body: Readable, opts: PutOpts = {}): Promise<PutResult> {
    assertSafeKey(key);
    const hash = createHash('sha256');
    let bytes = 0;

    // Hash on the way past rather than by re-reading the object afterwards: the sha256 is
    // the content-address used for dedupe, and a second full read of a 2 GB upload to
    // compute it would double the I/O.
    const { maxBytes } = opts;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        // Erroring the transform fails `upload.done()`, which aborts the multipart upload
        // rather than leaving parts behind — see leavePartsOnError below.
        if (maxBytes !== undefined && bytes > maxBytes) {
          callback(new ObjectTooLargeError(key, maxBytes));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    body.pipe(counting);

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: counting,
        ...(opts.contentType ? { ContentType: opts.contentType } : {}),
        ...(opts.metadata ? { Metadata: opts.metadata } : {}),
      },
      // 8 MB parts: large enough that a 2 GB file stays under the 10,000-part limit,
      // small enough that a retry of one part is cheap.
      partSize: 8 * 1024 * 1024,
      queueSize: 4,
      // Explicit rather than inherited: this is lib-storage's default, but it is the thing
      // that stops an aborted or oversized upload leaving paid-for parts in the bucket, and a
      // silent dependency on a default is how that regresses. Phase 15's bucket also carries
      // an AbortIncompleteMultipartUpload lifecycle rule as a backstop.
      leavePartsOnError: false,
    });
    await upload.done();

    return { key, bytes, sha256: hash.digest('hex') };
  }

  async get(key: string, range?: { start: number; end?: number }): Promise<Readable> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range
            ? { Range: `bytes=${range.start}-${range.end === undefined ? '' : range.end}` }
            : {}),
        }),
      );
      return result.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        bytes: result.ContentLength ?? 0,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        etag: (result.ETag ?? '').replaceAll('"', ''),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    let batch: Array<{ Key: string }> = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch } }),
      );
      removed += batch.length;
      batch = [];
    };

    for await (const entry of this.list(prefix)) {
      batch.push({ Key: entry.key });
      // DeleteObjects caps at 1000 keys per request.
      if (batch.length === 1000) await flush();
    }
    await flush();
    return removed;
  }

  async *list(prefix: string): AsyncIterable<{ key: string; bytes: number }> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) yield { key: object.Key, bytes: object.Size ?? 0 };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}
