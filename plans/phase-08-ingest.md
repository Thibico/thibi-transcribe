# Phase 8 — Ingest: batch upload and URL import

## Goal

At the end of this phase every way media enters the system exists and is exercised from the CLI:
`thibi ingest ./file.m4a`, `thibi ingest ./dir --project "Election 2026"`, and
`thibi ingest --url <url>`. Uploads stream to object storage with a sha256 computed in the
passthrough, so a 2 GB file costs a few megabytes of RSS instead of OOM-ing the process the way
`app/api/jobs/route.ts:45` does today. Content-addressed dedupe means re-uploading the same
recording reuses the asset and creates a new job. Filenames are stored exactly as the user typed
them, because storage keys are derived from UUIDs and there is nothing left to sanitise. Files with
no audio stream are rejected at the door with a clear message rather than three stages later.

It sits at 8, before any UI, so that the `/jobs/new` tabs in phase 11 are thin wrappers over
already-tested engine functions and HTTP routes. It sits after 7 because export is the pure phase
and this is the first phase with a subprocess and untrusted remote input.

The two-step URL flow is the reason this phase is not "add yt-dlp": resolving metadata before
downloading is a **safety feature**. Duration is unknown until metadata returns, and that is
exactly the moment a surprise bill is created.

## Prerequisites

| From | What is needed |
|---|---|
| Phase 1 | `EngineContext`, `ObjectStore` port + S3/MinIO adapter, `media_assets`, `jobs`, `projects`, `thibi` CLI |
| Phase 1 | `rates` + `estimateCost()` — the batch and URL confirmations are worthless without real numbers |
| Phase 0 | Language registry, for the `--lang` validation and the default per project |
| Image | `ffprobe` and `yt-dlp` on `PATH` (both already baked into the Node image per the overview) |

Not required: phase 7, phase 9, phase 10. Auth is stubbed as `requireUser()` returning a fixed
system user until phase 10; the call sites are written now so phase 10 is a one-line change.

## Deliverables

| Path | Purpose |
|---|---|
| `packages/storage/src/port.ts` | **modified** — add `putStream`, `head`, `delete`, `abortMultipart` |
| `packages/storage/src/s3.ts` | **modified** — `putStream` via `@aws-sdk/lib-storage` `Upload` |
| `packages/storage/src/fs.ts` / `memory.ts` | **modified** — same three methods |
| `packages/engine/src/ingest/hash.ts` | `HashingPassThrough` — sha256 + byte count transform |
| `packages/engine/src/ingest/upload.ts` | `ingestStream(ctx, input)` — the single streaming entry point |
| `packages/engine/src/ingest/asset.ts` | `createOrReuseAsset` — the dedupe transaction |
| `packages/engine/src/ingest/probe.ts` | Port of `lib/audio/probe.ts`, extended to stream detection |
| `packages/engine/src/ingest/filename.ts` | Validation (not sanitisation) + extension allowlist |
| `packages/engine/src/ingest/batch.ts` | `ingestBatch(ctx, input)` — N assets, N jobs, one project, one estimate |
| `packages/engine/src/ingest/url/resolve.ts` | `resolveUrl` — `yt-dlp --dump-json`, no media |
| `packages/engine/src/ingest/url/download.ts` | `downloadUrl` — guarded yt-dlp invocation, streams to store |
| `packages/engine/src/ingest/url/policy.ts` | Scheme/host/IP checks, allowlist, size and duration caps |
| `packages/engine/src/ingest/url/token.ts` | Signed `resolveToken` binding URL + duration + estimate |
| `packages/engine/src/ingest/errors.ts` | `IngestError` with stable `code`s the UI maps to copy |
| `packages/engine/src/ingest/types.ts` | Step-shaped inputs/outputs, ready for phase 9 |
| `packages/db/src/schema/media.ts` | **modified** — `sha256` unique, `source`, `source_meta`, `probe_raw` |
| `packages/db/src/schema/jobs.ts` | **modified** — `source_batch_key`, unique `(project_id, source_batch_key, asset_id)` |
| `packages/db/migrations/00NN_ingest.sql` | Generated, committed |
| `apps/cli/src/commands/ingest.ts` | `thibi ingest` — file, directory, `--url`, `--manifest` |
| `apps/web/src/app/api/uploads/route.ts` | Streaming raw-body upload |
| `apps/web/src/app/api/uploads/probe/route.ts` | `POST {sha256}` → dedupe short-circuit |
| `apps/web/src/app/api/ingest/batch/route.ts` | N assets → 1 project, N jobs, 1 confirmation |
| `apps/web/src/app/api/imports/resolve/route.ts` | Metadata only. Costs nothing, downloads nothing |
| `apps/web/src/app/api/imports/route.ts` | Confirmed download; **never** starts a run by default |
| `README.md` | **modified** — the yt-dlp legal-responsibility line |

## Design

### 1. Streaming upload

`app/api/jobs/route.ts:45` is the anti-pattern this phase exists to delete:

```ts
fs.writeFileSync(destPath, Buffer.from(await file.arrayBuffer()));
```

`await request.formData()` buffers the entire multipart body, `arrayBuffer()` buffers it again, and
`Buffer.from` copies it a third time. A 2 GB interview needs ~6 GB of heap and exceeds V8's
`Buffer` limit long before that. Nothing about it is salvageable.

**The route takes a raw body, not multipart.** Metadata rides in headers. This is the only shape
that streams cleanly in an App Router route handler.

```ts
// apps/web/src/app/api/uploads/route.ts
import { Readable } from 'node:stream';
import { ingestStream } from '@thibi/engine/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Note: the 4.5 MB body limit is a Vercel platform limit. This app is self-hosted behind
// Caddy on a Node server; there is no framework body limit on a streamed request body.
// Caddy needs `request_body { max_size 0 }` for the upload route — see phase 15.

export async function POST(req: Request) {
  const user = await requireUser();
  const ctx = await getEngineContext();

  if (!req.body) return json({ error: 'empty body' }, 400);

  const filename = decodeHeaderValue(req.headers.get('x-thibi-filename'));   // RFC 5987 in
  const declaredSha = req.headers.get('x-thibi-sha256')?.toLowerCase() ?? null;
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream';
  const projectId = req.headers.get('x-thibi-project') ?? null;

  try {
    const asset = await ingestStream(ctx, {
      source: 'upload',
      filename,
      contentType,
      declaredSha,
      projectId,
      userId: user.id,
      stream: Readable.fromWeb(req.body as ReadableStream<Uint8Array>),
      signal: req.signal,
    });
    return json(asset, asset.deduped ? 200 : 201);
  } catch (e) {
    return ingestErrorResponse(e);       // maps IngestError.code → status + message
  }
}
```

