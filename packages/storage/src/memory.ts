import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { assertSafeKey } from './keys.js';
import {
  NotSupportedError,
  ObjectNotFoundError,
  type HeadResult,
  type ObjectStore,
  type PutOpts,
  type PutResult,
  ObjectTooLargeError,
} from './types.js';

interface Entry {
  body: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
  etag: string;
}

/**
 * In-memory store for tests. Backed by a Map, so a test file gets a fresh, isolated store
 * with no container, no cleanup and no cross-test bleed.
 */
export class MemoryObjectStore implements ObjectStore {
  readonly driver = 'memory';
  private readonly objects = new Map<string, Entry>();

  async put(key: string, body: Buffer, opts: PutOpts = {}): Promise<PutResult> {
    assertSafeKey(key);
    const sha256 = createHash('sha256').update(body).digest('hex');
    this.objects.set(key, {
      // Copy: a caller that reuses its buffer must not mutate what we stored.
      body: Buffer.from(body),
      ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      etag: sha256.slice(0, 32),
    });
    return { key, bytes: body.byteLength, sha256 };
  }

  async putStream(key: string, body: Readable, opts: PutOpts = {}): Promise<PutResult> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      const buf = Buffer.from(chunk as Buffer);
      bytes += buf.byteLength;
      // Checked per chunk rather than after the loop: this adapter's whole body is the
      // process heap, so accumulating an oversized upload before rejecting it would be the
      // failure the cap exists to prevent.
      if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
        throw new ObjectTooLargeError(key, opts.maxBytes);
      }
      chunks.push(buf);
    }
    return this.put(key, Buffer.concat(chunks), opts);
  }

  async get(key: string, range?: { start: number; end?: number }): Promise<Readable> {
    const entry = this.objects.get(key);
    if (!entry) throw new ObjectNotFoundError(key);
    const body = range
      ? entry.body.subarray(range.start, range.end === undefined ? undefined : range.end + 1)
      : entry.body;
    // A fresh Readable each call — a stream is consumable once.
    return Readable.from([body]);
  }

  async head(key: string): Promise<HeadResult | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      bytes: entry.body.byteLength,
      ...(entry.contentType !== undefined ? { contentType: entry.contentType } : {}),
      etag: entry.etag,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async *list(prefix: string): AsyncIterable<{ key: string; bytes: number }> {
    for (const key of [...this.objects.keys()].sort()) {
      if (key.startsWith(prefix)) yield { key, bytes: this.objects.get(key)!.body.byteLength };
    }
  }

  async presignGet(): Promise<string> {
    throw new NotSupportedError('presignGet', this.driver);
  }
}
