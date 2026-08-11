import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ObjectTooLargeError } from '@thibi/storage';
import type { EngineContext } from '../context.js';
import { probe } from '../audio/probe.js';
import { UnsupportedMediaError } from '../errors.js';
import { createOrReuseAsset, findAssetBySha, type StoredAsset } from './asset.js';
import { IngestError } from './errors.js';
import { allowedExtension, validateFilename } from './filename.js';

export interface IngestStreamInput {
  stream: Readable;
  filename: string;
  contentType: string;
  /**
   * A sha256 the client computed before uploading. When it matches an existing asset the
   * transfer is skipped entirely; when it disagrees with the received bytes the upload is
   * rejected and deleted.
   */
  declaredSha?: string | null;
  source: 'upload' | 'url' | 'batch' | 'api';
  sourceMeta?: unknown;
  userId?: string | null;
  /**
   * Hard cap on the body.
   *
   * Passed in rather than read from `ctx.settings`, which is a flat key/value port with no
   * `ingest` namespace — and reading ambient configuration inside a stage is the thing the
   * engine's lint rule forbids. The caller resolves the limit and states it.
   */
  maxBytes: number;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
}

export interface IngestedAsset extends StoredAsset {
  /** True when this content already existed; the bytes just uploaded were discarded. */
  deduped: boolean;
}

/**
 * The single entry point for media entering the system.
 *
 * The route, the CLI and the URL importer all call this — one implementation of hashing,
 * dedupe, probing and cleanup rather than three that drift. It replaces
 * `app/api/jobs/route.ts:45`:
 *
 *     fs.writeFileSync(destPath, Buffer.from(await file.arrayBuffer()));
 *
 * which buffers the body three times over and needs ~6 GB of heap for a 2 GB interview.
 * Nothing here holds more than one chunk: the stream goes to the store, and the store hashes
 * and counts as the bytes pass.
 *
 * Note there is no `HashingPassThrough`, which the Phase 8 plan specified. That plan predates
 * Phase 1 putting the sha256 inside `ObjectStore.putStream`, so the transform would have
 * hashed every uploaded byte a second time to compute a number the store already returns.
 * The one thing it added that the port lacked — the byte cap — is now `PutOpts.maxBytes`,
 * enforced by all three adapters and covered by the storage contract suite.
 */
export async function ingestStream(
  ctx: EngineContext,
  i: IngestStreamInput,
): Promise<IngestedAsset> {
  const filename = validateFilename(i.filename);
  const ext = allowedExtension(filename, i.contentType);

  // Cheap short-circuit before a single byte moves.
  if (i.declaredSha) {
    const existing = await findAssetBySha(ctx, i.declaredSha);
    if (existing) {
      i.stream.destroy();
      return { ...existing, deduped: true };
    }
  }

  const assetId = randomUUID();
  // No user-controlled byte reaches this key: a uuid and an allowlisted extension. That is
  // what makes filename sanitisation unnecessary rather than merely careful.
  //
  // Deliberately NOT `assetKey(sha256, ext)` from @thibi/storage, which Phase 1 uses for the
  // same kind of object and which is content-addressed. The two schemes coexist for a reason
  // that is easy to miss and expensive to "fix": a content-addressed key needs the hash
  // *before* the write, and a streamed upload does not know it until the last byte. Phase 1
  // hashes a local file first and can afford it; an HTTP request body cannot be rewound.
  //
  // The consequence is the `delete` on the dedupe path below. Under content-addressing the
  // loser of a race writes the same bytes to the same key and there is nothing to clean up —
  // under uuid keys it writes a second copy that nothing references. Anyone unifying these
  // must move that delete at the same time, or it will delete the winner's object.
  const key = `media/${assetId}/source.${ext}`;

  let put;
  try {
    put = await ctx.store.putStream(key, i.stream, {
      contentType: i.contentType,
      maxBytes: i.maxBytes,
    });
  } catch (err) {
    // Best-effort: a failed multipart upload aborts its own parts, but a partially written
    // fs object would otherwise linger.
    await ctx.store.delete(key).catch(() => {});
    if (err instanceof ObjectTooLargeError) {
      throw new IngestError(
        'file_too_large',
        `"${filename}" is larger than the ${i.maxBytes}-byte limit.`,
      );
    }
    throw err;
  }

  if (i.declaredSha && i.declaredSha.toLowerCase() !== put.sha256) {
    await ctx.store.delete(key).catch(() => {});
    throw new IngestError(
      'sha_mismatch',
      'The uploaded bytes do not match the declared sha256.',
      `declared ${i.declaredSha.toLowerCase()}, received ${put.sha256}`,
    );
  }

  // The content may already exist under a different declared hash, or under none: a client
  // that did not pre-hash reaches this point having uploaded a duplicate.
  const probed = await probeStored(ctx, key, filename);

  const { asset, inserted } = await createOrReuseAsset(ctx, {
    id: assetId,
    sha256: put.sha256,
    storageKey: key,
    filename,
    mime: i.contentType,
    bytes: put.bytes,
    durationMs: probed.durationMs,
    source: i.source,
    sourceMeta: i.sourceMeta ?? {},
    probeRaw: probed.raw,
  });

  // Lost the race, or the client did not pre-hash: the winner's object is the one referenced,
  // so these bytes have nothing pointing at them and must not be left to be paid for.
  if (!inserted) await ctx.store.delete(key).catch(() => {});

  i.onProgress?.(put.bytes);
  return { ...asset, deduped: !inserted };
}

/**
 * Probe an object that is already in the store, and turn its failures into ingest failures.
 *
 * The distinction this preserves is the whole reason it is not a one-liner: a file with no
 * audio is the uploader's problem and names the file, while a missing `ffprobe` is the
 * operator's and must not. Reporting the second as the first sends a journalist to re-export
 * a recording that was always fine.
 */
async function probeStored(
  ctx: EngineContext,
  key: string,
  filename: string,
): Promise<{ durationMs: number | null; raw: unknown }> {
  // ffprobe needs a path and the store hands out streams, so the object lands on disk here.
  // `await using` removes the directory on the throw paths below as well as on success —
  // a rejected upload must not leave a copy of someone's interview in /tmp.
  await using dir = await ctx.tmp.dir('ingest-probe');
  const path = `${dir.path}/media`;
  await pipeline(await ctx.store.get(key), createWriteStream(path));

  try {
    const result = await probe(ctx, { path });
    if (result.failure) {
      if (result.failure.reason === 'ffprobe_missing') {
        throw new IngestError(
          'ffprobe_missing',
          'ffprobe is not installed on the server, so uploaded media cannot be inspected.',
          result.failure.detail,
        );
      }
      throw new IngestError(
        'unreadable_media',
        `"${filename}" could not be read as media.`,
        result.failure.detail,
      );
    }
    // A null duration is accepted: some containers genuinely do not carry one, and the plan
    // stage already routes conservatively without it. Only a missing audio *stream* rejects.
    return { durationMs: result.durationMs, raw: result.raw };
  } catch (err) {
    if (err instanceof UnsupportedMediaError) {
      throw new IngestError('no_audio_stream', `"${filename}" has no audio stream.`, err.message);
    }
    throw err;
  }
}