The engine side. One function, no framework types:

```ts
// packages/engine/src/ingest/hash.ts
import { Transform, type TransformCallback } from 'node:stream';
import { createHash, type Hash } from 'node:crypto';

export class HashingPassThrough extends Transform {
  readonly hash: Hash = createHash('sha256');
  bytes = 0;
  constructor(private readonly maxBytes: number) { super(); }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      return cb(new IngestError('file_too_large', `exceeds ${this.maxBytes} bytes`));
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }
  digest(): string { return this.hash.digest('hex'); }
}
```

```ts
// packages/engine/src/ingest/upload.ts
export interface IngestStreamInput {
  stream: Readable;
  filename: string;
  contentType: string;
  declaredSha?: string | null;
  source: 'upload' | 'url' | 'batch' | 'api';
  sourceMeta?: unknown;
  projectId?: string | null;
  userId: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
}

export async function ingestStream(ctx: EngineContext, i: IngestStreamInput): Promise<IngestedAsset> {
  const name = validateFilename(i.filename);              // throws, never rewrites
  const ext = allowedExtension(name, i.contentType);      // throws on an unknown extension

  // Cheap short-circuit for clients that can hash before uploading (the CLI always can).
  if (i.declaredSha) {
    const existing = await findAssetBySha(ctx, i.declaredSha);
    if (existing) { i.stream.destroy(); return { ...existing, deduped: true }; }
  }

  const assetId = ctx.newId();
  const key = `media/${assetId}/source.${ext}`;           // no user bytes in the key, ever
  const hasher = new HashingPassThrough(ctx.settings.ingest.maxUploadBytes);

  await pipeline(i.stream, hasher, { signal: i.signal }, /* passthrough consumed below */);
  //  ^ in practice: store.putStream(key, i.stream.pipe(hasher), …) — one pass, see storage port

  const sha256 = hasher.digest();
  if (i.declaredSha && i.declaredSha !== sha256) {
    await ctx.store.delete(key);
    throw new IngestError('sha_mismatch', 'declared sha256 does not match the uploaded bytes');
  }

  // Probe from the store. The S3 adapter presigns a local URL; the fs adapter passes a path.
  const probe = await probeMedia(ctx, key);
  if (!probe.ok) { await ctx.store.delete(key); throw probeError(probe, name); }

  const { asset, inserted } = await createOrReuseAsset(ctx, {
    id: assetId, sha256, storageKey: key, filename: name,
    mime: i.contentType, bytes: hasher.bytes,
    durationMs: probe.durationMs, source: i.source, sourceMeta: i.sourceMeta ?? null,
    probeRaw: probe.raw,
  });

  if (!inserted) await ctx.store.delete(key);             // duplicate: drop the bytes we just wrote
  return { ...asset, deduped: !inserted };
}
```

The `ObjectStore` port gains three methods so the engine never touches the S3 SDK:

```ts
// packages/storage/src/port.ts
export interface ObjectStore {
  putStream(key: string, body: Readable, o: {
    contentType?: string;
    onProgress?: (loaded: number) => void;
    signal?: AbortSignal;
  }): Promise<{ bytes: number }>;
  head(key: string): Promise<{ bytes: number; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  // …get, presignGet, put from phase 1
}
```

```ts
// packages/storage/src/s3.ts
import { Upload } from '@aws-sdk/lib-storage';

async putStream(key, body, o) {
  const upload = new Upload({
    client: this.s3,                       // the internal client (http://minio:9000), never s3Public
    params: { Bucket: this.bucket, Key: key, Body: body, ContentType: o.contentType },
    partSize: 16 * 1024 * 1024,            // 16 MB → 2 GB in 128 parts, well under the 10 000 cap
    queueSize: 4,
    leavePartsOnError: false,              // abort cleans up parts; the bucket also has a
                                           // 1-day AbortIncompleteMultipartUpload rule as backstop
  });
  if (o.onProgress) upload.on('httpUploadProgress', p => o.onProgress!(p.loaded ?? 0));
  o.signal?.addEventListener('abort', () => void upload.abort(), { once: true });
  await upload.done();
  return { bytes: /* from the hashing transform */ };
}
```

CLI equivalent — same engine function, a file stream instead of a request body, and it always
pre-hashes because the file is local and reading it twice is cheap next to uploading it once:

```ts
// apps/cli/src/commands/ingest.ts
const sha = await sha256File(abs);                        // streamed, no buffering
const asset = await ingestStream(ctx, {
  stream: createReadStream(abs),
  filename: basename(abs),
  contentType: mimeFromExtension(abs),
  declaredSha: sha,
  source: 'upload',
  userId: ctx.systemUserId,
  onProgress: bytes => bar.update(bytes),
});
```

### 2. Content dedupe

`media_assets.sha256` is `UNIQUE`. A re-upload reuses the asset and creates a new job.

```sql
-- packages/engine/src/ingest/asset.ts
INSERT INTO media_assets
  (id, sha256, storage_key, filename, mime, bytes, duration_ms, source, source_meta, probe_raw)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
ON CONFLICT (sha256) DO UPDATE
  SET filename = media_assets.filename        -- deliberate no-op: takes the row lock and RETURNS
RETURNING id, storage_key, filename, duration_ms, bytes, (xmax = 0) AS inserted;
```

`DO UPDATE` rather than `DO NOTHING` on purpose: `DO NOTHING` returns zero rows on conflict and a
follow-up `SELECT` in the same transaction cannot see a concurrent inserter's uncommitted row, so
two simultaneous uploads of the same file race. `DO UPDATE` blocks on the row lock and always
returns. `xmax = 0` distinguishes the insert from the conflict path.

Consequences that must be handled now, not discovered later:

| Consequence | Handling |
|---|---|
| The kept `filename` is the **first** upload's | The `jobs.title` carries the second upload's name, so the UI shows what the user just uploaded. Documented in the API response as `deduped: true, existingFilename` |
| Two jobs share one asset | Retention (phase 15) must not delete an object while another non-deleted job references it. Add the guard now as a comment in the schema and a note in the phase-15 plan |
| A duplicate wasted a full upload | The CLI never does (it pre-hashes). The browser does. `POST /api/uploads/probe {sha256}` exists for any client that can hash first; the browser is not required to |
| `deduped` must be visible | `201` for a new asset, `200` for a reuse; `{ deduped: true }` in the body |

### 3. Filename handling

Delete this on sight:

```ts
// app/api/jobs/route.ts:42
const safeName = file.name.replace(/[^\w.\-က-႟]+/g, "_");
```

It whitelists ASCII word characters plus the Myanmar block and replaces everything else with `_`.
`مصاحبه با استاد.mp3` becomes `_______.mp3`; `ការសម្ភាសន៍.m4a` becomes `_.m4a`. In a tool whose entire
thesis is the 44 languages nobody else serves, a filename sanitiser hardcoded to one script is a
bug with a flag on it.

**The replacement is to make sanitisation unnecessary.** Storage keys are `media/{uuid}/source.{ext}`
where `ext` comes from an allowlist, so no user-controlled byte ever reaches a path. The original
filename is a data column, and data columns hold data.

```ts
// packages/engine/src/ingest/filename.ts
const MAX_FILENAME_BYTES = 255;

/** Validates. Never rewrites. The DB stores exactly what the user had. */
export function validateFilename(raw: string): string {
  const base = raw.split(/[\/\\]/).pop() ?? '';           // strip any path component
  const name = base.normalize('NFC').trim();
  if (name === '' || name === '.' || name === '..') throw new IngestError('bad_filename', '…');
  if (/[\u0000-\u001F\u007F]/.test(name))            throw new IngestError('bad_filename', 'control characters');
  if (Buffer.byteLength(name, 'utf8') > MAX_FILENAME_BYTES) throw new IngestError('bad_filename', 'too long');
  return name;
}

const ALLOWED = new Map<string, string>([
  ['mp3','audio/mpeg'], ['wav','audio/wav'],  ['m4a','audio/mp4'],  ['mp4','video/mp4'],
  ['aac','audio/aac'],  ['ogg','audio/ogg'],  ['oga','audio/ogg'],  ['opus','audio/opus'],
  ['flac','audio/flac'],['webm','video/webm'],['amr','audio/amr'],  ['mkv','video/x-matroska'],
  ['mov','video/quicktime'], ['3gp','audio/3gpp'], ['wma','audio/x-ms-wma'], ['aiff','audio/aiff'],
]);

/** The only value that reaches a storage key. Lowercase, from a fixed set. */
export function allowedExtension(filename: string, contentType: string): string {
  const ext = (filename.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] ?? '').toLowerCase();
  if (ALLOWED.has(ext)) return ext;
  const byMime = [...ALLOWED].find(([, m]) => contentType.startsWith(m))?.[0];
  if (byMime) return byMime;
  throw new IngestError('unsupported_type', `"${filename}" is not a supported media file`);
}
```

The `ACCEPTED_EXTENSIONS` set at `app/api/jobs/route.ts:10-12` is the seed for `ALLOWED`, extended
and given MIME types. The `looksLikeAudio` heuristic at `:32-33` is kept as a *first* filter but is
no longer the decision — `ffprobe` is (section 6).

The original filename is now displayed and embedded in three places; each is escaped at its own
boundary, never at ingest:

| Surface | Escaping |
|---|---|
| HTML (job list, editor) | React's default escaping; never `dangerouslySetInnerHTML` |
| `Content-Disposition` on export/download | `contentDisposition()` from phase 7 (RFC 5987 + ASCII fallback) |
| DOCX / Markdown provenance line | The `docx` package escapes runs; Markdown escapes `[]()` in the title |

### 4. Batch ingest

Two calls, deliberately. Uploads are independent, long, and individually resumable; job creation is
one short transaction with one cost confirmation. Fusing them would mean re-uploading twenty files
because the twentieth was a PDF.

```
POST /api/uploads          × N   → assetIds
POST /api/ingest/batch     × 1   → project + N jobs + one estimate
```

```jsonc
// POST /api/ingest/batch
{
  "batchKey": "9f2c…",                       // client-generated UUID; makes the call idempotent
  "project": { "id": "…" },                  // or { "name": "Election 2026" } to get-or-create
  "defaults": { "languageCode": "my-MM", "providerId": "google", "model": "chirp_2" },
  "items": [
    { "assetId": "…", "title": "01 Daw Khin" },
    { "assetId": "…", "title": "02 U Thein", "languageCode": "shn" }   // per-row override
  ],
  "confirm": true                            // false → returns the estimate and creates nothing
}
```

```jsonc
// 200 with confirm:false — the estimate the UI shows before the button is enabled
{
  "projectId": null,
  "estimate": {
    "items": [{ "assetId": "…", "durationMs": 4324000, "usd": 1.15 }],
    "totalDurationMs": 14650000,
    "totalUsd": 3.90,
    "rateSource": "default",
    "unpriced": []                            // assets whose duration is unknown — listed, not hidden
  },
  "jobs": []
}
```

Idempotency is a single column, not a table:

```sql
ALTER TABLE jobs ADD COLUMN source_batch_key text;
CREATE UNIQUE INDEX jobs_batch_uniq ON jobs (project_id, source_batch_key, asset_id)
  WHERE source_batch_key IS NOT NULL;
```

A retried `POST /api/ingest/batch` with the same `batchKey` inserts `ON CONFLICT DO NOTHING` and
returns the existing jobs. Without it, a flaky connection at the confirm step creates twenty
duplicate jobs and twenty duplicate bills.

**One shared language and provider with a per-row override** is a hard requirement from the
overview's UI section — twenty individual pickers is the failure mode. The API expresses it as
`defaults` + optional per-item keys, and the CLI expresses it as `--lang` plus an optional
manifest.

```
thibi ingest ./interviews --project "Election 2026" --lang my --provider google
thibi ingest --manifest ./batch.csv --project "Election 2026"
```

`batch.csv` columns: `path,title,language,provider,model` — `path` required, the rest inherit from
the flags when blank. Same seven-column-TSV spirit as the eval harness's `--manifest`: one obvious
file format, hand-editable.

CLI output — the confirmation is the point of the whole command:

```
$ thibi ingest ./interviews --project "Election 2026" --lang my
  scanning ./interviews … 4 candidates

  file                          duration   audio         est. ASR
  01-daw-khin.m4a                1:12:04   aac 44.1k       $1.15
  02-u-thein.mp3                   48:11   mp3 44.1k       $0.77
  03-panel.wav                   2:03:55   pcm 48k         $1.98
  04-notes.pdf                         —   no audio stream  skipped
  ──────────────────────────────────────────────────────────────
  3 files · 4:04:10 · google/chirp_2 · my-MM               $3.90

  Create 3 jobs in project "Election 2026"? [y/N]
```

`--dry-run` prints the table and exits 0. `--yes` skips the prompt. `--concurrency` (default 3)
caps parallel uploads. `--recursive` walks subdirectories; without it, one level.
Unsupported files are **listed and skipped**, never silently dropped — a batch that quietly ingests
3 of 4 files is how a newsroom loses an interview.

### 5. URL import via yt-dlp

Two steps, and the split is the safety property.

```
POST /api/imports/resolve   { url }                          → metadata + estimate + resolveToken
POST /api/imports           { resolveToken, languageCode, … } → job (status ready, no run)
```

```ts
// packages/engine/src/ingest/url/resolve.ts
export interface ResolvedMedia {
  url: string; webpageUrl: string; extractor: string; id: string;
  title: string; uploader: string | null; uploaderUrl: string | null;
  uploadDate: string | null;            // 'YYYY-MM-DD', from yt-dlp's YYYYMMDD
  durationMs: number | null;
  filesizeApproxBytes: number | null;
  isLive: boolean;
  thumbnailUrl: string | null;
  ytdlpVersion: string;
  resolvedAt: string;
}

export async function resolveUrl(ctx: EngineContext, url: string): Promise<ResolvedMedia> {
  await assertUrlAllowed(ctx, url);                       // policy.ts — before spawning anything
  const { stdout } = await execFileP('yt-dlp', [
    '--dump-json', '--no-playlist', '--simulate', '--no-warnings',
    ...HARDENING, url,
  ], { signal: AbortSignal.timeout(ctx.settings.ingest.url.resolveTimeoutMs), maxBuffer: 8 << 20 });
  const j = JSON.parse(stdout);
  if (j.is_live) throw new IngestError('live_stream', 'live streams cannot be imported');
  if (j.duration == null) throw new IngestError('unknown_duration',
    'the site did not report a duration, so the cost cannot be estimated');
  return normalize(j);
}
```

**`--dump-json` downloads no media.** It costs one metadata request. Everything the confirmation
dialog needs — the real title, the real duration, therefore the real cost — comes from it.

`resolveToken` is an HMAC over `{url, durationMs, estimateUsd, exp}` signed with `APP_SECRET_KEY`,
TTL 10 minutes. The confirm step re-derives the estimate from the token, not from a fresh
resolve, so **the cost the user approved is the cost they get**. A URL that swaps its content
between resolve and confirm cannot escalate the bill; the download's `--match-filter` catches it
independently.

**Transcription never auto-starts.** `POST /api/imports` creates the asset and a job in status
`ready` and returns. Starting a run is a separate, explicit action. `startRun: true` exists for
scripting and is off in the UI and off in the CLI without `--start`.

#### Guardrails

`HARDENING` is a shared constant so no call site can forget it:

```ts
// packages/engine/src/ingest/url/policy.ts
export const HARDENING = [
  '--ignore-config',            // do not read /etc/yt-dlp.conf or ~/.config/yt-dlp
  '--no-plugin-dirs',           // do not load plugins from the filesystem
  '--no-exec',                  // strip any --exec hook
  '--no-playlist',              // one item, never a 400-video channel
  '--no-mtime',
  '--restrict-filenames',
  '--socket-timeout', '30',
  '--retries', '3',
];
```

| Guard | Mechanism |
|---|---|
| Worker-only execution | The `ingest.url.download` step is registered on the worker queue only. The web process never spawns `yt-dlp`; `/api/imports` enqueues (phase 9) or, in phase 8, the CLI calls the function directly. `apps/web` has no import path to `download.ts` — enforced by a lint rule |
| Non-root | Image runs `USER app`; `execFile` inherits it |
| No shell | `execFile('yt-dlp', argv)` with an array — never `exec`, never a template string, never `shell: true` |
| No config / plugins / hooks | `--ignore-config --no-plugin-dirs --no-exec` |
| Size cap | `--max-filesize` from `ingest.url.maxFilesizeBytes` (default `2G`), **plus** `HashingPassThrough(maxBytes)` on the way to the store, because a `--max-filesize` bypass must not become an unbounded write |
| Duration cap | `--match-filter "duration<?14400"` (4 h). **Note the `<?` operator: it passes when the field is *missing*.** That is deliberate in yt-dlp and is a footgun, so `resolveUrl` independently rejects `duration == null`, and the download step re-checks the resolved duration from the token |
| No live streams | `!is_live` in the match filter and an explicit check in `resolveUrl` |
| Domain allowlist | `ingest.url.allowedHosts: string[]`, empty = allow all. Checked against the host of both the submitted URL and the resolved `webpage_url` |
| SSRF | Reject non-`http(s)` schemes; resolve the host with `dns.lookup({all:true})` and reject loopback / private / link-local / CGNAT / IPv6 ULA. **Defense in depth only** — yt-dlp follows its own redirects, so this narrows the surface, it does not close it. Say so in the code comment |
| Concurrency | Max 2. Phase 8: an in-process semaphore in `download.ts`. Phase 9: a pg-boss singleton key on the same function. The semaphore is injected via `ctx.concurrency`, so the swap is configuration |
| Wall-clock timeout | `AbortSignal.timeout(ingest.url.downloadTimeoutMs)` kills the child; the temp dir is removed in `finally` |
| Output path | `--paths temp:<mkdtemp> --output "%(id)s.%(ext)s"` in a per-download temp dir. The resulting filename is never trusted — the file is streamed to `media/{uuid}/source.{ext}` |
| Disk | Temp dir on a bounded volume; `df` check before starting, using `filesize_approx` |
| Legal | README line, verbatim below |

README addition:

> **URL import uses [yt-dlp](https://github.com/yt-dlp/yt-dlp).** Downloading media from a
> third-party site may be restricted by that site's terms of service and by copyright law in your
> jurisdiction. Whether a given download is lawful is the operator's responsibility, not this
> software's. URL import can be disabled entirely by setting `INGEST_URL_ENABLED=false`.

Download invocation:

```ts
const argv = [
  ...HARDENING,
  '--match-filter', `duration<?${maxSeconds} & !is_live`,
  '--max-filesize', String(maxBytes),
  '-f', 'bestaudio/best',                     // no re-encode; normalize handles the container
  '--paths', `temp:${tmp}`, '--paths', `home:${tmp}`,
  '--output', '%(id)s.%(ext)s',
  '--newline',
  '--progress-template', 'PROG %(progress.downloaded_bytes)d %(progress.total_bytes_estimate)d',
  url,
];
```

`--progress-template` lines are parsed off stdout into `onProgress`, which in phase 8 drives the
CLI bar and in phase 9 becomes a `run_events` emission — the same callback either way.

CLI:

```
$ thibi ingest --url https://…
  resolving metadata (no media downloaded)…

  title     ရွေးကောက်ပွဲ မဲဆွယ်စည်းရုံးရေး ဆွေးနွေးပွဲ
  uploader  DVB TVnews
  uploaded  2026-07-14
  duration  1:47:22
  source    youtube · https://…

  estimate  google/chirp_2 · my-MM · $1.72
  note      transcription is NOT started; run `thibi transcribe --job <id>` when ready

  Download 1:47:22 of audio? [y/N]
```

`--resolve-only` prints the metadata as JSON and exits. `--yes` skips the prompt but still
resolves first — there is no code path that downloads before knowing the duration.

#### `source_meta`

Stored on `media_assets.source_meta` (jsonb), with `media_assets.source = 'url'`:

```jsonc
{
  "kind": "url",
  "submittedUrl": "https://…",
  "webpageUrl": "https://…",
  "extractor": "youtube",
  "extractorId": "dQw4w9WgXcQ",
  "title": "ရွေးကောက်ပွဲ မဲဆွယ်စည်းရုံးရေး ဆွေးနွေးပွဲ",
  "uploader": "DVB TVnews",
  "uploaderUrl": "https://…",
  "uploadDate": "2026-07-14",
  "durationMs": 6442000,
  "thumbnailUrl": "https://…",
  "ytdlpVersion": "2026.07.21",
  "resolvedAt": "2026-08-09T10:22:11.004Z",
  "importedBy": "user-uuid"
}
```

Surfaced in four places, all of which matter for a newsroom that has to say where a clip came from:

| Where | What |
|---|---|
| `jobs.title` | Defaults to `source_meta.title`; the user can rename, and renaming does not touch `source_meta` |
| Job page header | `Imported from YouTube · DVB TVnews · 14 Jul 2026` with `webpageUrl` as a link |
| JSON export | Verbatim under `asset.sourceMeta` (phase 7's provenance block already has the slot) |
| DOCX / Markdown provenance line | `Source: DVB TVnews, YouTube, 14 July 2026 — <url>` |

`thumbnailUrl` is stored but **never fetched by the server** — rendering it would make the app issue
an outbound request per job list row. The UI shows it only if the operator opts in.

### 6. Probe and reject early

`lib/audio/probe.ts` is ported including its graceful degradation, but the return type becomes a
discriminated union, because ingest must distinguish "this file has no audio" (reject the file)
from "ffprobe is not installed" (an operator problem, not the user's).

```ts
// packages/engine/src/ingest/probe.ts
export interface AudioStreamInfo {
  codecName: string | null; sampleRate: number | null; channels: number | null;
  bitRate: number | null; durationMs: number | null;
}
export type ProbeResult =
  | { ok: true; durationMs: number | null; formatName: string | null;
      audio: AudioStreamInfo[]; raw: unknown }
  | { ok: false; reason: 'no_audio_stream' | 'unreadable' | 'ffprobe_missing'; detail: string };

export async function probeMedia(ctx: EngineContext, keyOrPath: string): Promise<ProbeResult> {
  const target = await ctx.store.localPathOrPresigned(keyOrPath);   // ffprobe reads http(s) fine
  try {
    const { stdout } = await execFileP(ctx.ffmpeg.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration,format_name,bit_rate',
      '-show_streams', '-select_streams', 'a',
      '-of', 'json', target,
    ], { signal: AbortSignal.timeout(60_000) });
    const p = JSON.parse(stdout);
    const audio = (p.streams ?? []).map(toAudioStreamInfo);
    if (audio.length === 0) return { ok: false, reason: 'no_audio_stream', detail: p.format?.format_name ?? '' };
    const d = p.format?.duration ? parseFloat(p.format.duration) : NaN;
    return {
      ok: true,
      durationMs: Number.isFinite(d) ? Math.round(d * 1000) : null,   // graceful null, as before
      formatName: p.format?.format_name ?? null,
      audio, raw: p,
    };
  } catch (e) {
    if (isEnoent(e)) return { ok: false, reason: 'ffprobe_missing', detail: String(e) };
    return { ok: false, reason: 'unreadable', detail: truncate(String(e), 500) };
  }
}
```

What changes from `probe.ts`, and why:

| Old behaviour | New | Reason |
|---|---|---|
| Returns `{durationSec: null}` on any failure | Discriminated union with a `reason` | The UI needs different copy per cause, and `ffprobe_missing` is a 500, not a 400 |
| Only `format=duration,format_name` | Adds `-show_streams -select_streams a` | The whole point: detect zero audio streams |
| Duration `null` swallowed | **Kept** — still `null`, still non-fatal | A stream-copied WebM legitimately has no container duration; `media.normalize` computes it. This graceful-nulls behaviour is correct and travels verbatim in spirit |
| Seconds | Milliseconds | Schema-wide |

Rejection mapping, all at ingest:

| `reason` | HTTP | Message |
|---|---|---|
| `no_audio_stream` | 400 | `"notes.pdf" has no audio track. Upload an audio or video file with sound.` |
| `unreadable` | 400 | `"clip.m4a" could not be read as media. It may be corrupt or truncated.` |
| `ffprobe_missing` | 500 | `ffprobe is not available in this container. This is a server configuration problem.` |

The object is deleted before the error is returned; a rejected file leaves nothing in the bucket.

### 7. Where phase 9 takes over

Everything in `ingest/url/` is already written in step shape, so phase 9 changes callers, not
signatures:

```ts
// packages/engine/src/ingest/types.ts
export interface StepEnv {
  signal?: AbortSignal;
  heartbeat?: () => void;                 // no-op default in phase 8
  onProgress?: (p: { loaded: number; total?: number }) => void;
}
export type IngestUrlResolveInput  = { url: string; userId: string };
export type IngestUrlResolveOutput = ResolvedMedia;
export type IngestUrlDownloadInput = { resolved: ResolvedMedia; projectId: string | null; userId: string };
export type IngestUrlDownloadOutput= { assetId: string; sha256: string; bytes: number; durationMs: number | null };

export declare function ingestUrlResolve (ctx: EngineContext, i: IngestUrlResolveInput,  env?: StepEnv): Promise<IngestUrlResolveOutput>;
export declare function ingestUrlDownload(ctx: EngineContext, i: IngestUrlDownloadInput, env?: StepEnv): Promise<IngestUrlDownloadOutput>;
```

| Concern | Phase 8 | Phase 9 | Interface change |
|---|---|---|---|
| Who calls | CLI inline; `/api/imports` inline behind the 2-slot semaphore | `run_steps` planner enqueues `ingest.url.download` | none |
| Cancellation | `env.signal` from the CLI's SIGINT handler | `AbortSignal` from `runs.cancel_requested_at` | none |
| Heartbeat | `env.heartbeat` defaults to a no-op | Writes `run_steps.heartbeat_at` every 15 s | none |
| Progress | `env.onProgress` → CLI bar | → `run_events` insert + `pg_notify` | none |
| Concurrency | in-process semaphore of 2 | pg-boss queue `batchSize` + singleton key | `ctx.concurrency` value only |
| Retry | none; the CLI reports and exits | `run_steps.attempt`, 3 × 30 s with jitter | none |

Reserve `'ingest.url.resolve'` and `'ingest.url.download'` in the `run_steps.kind` enum **in this
phase's migration**, so phase 9 adds no enum value and its migration stays additive.

Streaming upload stays in the web process permanently — it is request-bound and cannot be a queue
step. That is the one asymmetry, and it is inherent.

## Porting notes

| Old | New | Treatment |
|---|---|---|
| `lib/audio/probe.ts:16-38` | `engine/src/ingest/probe.ts` | **Changed** — discriminated union, `-show_streams -select_streams a`, ms. The graceful-nulls docblock at `:11-15` travels, reworded for the new union |
| `app/api/jobs/route.ts:10-12` `ACCEPTED_EXTENSIONS` | `ingest/filename.ts` `ALLOWED` | Seed kept, extended, given MIME types |
| `app/api/jobs/route.ts:31-39` `looksLikeAudio` | `ingest/filename.ts` | Kept as a cheap pre-filter; `ffprobe` is now the decision |
| `app/api/jobs/route.ts:41` `crypto.randomUUID()` | `ctx.newId()` | Moved onto the context — the engine never touches globals |
| `app/api/jobs/route.ts:49-54` insert | `ingest/asset.ts` | Split into `media_assets` + `jobs`; upsert on `sha256` |
| `app/api/jobs/route.ts:14-22` `GET` | `/api/jobs` (phase 11) | Not in this phase |

**Must not survive the port:**

- `app/api/jobs/route.ts:42` — the `[^\w.\-က-႟]+` sanitiser. There is no replacement function.
  If a future PR adds one, the review answer is "storage keys are UUIDs."
- `app/api/jobs/route.ts:45` — `fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()))`.
  A grep for `arrayBuffer()` in `apps/web` is a CI check.
- `app/api/jobs/route.ts:43` — `${id}-${safeName}` as a path. No user bytes in keys.
- `UPLOADS_DIR` and any `fs` write outside the `fs` storage adapter.
- The single `jobs` table holding file metadata. `media_assets` owns the file; `jobs` owns the
  intent. That separation is what makes dedupe possible.

## Tests

### `packages/engine/src/ingest/__tests__/upload.test.ts`

Uses `MemoryObjectStore` and a throwaway Postgres.

| Case | Assertion |
|---|---|
| `streams-without-buffering` | Feed a 512 MB generated `Readable`; assert peak `process.memoryUsage().heapUsed` delta < 64 MB. This is the regression guard on the OOM bug and it must be in CI |
| `sha-matches-content` | Digest equals `sha256sum` of the same bytes |
| `declared-sha-mismatch` | Throws `sha_mismatch`; the object is deleted |
| `oversize-aborts` | `maxUploadBytes` exceeded → `file_too_large`, no object left, multipart aborted |
| `abort-signal` | Aborting mid-stream leaves no object and no `media_assets` row |
| `progress-monotonic` | `onProgress` values are non-decreasing and end at `bytes` |

### `__tests__/dedupe.test.ts`

| Fixture / case | Assertion |
|---|---|
| `same-file-twice` | One `media_assets` row, two `jobs` rows, second response `deduped: true`, status 200 |
| `concurrent-identical` | Two `ingestStream` calls in parallel → exactly one row, no unique-violation error escapes |
| `first-filename-wins` | `media_assets.filename` is the first upload's; `jobs.title` is the second's |
| `duplicate-object-deleted` | The second upload's temp object is gone from the store |
| `cli-short-circuit` | With `declaredSha` matching an existing asset, `putStream` is never called |

### `__tests__/filename.test.ts`

| Input | Expected |
|---|---|
| `مصاحبه با استاد.mp3` | Stored **unchanged**; ext `mp3`; key contains no Arabic |
| `ការសម្ភាសន៍.m4a` | Stored unchanged |
| `မင်္ဂလာပါ.wav` | Stored unchanged (the old regex's only passing case — assert it is not special) |
| `../../etc/passwd.mp3` | Basename only → `passwd.mp3` |
| `a\u0000b.mp3` | Throws `bad_filename` |
| `x.exe` | Throws `unsupported_type` |
| `interview` (no ext) with `content-type: audio/mpeg` | Ext resolved to `mp3` from MIME |
| 300-byte UTF-8 name | Throws `bad_filename` |
| `Café.MP3` | NFC-normalised, ext lowercased to `mp3`, name keeps its case |

Plus a snapshot test asserting `storageKey` matches `/^media\/[0-9a-f-]{36}\/source\.[a-z0-9]{1,5}$/`
for every one of those inputs.

### `__tests__/probe.test.ts` — `__fixtures__/media/`

| Fixture | Assertion |
|---|---|
| `tone-3s.wav` | `ok`, `durationMs ≈ 3000`, one audio stream |
| `silent-video-no-audio.mp4` | `ok: false, reason: 'no_audio_stream'` |
| `notes.pdf` | `ok: false, reason: 'unreadable'` |
| `truncated.mp3` | `ok: false, reason: 'unreadable'` |
| `no-container-duration.webm` | `ok: true`, `durationMs: null` — **graceful null preserved**, not a rejection |
| `video-with-audio.mkv` | `ok`, accepted (video containers are valid input) |
| ffprobe stubbed to ENOENT | `reason: 'ffprobe_missing'` → 500, not 400 |

### `__tests__/batch.test.ts`

| Case | Assertion |
|---|---|
| `mixed-directory` | 3 media + 1 PDF → 3 jobs, PDF listed in `skipped` with a reason |
| `estimate-before-confirm` | `confirm: false` creates zero rows and returns a total matching the per-item sum |
| `per-row-override` | An item's `languageCode` wins over `defaults` |
| `unknown-duration-listed` | An asset with `durationMs: null` appears in `estimate.unpriced`, not silently at $0 |
| `idempotent-retry` | Same `batchKey` twice → 3 jobs total, not 6 |
| `project-get-or-create` | `{name}` twice → one project, matched by slug |

### `__tests__/url.test.ts`

yt-dlp is stubbed by a fixture executable on `PATH` that echoes recorded JSON, so the suite is
offline and deterministic. `__fixtures__/ytdlp/`: `youtube-1h47m.json`, `live.json`,
`no-duration.json`, `playlist.json`, `age-gated-error.txt`.

| Case | Assertion |
|---|---|
| `resolve-does-not-download` | The stub records argv; asserts `--simulate` and `--dump-json` present and no output file written |
| `hardening-flags-present` | Every one of `HARDENING` appears in argv for both resolve and download |
| `live-rejected` | `live.json` → `IngestError('live_stream')` |
| `null-duration-rejected` | `no-duration.json` → `IngestError('unknown_duration')` — the `<?` footgun guard |
| `playlist-collapsed` | `--no-playlist` present; a playlist URL yields one item |
| `token-binds-cost` | A tampered `resolveToken` (duration edited) fails HMAC verification |
| `token-expiry` | `FakeClock` + 11 min → `token_expired` |
| `allowlist-blocks` | `allowedHosts: ['dvb.no']` and a youtube URL → `host_not_allowed`, yt-dlp never spawned |
| `ssrf-private-ip` | `http://169.254.169.254/…` and `http://10.0.0.5/…` rejected before spawn |
| `scheme-rejected` | `file:///etc/passwd`, `ftp://…` rejected |
| `no-shell-injection` | A URL containing `; rm -rf /` and backticks is passed as one argv element; the stub asserts it verbatim |
| `never-auto-starts` | `POST /api/imports` without `startRun` creates a job with no `runs` row |
| `concurrency-2` | 5 concurrent downloads → the stub observes at most 2 running |
| `timeout-kills-child` | A stub that sleeps → child killed, temp dir removed, `IngestError('timeout')` |
| `source-meta-shape` | The stored jsonb matches the documented keys exactly (snapshot) |

### `apps/web` route tests

`uploads.route.test.ts` asserts `request.formData()` and `arrayBuffer()` appear nowhere in
`apps/web/src/app/api/uploads/`, by static grep — the cheapest possible guard against the old
pattern reappearing.

## Verification

```bash
pnpm --filter @thibi/engine test
pnpm --filter @thibi/storage test

# the memory guard, run explicitly with a hard cap
node --max-old-space-size=256 \
  ./node_modules/.bin/tsx packages/engine/src/ingest/__tests__/large-upload.ts
# generates 2 GB through the pipeline; must complete. Under the old code this OOMs.

# a real 2 GB upload through the route
head -c 2147483648 /dev/urandom > /tmp/big.bin && \
  ffmpeg -f lavfi -i "sine=frequency=440:duration=7200" -c:a aac /tmp/big.m4a
curl -sS -X PUT --data-binary @/tmp/big.m4a \
  -H 'content-type: audio/mp4' \
  -H "x-thibi-filename: $(printf 'مصاحبه با استاد.m4a' | jq -sRr @uri)" \
  http://localhost:3000/api/uploads | jq
# while it runs, in another shell:
watch -n1 'ps -o rss=,comm= -p $(pgrep -f "next start" | head -1)'
# RSS must stay flat. Any growth tracking the upload size is the bug returning.

# filename preserved byte-for-byte
psql -c "select filename, storage_key from media_assets order by created_at desc limit 1"
# → مصاحبه با استاد.m4a | media/<uuid>/source.m4a

# dedupe
curl … same file again | jq '.deduped'      # true
psql -c "select count(*) from media_assets"  # unchanged
psql -c "select count(*) from jobs"          # +1

# probe rejection
curl -sS -X PUT --data-binary @./README.md -H 'content-type: audio/mpeg' \
  -H 'x-thibi-filename: notes.md' http://localhost:3000/api/uploads -w '\n%{http_code}\n'
# → 400 with "has no audio track" / "could not be read as media"

# batch
thibi ingest ./fixtures/interviews --project "Election 2026" --lang my --dry-run
thibi ingest ./fixtures/interviews --project "Election 2026" --lang my --yes
psql -c "select p.name, count(*) from jobs j join projects p on p.id=j.project_id group by 1"

# url — resolve costs nothing and downloads nothing
thibi ingest --url "$URL" --resolve-only | jq '{title,uploader,duration:.durationMs,estimate}'
du -sh /tmp/thibi-dl-* 2>/dev/null || echo "no temp dir created — correct"

# url — full flow, confirming that nothing auto-starts
thibi ingest --url "$URL" --lang my --yes
psql -c "select id, status, primary_run_id from jobs order by created_at desc limit 1"
# → status 'ready', primary_run_id NULL

# guardrails
thibi ingest --url 'file:///etc/passwd'                  # scheme_rejected
thibi ingest --url 'http://169.254.169.254/latest/meta'  # host_not_allowed
INGEST_URL_ALLOWED_HOSTS=dvb.no thibi ingest --url "$YOUTUBE"   # host_not_allowed
thibi doctor           # prints yt-dlp version + age, ffprobe version, full-ICU status

# no orphaned multipart parts after an aborted upload
mc ls --incomplete local/thibi/media/    # empty
```

## Risks and open questions

1. **Dedupe couples two jobs to one object.** Retention (phase 15) deleting audio for job A must
   not orphan job B. The rule — *delete the object only when no non-deleted job references the
   asset* — is written into the phase-15 plan and into a comment on `media_assets.storage_key` now.
   Getting this wrong destroys a newsroom's source recording.
2. **A duplicate browser upload wastes the whole transfer.** Accepted. The CLI never pays it, and
   `/api/uploads/probe` exists for clients that can hash first. The alternative — client-side
   sha256 over a 2 GB `File` — is minutes of main-thread work or a WASM dependency, for a rare case.
3. **yt-dlp is a moving target.** Sites change; extractors break; a pinned version rots. Pin it in
   the image, surface `yt-dlp --version` and its age in `thibi doctor` and `/admin/system`, and
   document the upgrade as an image rebuild. Do not auto-update at runtime — that would be a
   self-modifying container.
4. **SSRF protection is partial.** yt-dlp performs its own DNS and follows its own redirects, so a
   pre-flight IP check narrows the surface without closing it. The real containment is network
   policy: the worker should not need access to the host's metadata endpoint or the internal
   network. Recommend (phase 15) a dedicated egress-only network for `worker`, and say plainly in
   the docs that the allowlist is the primary control.
5. **`--match-filter "duration<?14400"` passes when duration is missing.** Handled by an explicit
   null-duration rejection in `resolveUrl`, and tested. Flagged here because the flag *looks* like
   a hard cap and is not.
6. **Legal exposure is the operator's.** One README paragraph, plus `INGEST_URL_ENABLED=false` so a
   newsroom whose counsel says no can turn the feature off entirely rather than trusting policy.
7. **Long-lived upload connections.** A 2 GB upload holds a Node connection for its duration.
   Caddy needs a raised (or disabled) `request_body max_size` and an increased write timeout on
   `/api/uploads`; batch concurrency defaults to 3. Both belong in phase 15's Caddyfile and are
   noted there.
8. **`filesize_approx` can lie.** `--max-filesize` uses the reported size and may not catch a
   stream whose real size is larger. `HashingPassThrough`'s hard byte cap is the backstop, which is
   why the cap exists in two places.
9. **Open question: should batch upload go direct-to-MinIO via presigned POST?** It would take the
   bytes off the Node process entirely. It is rejected for phase 8 because the sha256 passthrough
   is the dedupe mechanism and moving it means either hashing in the browser or re-reading every
   object server-side. Revisit only if upload throughput becomes a measured problem.

## Definition of done

- [ ] `grep -rn "arrayBuffer()\|formData()" apps/web/src/app/api/uploads` returns nothing, asserted
      in CI.
- [ ] A 2 GB upload completes with flat RSS on a container limited to 512 MB; the memory test is
      in CI.
- [ ] `media_assets.sha256` is `UNIQUE`; uploading the same file twice yields one asset and two
      jobs, and the second response is `200 {deduped:true}`.
- [ ] Two concurrent identical uploads produce exactly one asset row and no error.
- [ ] `مصاحبه با استاد.m4a`, `ការសម្ភាសន៍.m4a` and `မင်္ဂလာပါ.wav` round-trip byte-identical through
      the DB and the download `Content-Disposition`; every storage key matches
      `^media/<uuid>/source\.[a-z0-9]+$`.
- [ ] The `[^\w.\-က-႟]+` regex does not appear anywhere in the repo.
- [ ] A file with no audio stream is rejected at ingest with a message naming the file, and leaves
      no object in the bucket. A file with no *container duration* is accepted.
- [ ] `ffprobe` missing produces a 500 that says it is a server configuration problem, not a 400
      blaming the file.
- [ ] `thibi ingest ./dir` prints a per-file table with durations and cost, one total, one prompt;
      `--dry-run` creates nothing; a retried `batchKey` creates no duplicates.
- [ ] `thibi ingest --url` resolves metadata first, prints the real title and duration and the real
      cost, and creates no run. Confirmed by `primary_run_id IS NULL` after a successful import.
- [ ] All of `HARDENING` is asserted present in argv by a test, for both resolve and download.
- [ ] Scheme, allowlist, private-IP, live-stream and null-duration rejections all happen **before**
      yt-dlp is spawned or before any byte is written, each with a test.
- [ ] At most 2 concurrent downloads, enforced and tested.
- [ ] `source_meta` matches the documented shape and appears in the job header and the JSON export.
- [ ] The README yt-dlp paragraph is present and `INGEST_URL_ENABLED=false` disables the routes and
      the CLI flag.
- [ ] `ingest.url.resolve` and `ingest.url.download` exist in the `run_steps.kind` enum, and both
      functions already accept `StepEnv` — phase 9 adds a caller and changes no signature.

