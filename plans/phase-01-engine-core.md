# Phase 1 — Engine core, Google sync, CLI

## Goal

At the end of this phase, `thibi transcribe interview.m4a --lang my` runs the whole vertical
slice — probe → normalize → plan → chunk → recognize → seam-merge → normalize-text → persist —
against a real Postgres and a real MinIO, and prints JSON containing segments **and words with
timings and confidence**. Every line of it is engine code invoked through an `EngineContext`;
`apps/cli/src/context.ts` is the only file in the repository that reads `process.env`. It sits
here because it is the narrowest path that touches every seam the rest of the build hangs off:
Phase 2 adds a mode to the provider, Phase 3 adds a stage that consumes the same normalized
derivative, Phase 4 adds providers behind the same interface, Phase 6 adds layers to
`segment_texts`, Phase 9 replaces the in-process runner with `run_steps`, and Phase 11 puts a UI
on the same JSON. Getting the ports right here is worth more than any feature in it.

## Prerequisites

- Phase 0 complete: monorepo builds, `@thibi/languages` resolves, lint bans `process.env` in engine packages.
- **S2 answered.** `capabilities().wordConfidence` must state a measured fact, not a hope.
- S1 and S3 are *not* prerequisites. S1 only populates `capabilities().adaptation`, consumed in Phase 6; S3 only gates Phase 2.
- `infra/compose.dev.yml` with `postgres:17` and `minio` (the full stack is Phase 15).
- ffmpeg/ffprobe ≥6 with `loudnorm` and FLAC.
- A Google service account, and three fixture files: a 20 s clip, a ~90 s clip that will chunk into two, and a clip whose known word straddles a chunk boundary.

## Deliverables

| Path | Purpose |
|---|---|
| `packages/core/src/types.ts` | wire-neutral `Word`, `Segment`, `RunMode`, `WordTimingQuality` — shared by engine, exporters and the editor |
| `packages/core/src/timecode.ts` | `formatClock`, `parseClock`, ms arithmetic |
| `packages/core/src/timing/interpolate.ts` | `interpolateWords()` — the no-words fallback, pure and shared |
| `packages/core/src/layers/resolve.ts` | `resolveLayer(seg, texts, want, fallback)` |
| `packages/db/drizzle.config.ts` | drizzle-kit config |
| `packages/db/src/schema/{media,jobs,runs,segments,words,segmentTexts,settings}.ts` | Drizzle schema |
| `packages/db/migrations/0000_init.sql` | committed, generated, never edited after push |
| `packages/db/src/client.ts` | `createDb(url)`, pool config, `withTransaction` |
| `packages/db/src/copy.ts` | `copyWords()` — `COPY … FROM STDIN` bulk insert |
| `packages/db/src/testing.ts` | `withTestDb()` template-database helper |
| `packages/storage/src/types.ts` | the `ObjectStore` port + `TempFile` |
| `packages/storage/src/{s3,fs,memory}.ts` | three adapters |
| `packages/storage/src/tempfile.ts` | `toTempFile` / `fromTempFile` disposable handles |
| `packages/storage/src/keys.ts` | the key-naming convention, in one place |
| `packages/engine/src/context.ts` | `EngineContext` and its ports; `assertContext` |
| `packages/engine/src/errors.ts` | error taxonomy + `isRetryable` |
| `packages/engine/src/retry.ts` | full-jitter retry, `Retry-After` aware |
| `packages/engine/src/audio/{ffmpeg,probe,normalize,silences,plan,cut}.ts` | audio stages |
| `packages/engine/src/audio/merge/{tokenize,lcs,seam}.ts` | overlap de-duplication |
| `packages/engine/src/providers/types.ts` | `TranscriptionProvider` and friends |
| `packages/engine/src/providers/registry.ts` | id → provider instance, built per context |
| `packages/engine/src/providers/google/{index,auth,recognize,parse,errors,capabilities}.ts` | the Google sync provider |
| `packages/engine/src/pipeline/{run,plan,asr,persist,normalizeText}.ts` | stage functions |
| `packages/engine/src/text/normalizers/{nfc,whitespace,zeroWidth,digits,zawgyi}.ts` | the normalizer chain |
| `packages/engine/src/settings.ts` | `SettingsPort` over the `settings` table, with env precedence supplied by the caller |
| `apps/cli/src/context.ts` | **the only `process.env` reader**; builds `EngineContext` |
| `apps/cli/src/commands/transcribe.ts` | `thibi transcribe` |
| `apps/cli/src/commands/db.ts` | `thibi db migrate \| status \| reset` |
| `apps/cli/src/output.ts` | the frozen JSON output shape + `--format text` |
| `infra/compose.dev.yml` | postgres + minio only |

## Design

### 1.1 `EngineContext`

```ts
export interface EngineContext {
  db: Db;                          // Drizzle instance from @thibi/db
  store: ObjectStore;              // @thibi/storage
  staging?: StagingStore;          // Phase 2 (GCS). Absent here.
  settings: SettingsPort;
  llm?: LlmGateway;                // Phase 6
  sidecar?: SidecarClient;         // Phase 3/4
  ffmpeg: FfmpegPort;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  languages: LanguageRegistry;     // from @thibi/languages, built with DB overrides
  concurrency: ConcurrencyLimits;
  tmp: TempDirPort;
  signal?: AbortSignal;
  engineVersion: string;
}

export interface Clock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(o: object, msg?: string): void; info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;  error(o: object, msg?: string): void;
}

/** CLI: pretty-prints to stderr. Worker (Phase 9): INSERT run_events + pg_notify in one tx. */
export interface EventSink { emit(e: RunEvent): void | Promise<void>; }

export interface FfmpegPort {
  /** Buffered. Rejects with FfmpegError carrying stderr on non-zero exit. */
  run(bin: 'ffmpeg' | 'ffprobe', args: string[],
      opts?: { maxBuffer?: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }>;
  /** Streaming stdout — needed because normalize produces FLAC and raw PCM in one pass. */
  spawn(bin: 'ffmpeg', args: string[],
        opts?: { signal?: AbortSignal }): { stdout: Readable; stderr: Readable; done: Promise<void> };
}

export interface SettingsPort {
  get(key: string): Promise<string | null>;
  getJson<T>(key: string): Promise<T | null>;
  set(key: string, value: string): Promise<void>;
}

export interface ConcurrencyLimits { asrChunks: number; ffmpeg: number; }

export interface TempDirPort { dir(prefix: string): Promise<{ path: string } & AsyncDisposable>; }
```

**Every stage is `(ctx, input) => Promise<output>`.** No stage constructs a client, opens a file by
convention, or consults the environment.

| Surface | `db` | `store` | `ffmpeg` | `clock` | `events` | `languages` |
|---|---|---|---|---|---|---|
| CLI (`apps/cli/src/context.ts`) | pg pool from `DATABASE_URL`; `NullDb` under `--no-db` | S3 from `S3_*`, `fs` when `STORAGE_DRIVER=fs`, memory under `--no-db` | `execFile`/`spawn`, binary from `FFMPEG_PATH ?? 'ffmpeg'` | system | stderr progress printer | `createRegistry(rows from language_support)` |
| Worker (Phase 9) | same pool | same | same | system | `run_events` insert + `pg_notify`, coalesced to ≤1/run/500 ms | same, refreshed on NOTIFY |
| Tests | `withTestDb()` — a database cloned from a migrated template per test file | `MemoryObjectStore` | `FakeFfmpeg` replaying recorded stdout/stderr; real ffmpeg behind `TEST_FFMPEG=1` | `FakeClock` (sleep resolves immediately, `now()` is monotonic and settable) | array collector | registry from a fixture array |

**The rule and its enforcement.** The lint rule from Phase 0 bans `process.env`, `process.cwd()`
and `__dirname` in `packages/{core,languages,db,storage,engine,eval}/src`, with
`--report-unused-disable-directives` and a CI grep so a disable comment cannot reintroduce it.

The concrete consequence, and the reason it is worth a rule rather than a convention:
`google/auth.ts` **cannot** contain `resolveServiceAccountJson()` (`lib/providers/google.ts:51-66`).
Reading `GOOGLE_APPLICATION_CREDENTIALS` and turning a path into a JSON string is a CLI concern.
The engine receives the string from `ctx.settings`. That single move is what makes the provider
testable without a filesystem, runnable in a worker with settings from Postgres, and configurable
from a browser in Phase 10 — which the overview names as a hard requirement ("any flow that forces
an admin back into `.env` is a design failure").

```ts
/** Typed guard for optional ports, used by Phase 2/3 stages. Defined here so they don't invent it. */
export function assertContext<K extends keyof EngineContext>(
  ctx: EngineContext, keys: K[],
): asserts ctx is EngineContext & Required<Pick<EngineContext, K>> {
  for (const k of keys) if (ctx[k] == null) throw new MissingCapabilityError(String(k));
}
```

### 1.2 `packages/db`

Drizzle over `node-postgres`. `drizzle.config.ts` sets `dialect: 'postgresql'`,
`schema: './src/schema/*.ts'`, `out: './migrations'`.

```
pnpm --filter @thibi/db gen        # drizzle-kit generate → migrations/NNNN_*.sql   (committed)
pnpm --filter @thibi/db migrate    # our own runner, applies pending files in order
```

Rules, stated once and enforced by review:

- `drizzle-kit push` is **banned** and does not appear in any script. It is the fastest way to make
  production and the migration history disagree.
- Migrations are forward-only and never edited after being pushed. Rollback is restore-from-backup.
  Destructive changes use expand/contract across two releases.
- The runner is ours (≈60 lines: advisory lock, `schema_migrations` table, apply in a transaction
  each) so Phase 15 can run it as the compose one-shot that everything `depends_on:
  service_completed_successfully`.
- **Column enums are `text` with a TS union**, not `pgEnum`. `text('layer', { enum: [...] })` gives
  the same TypeScript narrowing with a column that can gain a value in a plain migration;
  `ALTER TYPE … ADD VALUE` cannot be reverted and cannot run inside some transaction contexts.
  DB-level `CHECK` constraints go on the ones where a bad value would corrupt data (`layer`,
  `origin`), not on the ones that are just labels (`kind`, `state`).

Tables in this phase. Those the overview specifies fully are summarised; the three it compresses
are given in full.

| Table | This phase writes | Notes |
|---|---|---|
| `media_assets` | yes | `sha256` UNIQUE for content dedupe, computed during the upload stream; `probe_raw jsonb` |
| `media_derivatives` | yes | UNIQUE `(asset_id, kind, recipe_version)`; the cache key that makes normalize run once per file forever |
| `jobs` | yes | `language_code` lives here — the replacement for the hardcoded `"my-MM"` at `lib/queue.ts:118` |
| `runs` | yes | `mode`, `state`, `word_timing_quality`, `pipeline jsonb`, `engine_version`, `cost_usd`. `operation_name`/`staging_prefix` exist in the migration but stay NULL until Phase 2 |
| `run_chunks` | yes | **written before any network call**, including `overlap_lead_ms` |
| `segments`, `words`, `segment_texts` | yes | below |
| `settings` | read/write | plaintext `value jsonb` only. `secret_ct`/`nonce`/`tag`/`is_secret`/`hint` columns **exist from migration 0000** so Phase 10 is a code change, not a migration |
| `run_steps` | **not yet** | the in-process runner in this phase executes stages directly; Phase 9 introduces the state machine |

```ts
// packages/db/src/schema/segments.ts
import { pgTable, uuid, integer, text, doublePrecision, boolean, timestamp,
         index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { runs } from './runs.js';
import { runChunks } from './runs.js';

export const segments = pgTable('segments', {
  id:    uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  idx:   integer('idx').notNull(),

  /** Integer milliseconds everywhere in the engine. Float seconds is where frame-off errors live. */
  startMs: integer('start_ms').notNull(),
  endMs:   integer('end_ms').notNull(),

  /** Normalized verbatim ASR output. IMMUTABLE — human edits land in segment_texts. */
  text: text('text').notNull(),
  /** Exactly what the provider returned, pre-normalizer. The audit trail the old app
   *  destroyed by normalizing in place at lib/queue.ts:126. */
  textRaw: text('text_raw').notNull(),

  /** Provider segment confidence. NULL when the provider has none — never 0 as a stand-in. */
  confidence: doublePrecision('confidence'),
  chunkId:    uuid('chunk_id').references(() => runChunks.id, { onDelete: 'set null' }),
  /** false ⇒ every consumer must use the interpolation fallback and say so. */
  hasWords:   boolean('has_words').notNull().default(false),

  speakerId:          uuid('speaker_id'),            // FK added in Phase 3
  speakerPurity:      doublePrecision('speaker_purity'),
  needsSpeakerReview: boolean('needs_speaker_review').notNull().default(false),

  /** Human-split lineage. A human — never an LLM, never a pipeline stage — may split
   *  a segment at an existing word boundary. */
  splitOf:      uuid('split_of'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  supersededBy: uuid('superseded_by'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  /** Partial unique: superseded rows are history, so they must not collide with live ones. */
  uniqueIndex('segments_run_idx_live').on(t.runId, t.idx).where(sql`${t.supersededAt} is null`),
  index('segments_run_start').on(t.runId, t.startMs),
  check('segments_interval', sql`${t.startMs} <= ${t.endMs}`),
]);
```

```ts
// packages/db/src/schema/words.ts
export const words = pgTable('words', {
  /** bigserial, not uuid: ~10k words per audio-hour means 10M rows at 1,000 hours.
   *  A random uuid PK doubles the index and destroys insert locality for COPY. */
  id:        bigserial('id', { mode: 'bigint' }).primaryKey(),
  segmentId: uuid('segment_id').notNull().references(() => segments.id, { onDelete: 'cascade' }),
  runId:     uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  /** Position within the segment. */
  idx:     integer('idx').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs:   integer('end_ms').notNull(),
  text:    text('text').notNull(),
  /** NULL means "this provider does not measure word confidence" (S2). It must never be
   *  written as 0, or every Google word sorts as maximally uncertain. */
  confidence:  doublePrecision('confidence'),
  speakerId:   uuid('speaker_id'),
  /** True only when a provider gave coarse timings we refined (Phase 4). Phase 1 never
   *  writes estimated words — see §1.6. */
  isEstimated: boolean('is_estimated').notNull().default(false),
}, (t) => [
  uniqueIndex('words_segment_idx').on(t.segmentId, t.idx),
  index('words_run_start').on(t.runId, t.startMs),
  /** Risk-based QA: "38 uncertain words" must not be a sequential scan of 10M rows. */
  index('words_low_conf').on(t.runId, t.startMs).where(sql`${t.confidence} < 0.5`),
]);
```

```ts
// packages/db/src/schema/segmentTexts.ts
export const segmentTexts = pgTable('segment_texts', {
  id:        uuid('id').primaryKey().defaultRandom(),
  segmentId: uuid('segment_id').notNull().references(() => segments.id, { onDelete: 'cascade' }),
  runId:     uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),

  layer: text('layer', { enum: ['verbatim', 'cleaned', 'translated', 'entity_corrected'] }).notNull(),

  /** '' for everything except translations. NOT NULL with a '' default is load-bearing:
   *  a partial unique index over a NULLable column enforces nothing, because NULL <> NULL. */
  targetLang: text('target_lang').notNull().default(''),

  origin: text('origin', { enum: ['asr', 'llm', 'human', 'rule'] }).notNull(),
  text:   text('text').notNull(),

  passId:   uuid('pass_id'),    // → editorial_passes, Phase 6. Provenance is free.
  authorId: uuid('author_id'),  // → users, Phase 10
  meta:     jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),

  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  supersededBy: uuid('superseded_by'),
}, (t) => [
  uniqueIndex('segment_texts_live')
    .on(t.segmentId, t.layer, t.targetLang).where(sql`${t.supersededAt} is null`),
  index('segment_texts_run_layer')
    .on(t.runId, t.layer, t.targetLang).where(sql`${t.supersededAt} is null`),
  check('segment_texts_lang', sql`(${t.layer} = 'translated') = (${t.targetLang} <> '')`),
]);
```

Two decisions embedded above that the overview's DDL leaves implicit:

- **`target_lang` is `''`, not NULL.** Stated again because it is the difference between the
  uniqueness constraint working and silently not working, and it will not show up in any test that
  only inserts translations.
- **Phase 1 writes one `segment_texts` row per segment**: `(verbatim, '', origin='asr')`,
  duplicating `segments.text`. It is redundant on purpose. `resolveLayer` then has one uniform
  path, and a human edit *supersedes an existing row* rather than inventing the first one — which
  is what the overview's "supersedes the previous row" wording requires. The cost is one extra copy
  of the transcript, ~1 MB per audio-hour. The alternative (treat `segments.text` as an implicit
  verbatim row) was considered and rejected because it puts a special case in the hottest read path
  in the editor.

**`copyWords()`** — words go in with `COPY … FROM STDIN (FORMAT text)` via `pg-copy-streams`,
omitting the `id` column so the sequence assigns it. A 3-hour file is ~30k word rows per run;
individual inserts are ~40× slower and hold the transaction open long enough to matter.

**Test database.** `withTestDb()` creates one migrated template per test *run*
(`thibi_test_template`), then `CREATE DATABASE thibi_test_<n> TEMPLATE thibi_test_template` per
test file. Isolation without paying the migration cost 30 times. Fallback if the CI role cannot
create databases: one schema per file with `search_path`.

### 1.3 `packages/storage`

```ts
export interface ObjectStore {
  put(key: string, body: Buffer, opts?: PutOpts): Promise<PutResult>;
  /** Multipart upload with a sha256 passthrough. Never Buffer.from(await file.arrayBuffer())
   *  on a 2 GB file the way app/api/jobs/route.ts:47 does. */
  putStream(key: string, body: Readable, opts?: PutOpts): Promise<PutResult>;
  get(key: string, range?: { start: number; end?: number }): Promise<Readable>;
  head(key: string): Promise<{ bytes: number; contentType?: string; etag: string } | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string): AsyncIterable<{ key: string; bytes: number }>;
  /** fs and memory adapters throw NotSupportedError — presigning is an S3 concept. */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
}
export interface PutResult { key: string; bytes: number; sha256: string; }
export interface TempFile extends AsyncDisposable { readonly path: string; readonly bytes: number; }
```

Three adapters, one contract test suite run against all three via `describe.each`:

| Adapter | For | Notes |
|---|---|---|
| `S3ObjectStore` | MinIO in production | `@aws-sdk/client-s3` + `lib-storage`. Phase 1 needs only the internal client at `http://minio:9000`. The **second** client (`s3Public`, used only for signing so SigV4 signs the public `Host`) arrives in Phase 10 with the presigned-audio route — the seam is `presignGet` taking an injected signer |
| `FsObjectStore` | `STORAGE_DRIVER=fs`, the overview's Risk-4 cut list | Keys map to paths under a root; `toTempFile` hardlinks instead of copying when on the same device |
| `MemoryObjectStore` | tests | Backed by a `Map<string, Buffer>`; `get` returns a fresh `Readable` each call |

**Keys are fixed now, because they are forever:**

```
assets/{sha[0:2]}/{sha}/source{ext}          content-addressed ⇒ dedupe is free
derivatives/{assetId}/{kind}/{recipeVersion}{ext}
runs/{runId}/chunks/{idx:03}.flac            scratch, deletable by prefix
runs/{runId}/raw/{idx:03}.json               archived provider responses
```

**`toTempFile` — the disposable-handle pattern.** ffmpeg needs a path, object stores hand out
streams, and the old app's answer (`data/chunks/<runId>`, removed in a `finally`) leaks on every
`SIGKILL`.

```ts
export async function toTempFile(
  store: ObjectStore, tmp: TempDirPort, key: string, ext = '.bin',
): Promise<TempFile> {
  const dir = await tmp.dir('thibi-');
  const path = join(dir.path, `${randomUUID()}${ext}`);
  await pipeline(await store.get(key), createWriteStream(path));
  const { size } = await stat(path);
  return {
    path, bytes: size,
    async [Symbol.asyncDispose]() { await rm(dir.path, { recursive: true, force: true }); },
  };
}
```

```ts
// callers never write cleanup code, and an exception cannot skip it
await using input  = await toTempFile(ctx.store, ctx.tmp, asset.storageKey, extOf(asset.filename));
await using outDir = await ctx.tmp.dir('norm-');
await ctx.ffmpeg.run('ffmpeg', NORMALIZE_ARGS(input.path, join(outDir.path, 'out.flac')));
```

Requires `lib: ["ESNext.Disposable"]` (set in Phase 0's `tsconfig.base.json`) and Node 22. Verify on
day one — `Symbol.asyncDispose` being undefined at runtime is a confusing failure.

A `maintenance.tmp-sweep` job (Phase 9) removes orphaned `thibi-*` directories older than a day, for
the case the process dies between `dir()` and the disposal.

### 1.4 Audio stages

#### probe

Ported from `lib/audio/probe.ts:16-38`, keeping the graceful-nulls-not-throws behaviour and its
comment. Widened, and given one new guard.

```ts
export interface ProbeResult {
  durationMs: number | null;   // null is a legitimate answer, not an error
  formatName: string | null;
  bitRate: number | null;
  hasAudio: boolean;
  streams: Array<{ codecName: string; codecType: string; channels?: number; sampleRate?: number }>;
  raw: unknown;                // stored whole in media_assets.probe_raw
}
export async function probe(ctx: EngineContext, input: { path: string }): Promise<ProbeResult>;
```

`-show_entries format=duration,format_name,bit_rate,size:stream=codec_name,codec_type,channels,sample_rate -of json`.

Two changes of substance:

- `durationMs === null` no longer falls back to the browser's `<audio>` duration (there is no
  browser here). It routes conservatively to `sync_chunked` and logs a warning; the plan stage
  refuses to choose `sync` without a duration.
- `hasAudio === false` throws `UnsupportedMediaError`. The old path would happily hand a PDF to
  ffmpeg and surface a raw ffmpeg stderr dump to the user.

#### normalize — loudnorm, decoupled, cached

```ts
export const NORMALIZE = {
  kind: 'norm_16k_mono_flac',
  filter: 'aformat=channel_layouts=mono,aresample=16000,loudnorm=I=-16:TP=-1.5:LRA=11',
  codecArgs: ['-c:a', 'flac', '-compression_level', '8'],
} as const;

/** recipe_version = kind@sha256(filter + codecArgs).slice(0,8).
 *  Deriving it from the arguments means changing loudnorm parameters invalidates every
 *  cached derivative automatically. Nobody has to remember to bump a number. */
export const RECIPE_VERSION = `${NORMALIZE.kind}@${sha256(NORMALIZE.filter + NORMALIZE.codecArgs.join(' ')).slice(0, 8)}`;
```

One ffmpeg invocation produces both outputs, because the decode and the filter are the expensive
part and running them twice for waveform peaks is waste:

```
ffmpeg -y -v error -i IN
  -filter_complex "[0:a]aformat=channel_layouts=mono,aresample=16000,
                   loudnorm=I=-16:TP=-1.5:LRA=11,asplit=2[a][b]"
  -map "[a]" -c:a flac -compression_level 8 OUT.flac
  -map "[b]" -f s16le -ac 1 -ar 16000 pipe:1
```

The PCM on stdout is reduced in Node to 20 buckets/second of `min,max` as `Int8Array` — ~144 KB per
audio-hour, stored as `media_derivatives kind='waveform_peaks'`. This is the reason `FfmpegPort`
needs `spawn()` and not just `run()`.

**Single-pass loudnorm, not two-pass.** Two-pass (measure, then apply) is more accurate and doubles
decode time. ASR wants a consistent input level, not broadcast compliance. A `normalize.twoPass`
setting exists as the escape hatch and defaults off; state the reasoning in its help text.

Caching, concurrency-safe:

```ts
async function ensureNormalized(ctx: EngineContext, assetId: string): Promise<Derivative> {
  const hit = await selectDerivative(ctx.db, assetId, NORMALIZE.kind, RECIPE_VERSION);
  if (hit) { ctx.logger.info({ recipe: RECIPE_VERSION }, 'normalize: cached'); return hit; }

  await using src = await toTempFile(ctx.store, ctx.tmp, asset.storageKey, extOf(asset.filename));
  await using work = await ctx.tmp.dir('norm-');
  const { flacPath, peaks } = await runNormalize(ctx, src.path, work.path);
  const put = await ctx.store.putStream(derivativeKey(assetId, NORMALIZE.kind, RECIPE_VERSION),
                                        createReadStream(flacPath));

  const inserted = await insertDerivativeOnConflictDoNothing(ctx.db, { ... });
  if (!inserted) {
    // Another run normalized the same asset concurrently and won. Delete our object
    // and use theirs — otherwise the loser's blob is orphaned forever.
    await ctx.store.delete(put.key);
    return (await selectDerivative(ctx.db, assetId, NORMALIZE.kind, RECIPE_VERSION))!;
  }
  return inserted;
}
```

Decoupling normalize from chunking (the old code did both inside `prepareChunks`,
`lib/audio/chunk.ts:108-153`) is what lets Phase 3's diarization and Phase 4's local ASR consume
the *same bytes* on the *same timeline* — which is the precondition for reconciliation working at
all.

#### chunk — plan, then cut

`detectSilences` (`chunk.ts:40-59`) and `planBoundaries` (`chunk.ts:85-102`) port nearly verbatim,
seconds→milliseconds. **The comments travel with them**: the "silencedetect reports on stderr and
the null muxer produces no output file" note, the back-half-of-window rationale, the bitrate-derived
byte budget at `:134-136`, and above all the re-encode-not-`-c copy` comment at `:61-67`, which
documents a real Google rejection and would otherwise be "optimised" away by the next reader.

Four changes:

1. **Integer milliseconds throughout.** Float seconds accumulate rounding across 65 chunks.
2. **Overlap.** Each chunk after the first is *extracted* starting `overlapLeadMs` (default 1200)
   before its planned boundary.
3. **The byte/duration budget must be computed against the extracted length, not the planned
   length.** 55 s planned + 1.2 s lead = 56.2 s extracted, which exceeds the sync cap the plan was
   built to respect. This is a real bug waiting to be written; the correction is one line and a
   named test.
4. `run_chunks` rows are inserted **before** any cutting or any network call.

```ts
export interface ChunkPlan {
  idx: number;
  /** Where the extracted audio starts = contentStartMs - overlapLeadMs. */
  offsetMs: number;
  /** The planned boundary — the seam this chunk owns from. */
  contentStartMs: number;
  endMs: number;
  overlapLeadMs: number;
}

export function planChunks(
  durationMs: number,
  silencesMs: number[],
  opts: { maxMs: number; overlapLeadMs: number; minMs: number },
): ChunkPlan[] {
  // Reserve the lead so no extracted chunk exceeds opts.maxMs.
  const planMax = opts.maxMs - opts.overlapLeadMs;
  const boundaries = planBoundaries(durationMs, silencesMs, planMax);   // ported verbatim
  return boundaries.slice(0, -1).map((start, i) => {
    const lead = i === 0 ? 0 : Math.min(opts.overlapLeadMs, start);
    return { idx: i, offsetMs: start - lead, contentStartMs: start,
             endMs: boundaries[i + 1]!, overlapLeadMs: lead };
  }).filter(c => c.endMs - c.contentStartMs >= opts.minMs);
}
```

#### The seam merge — overlap + LCS de-duplication

The most intricate new algorithm in this phase. Chunk *k+1* begins 1200 ms before chunk *k* ends,
so its transcript repeats the tail of chunk *k*. Concatenating duplicates words; hard-cutting at
the boundary loses a word straddling it, which is the whole reason the overlap exists.

Geometry: chunk *k* covers `[a_k, b_k]`; chunk *k+1* is extracted from `b_k − lead`. The overlap
region is `[b_k − lead, b_k]` and `seamMs := b_k`.

```ts
export interface SeamInput {
  prevWords: Word[];          // absolute ms, chunk k
  nextWords: Word[];          // absolute ms, chunk k+1
  seamMs: number;
  leadMs: number;
  lang: ResolvedLanguage;
  minScore?: number;          // default 0.5
  slackMs?: number;           // default 300 — provider timing drift
}
export interface SeamResult {
  keepPrevThrough: number;    // index into prevWords, inclusive; -1 = drop the whole tail
  dropNextThrough: number;    // index into nextWords, inclusive; -1 = drop nothing
  method: 'lcs' | 'hard-cut' | 'no-words' | 'empty';
  score: number;              // 0..1
  flagged: boolean;
}

export function mergeSeam(input: SeamInput): SeamResult {
  const { prevWords, nextWords, seamMs, leadMs, lang } = input;
  const slack = input.slackMs ?? 300, minScore = input.minScore ?? 0.5;

  // 1. Window. Bounded so the DP is trivially cheap: ≤60 words per side.
  const lo = seamMs - leadMs - slack, hi = seamMs + slack;
  const pStart = lowerBound(prevWords, w => w.startMs >= lo);
  const pTail  = prevWords.slice(Math.max(pStart, prevWords.length - 60));
  const nHead  = nextWords.filter(w => w.endMs <= hi).slice(0, 60);

  // Nothing was spoken in the overlap. Score 1 by convention — NOT NaN, and not a low-score
  // fallback, which would flag every pause in the recording.
  if (pTail.length === 0 || nHead.length === 0)
    return { keepPrevThrough: prevWords.length - 1, dropNextThrough: -1,
             method: 'empty', score: 1, flagged: false };

  // 2. Tokenize. Unspaced scripts get graphemes, because provider "words" there are
  //    unreliable syllable fragments and codepoint LCS would match stray vowel signs.
  const tok = lang.text.wordSegmentation === 'none'
    ? graphemeTokens(pTail, nHead, lang)     // { a, b, aOwner[], bOwner[] } → word indices
    : wordTokens(pTail, nHead, lang);        // NFC + locale lowercase + strip punctuation

  // 3. LCS with backpointers over a Uint16Array matrix. ≤ 400×400 worst case.
  const pairs = lcsPairs(tok.a, tok.b);

  // 4. Dice similarity on the aligned windows.
  const score = (2 * pairs.length) / (tok.a.length + tok.b.length);

  // 5. Optional confidence tie-break in the grey zone.
  const greyZone = score >= minScore && score < 0.7;

  if (score < minScore) {
    // 6. Hard-cut at the midpoint of the overlap and flag the seam. A duplicated sentence
    //    reads as the speaker repeating themselves, which is worse than a missing one.
    const mid = seamMs - leadMs / 2;
    return {
      keepPrevThrough: lastIndexWhere(prevWords, w => w.endMs <= mid),
      dropNextThrough: lastIndexWhere(nextWords, w => w.startMs <= mid),
      method: 'hard-cut', score, flagged: true,
    };
  }

  // Split at the aligned pair nearest the planned boundary. Both transcriptions are least
  // reliable at the far edges of the overlap — prev's truncated tail, next's context-free
  // head — and most reliable in the middle, which is also where the silence-snapped
  // boundary already sits.
  const best = pairs.reduce((acc, p) =>
    Math.abs(midMsOf(tok, p) - seamMs) < Math.abs(midMsOf(tok, acc) - seamMs) ? p : acc, pairs[0]!);

  return {
    keepPrevThrough: (prevWords.length - pTail.length) + tok.aOwner[best.i]!,
    dropNextThrough: tok.bOwner[best.j]!,
    method: 'lcs', score, flagged: greyZone,
  };
}
```

Then the result is applied to **words first, segments rebuilt**, which is where the implementation
actually gets fiddly:

```ts
function applySeam(prev: ChunkOutput, next: ChunkOutput, r: SeamResult, lang: ResolvedLanguage) {
  // Drop words, then for each affected segment:
  //   - all words survived        → unchanged
  //   - some words dropped        → startMs := first surviving word's startMs,
  //                                 text    := joinWords(surviving, lang.text.wordJoin),
  //                                 textRaw := the provider's original (never re-derived)
  //   - all words dropped         → drop the segment; renumber idx
  // A provider that returned no words is handled at segment granularity by the 'no-words' branch.
}
```

`textRaw` is *never* re-derived — it is the provider's bytes, including the duplicate. The audit
trail records what was said to us; `text` records what we concluded.

**The no-words branch.** When either side has `wordTimingQuality === 'none'`, word alignment is
impossible. Fall back to character-level LCS between the last 400 characters of prev's concatenated
text and the first 400 of next's. If that also scores below `minScore`, drop whole `next` segments
whose midpoint precedes the overlap midpoint, and flag. Never silently concatenate.

**Cost.** ≤60 words or ≤400 graphemes per side ⇒ ≤160k DP cells per seam, and ~65 seams in an hour
of audio. Microseconds. There is no reason to optimise this and every reason to keep it readable.

**Escape hatch.** `--overlap-ms 0` disables extraction and merging entirely, restoring the old
behaviour exactly. Keep it working; it is the first thing to try when a transcript looks wrong.

Seam outcomes are recorded in `runs.pipeline.seams[]` and surfaced in the CLI JSON, so a flagged
seam is visible without a database query — and Phase 12 has something to render.

### 1.5 The Google sync provider

```ts
export interface TranscriptionProvider {
  readonly id: ProviderId;
  readonly label: string;
  capabilities(model?: string): ProviderCapabilities;
  supportsLanguage(code: string, model?: string): ProviderLanguageCapability | null;
  resolveModel(code: string, opts: { requireWordTimestamps?: boolean }): string | null;
  isConfigured(cfg: ProviderConfig): boolean;
  costModel(mode: RunMode): CostModel;
  transcribe(cfg: ProviderConfig, req: TranscribeRequest): Promise<TranscribeResult>;
  // Phase 2:
  submitBatch?(cfg: ProviderConfig, req: BatchRequest): Promise<ExternalOp>;
  pollBatch?(cfg: ProviderConfig, op: ExternalOp): Promise<BatchStatus>;
  fetchBatchResult?(cfg: ProviderConfig, op: ExternalOp, req: BatchRequest): Promise<TranscribeResult>;
  cancelBatch?(cfg: ProviderConfig, op: ExternalOp): Promise<void>;
}

export interface TranscribeRequest {
  audio: { path: string };
  /** Registry code. The provider maps it through the matrix's providerCode. */
  languageCode: string;
  offsetMs: number;
  durationMs: number;
  adaptation?: { phrases: Array<{ value: string; boost?: number }>; boost?: number };
  signal?: AbortSignal;
  logger: Logger;
}

export interface ProviderWord  { startMs: number; endMs: number; text: string;
                                 confidence: number | null; speakerTag?: string | null; isEstimated?: boolean }
export interface ProviderSegment { startMs: number; endMs: number; text: string;
                                   confidence: number | null; words: ProviderWord[] }
export interface TranscribeResult {
  segments: ProviderSegment[];
  wordTimingQuality: 'full' | 'partial' | 'none';
  usage: { audioMs: number; requests: number };
  raw: unknown;
}
```

`ProviderConfig` is a plain object the pipeline builds from `ctx.settings` and hands in. The
provider never reads settings, so exactly one file knows the setting key names and the provider is
testable with a literal.

**`google/auth.ts`** — the token cache from `google.ts:101-129`, off the module global:

```ts
export function createTokenCache(clock: Clock): TokenCache {
  const entries = new Map<string, { token: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<string>>();
  return {
    async get(saJson: string): Promise<string> {
      const key = sha256(saJson);                       // not the 2 KB blob, and never loggable
      const now = clock.now().getTime();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now + 60_000) return hit.token;
      // Coalesce: 8 parallel chunks on a cold cache would otherwise mint 8 JWTs.
      let p = inflight.get(key);
      if (!p) { p = mint(saJson).finally(() => inflight.delete(key)); inflight.set(key, p); }
      const token = await p;
      // getAccessToken() doesn't surface expiry; assume the standard 1h and renew early.
      entries.set(key, { token, expiresAt: now + 45 * 60_000 });
      return token;
    },
  };
}
```

Kept: the "paste the whole file, including the outer braces" error message — a real usability win.
Deleted: `resolveServiceAccountJson` (`:51-66`) and `projectIdFrom`'s env plumbing; the CLI does
that. `projectIdFrom(saJson)` itself survives as a pure helper in the CLI's config resolution.

**`google/recognize.ts`** — endpoint helper ported verbatim from `:89-94`. Request body:

```ts
const body = {
  config: {
    autoDecodingConfig: {},
    languageCodes: [cap.providerCode],           // 'my-MM' from the matrix, not a literal
    model,
    features: {
      enableWordTimeOffsets: true,
      enableWordConfidence: true,                // ← new; harmless if the model ignores it
      enableAutomaticPunctuation: true,
    },
    ...(req.adaptation ? { adaptation: { phraseSets: [{ inlinePhraseSet: {
      phrases: req.adaptation.phrases, boost: req.adaptation.boost } }] } } : {}),
  },
  content: (await readFile(req.audio.path)).toString('base64'),
};
```

Three changes from `:168-198` beyond the feature flag:

- `await readFile`, not `fs.readFileSync` (`:175`). A synchronous 10 MB read inside an async
  function with eight chunks in flight blocks the event loop for all of them.
- `AbortSignal.any([req.signal, AbortSignal.timeout(120_000)])` into `fetch`. The old code had no
  timeout at all; a hung socket stalled the entire promise chain.
- `adaptation` is sent only when `capabilities().adaptation === 'phrase-set'` **and** the caller
  passed phrases — gated on the S1 verdict, not on optimism. The Phase 6 glossary is what will
  populate it.

**`google/parse.ts`** — the change the overview singles out.

`parseOffset` ports verbatim (`:37-41`), converted to integer ms, plus a defensive branch for the
protobuf-JSON object form `{seconds, nanos}` — S3 must check whether batch output uses it, and
adding the branch now costs nothing.

**The word array is the output, not a source of bounds.** `google.ts:207-221` reads
`words[0].startOffset` and `words[last].endOffset` and then throws the array away. Here:

```ts
const words: ProviderWord[] = (alt.words ?? []).map((w, i) => ({
  startMs: req.offsetMs + (parseOffsetMs(w.startOffset) ?? 0),
  endMs:   req.offsetMs + (parseOffsetMs(w.endOffset) ?? 0),
  text:    w.word ?? '',
  confidence: typeof w.confidence === 'number' ? w.confidence : null,   // null, never 0
  speakerTag: w.speakerLabel ?? null,
}));
```

The three-tier timestamp fallback survives, but it is **recorded rather than silent**:

| Condition | Segment timing | `hasWords` | Contributes |
|---|---|---|---|
| words present with offsets | first word start → last word end | true | `full` |
| words absent, `resultEndOffset` present | previous segment end → `resultEndOffset` | false | `none` |
| neither | previous segment end → chunk end | false | `none`, segment flagged in `warnings` |

`wordTimingQuality` for the result: `full` if every non-empty segment has words, `none` if none
does, `partial` otherwise. `runs.word_timing_quality` is the minimum across chunks
(`none < partial < full`).

**`google/errors.ts`** — `toError` (`:132-152`) ports **with `:139-141` deleted**. The region hint
is a false statement; a test asserts no error message produced by this module matches
`/asia-southeast1|europe-west4|us-central1/`.

Classification:

| Status / shape | Error | Retryable | Operator-facing hint |
|---|---|---|---|
| 429, 503 | `RateLimitedError` | yes, honour `Retry-After` | — |
| 500, 502, 504 | `ProviderUnavailableError` | yes | — |
| 400 `INVALID_ARGUMENT` matching `/language\|model/i` | `UnsupportedLanguageError` | no | "the provider matrix may be stale — run `thibi probe languages --provider google`" |
| 400 matching `/too large\|exceeds/i`, or 413 | `ChunkTooLargeError` | no, but **re-plannable** | the planner re-cuts that one chunk at half length, once |
| 401, 403 | `NotConfiguredError` | no | "check the service account has roles/speech.client on this project" |
| anything else | `ProviderError` | no | Google's own message, first 500 chars |

`engine/src/retry.ts` generalises `withRetry`/`RETRYABLE` (`lib/queue.ts:52-69`) with **full
jitter** — `delay = random(0, min(cap, base · 2^attempt))` — base 2 s, cap 30 s, 5 attempts for
`asr.chunk`. Full jitter rather than the old fixed `[2000, 4000, 8000]` because eight chunks
failing on the same 429 currently retry in lockstep and re-trigger it. `Retry-After` overrides the
computed delay when present. Phase 9 moves the policy table onto `run_steps`; the function stays.

**`google/capabilities.ts`** — every value is a fact with a provenance:

```ts
capabilities(model = 'chirp_2'): ProviderCapabilities {
  return {
    modes: ['sync'],                       // 'batch' in Phase 2, gated on S3
    wordTimestamps: true,                  // S2 2026-08-12: present for 9/10 sampled languages
    wordConfidence: S2_WORD_CONFIDENCE,    // literal from spikes/RESULTS.md — do not guess
    segmentConfidence: true,
    diarization: 'none',
    adaptation: S1_ADAPTATION,             // literal from spikes/RESULTS.md
    languageDetection: false,
    limits: {
      syncMaxBytes: 10 * 1024 * 1024,      // google.ts:18
      syncMaxSeconds: 55,                  // google.ts:19 — margin under the 60s ceiling
      maxConcurrentRequests: 8,
      rpm: 300,
    },
    staging: 'none',                       // 'gcs' in Phase 2
  };
}
```

`supportsLanguage()` reads `PROVIDER_MATRIX` from `@thibi/languages`, so adding a language is a
data change and adding a provider is one file plus a column. `resolveModel()` returns `chirp_2`;
the `long`/`short` models are a documented Phase 6 hook for the adaptation-if-S1-fails case, not
built here.

**Region** defaults to `asia-southeast1` and carries **no constraint logic**. The settings help
text says: "us-central1, europe-west4 and asia-southeast1 all work; pick the nearest. (The previous
region restriction was measured false on 2026-07-30.)"

### 1.6 The no-words degradation path — built now, not later

The overview's Risk 2 says build this first, because otherwise the first Oromo file breaks four
features at once. Concretely, in this phase:

1. `TranscribeResult.wordTimingQuality` is computed from the response, never assumed.
2. `runs.word_timing_quality` = min across chunks; `segments.has_words` per segment.
3. `packages/core/src/timing/interpolate.ts` — pure, shared by the exporter and the editor so they
   cannot disagree:

```ts
export function interpolateWords(seg: { startMs: number; endMs: number; text: string },
                                 lang: ResolvedLanguage): Word[] {
  const units = lang.text.wordSegmentation === 'none'
    ? [...new Intl.Segmenter(lang.code, { granularity: 'grapheme' }).segment(seg.text)].map(s => s.segment)
    : seg.text.split(/\s+/).filter(Boolean);
  const weights = units.map(u => [...u].length || 1);          // longer units get more time
  const total = weights.reduce((a, b) => a + b, 0);
  let t = seg.startMs;
  return units.map((text, i) => {
    const dur = Math.round((seg.endMs - seg.startMs) * (weights[i]! / total));
    const w = { idx: i, startMs: t, endMs: t + dur, text, confidence: null, isEstimated: true };
    t += dur; return w;
  });
}
```

4. **Interpolated words are computed at read time, not stored.** Decision, with the reason: writing
   them into `words` with `is_estimated = true` would poison the `confidence < 0.5` QA query, the
   Phase 3 reconciler's per-word speaker assignment, and any future word-level statistic, all of
   which would then need an `is_estimated = false` filter that someone will forget. `is_estimated`
   stays on the column for Phase 4, where a provider gives coarse real timings we refine.
5. The seam merge's `'no-words'` branch (§1.4).
6. The CLI prints to stderr: `word timings: none — om-ET returned no word offsets; subtitle timing
   will be interpolated` and the JSON carries `wordTimingQuality: "none"`.
7. **Every stage gets a no-words test in this phase**, sharing one fixture
   `__fixtures__/google/recognize-no-words.json`: parse, seam-merge, persist, interpolate, CLI
   output. That shared fixture is the anti-regression.

### 1.7 normalize-text

Chain driven by `lang.text.normalizers`. Two rules the old code gets wrong:

- **`text_raw` keeps the exact provider bytes.** `lib/queue.ts:126` normalizes in place and the
  original is gone forever.
- **Zawgyi is applied per word, with segment text re-derived.** `zg2uni` is not length-preserving,
  so converting segment text desynchronises every word offset under it.

```ts
if (lang.text.zawgyiApplies && isZawgyi(seg.textRaw)) {   // detect on the segment — 1-2 syllables
  words = words.map(w => ({ ...w, text: Rabbit.zg2uni(w.text) }));   // convert per word
  text  = joinWords(words, lang.text.wordJoin);
}
```

Detection on the segment, conversion per word: per-word detection on a two-syllable token is
unreliable. The comment from `lib/myanmar.ts:6-11` — that Google's `myanmar-tools` npm package ships
unbuilt and cannot be required, which is why Rabbit is used — travels with the file.

`wordJoin` is `' '` even for Burmese, because Google emits syllable-spaced Burmese
(`အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက် ကို …`) and preserving provider output is the rule. It does not affect
scoring: `cerStripsWhitespace: true` for scriptio-continua scripts.

### 1.8 `apps/cli`

commander, one file per command.

```
thibi
  db migrate | status | reset
  lang list | show                                   (Phase 0)
  probe languages                                    (Phase 0)
  transcribe <file>
    --lang <code>              required
    --provider <id>            default google
    --model <id>
    --mode auto|sync|sync_chunked                    (batch in Phase 2)
    --out <path|->             default -
    --format json|text         default json
    --no-db                    memory store, no Postgres writes
    --max-duration <seconds>   the "Try 2 minutes first" affordance Phase 11 will call
    --concurrency <n>          default min(configured, provider.maxConcurrentRequests)
    --overlap-ms <n>           default 1200; 0 disables the seam merge
    --raw-dir <path>           dump provider responses for debugging
    --json-errors              errors as JSON on stdout, for scripting
```

`--no-db` is not a convenience flag. It forces persistence to be a **stage** rather than side
effects scattered through the pipeline, and it makes the CLI a usable smoke test before Postgres
exists. Implementation is a `NullDb` satisfying the two reads the pipeline performs (derivative
cache lookup, run row) and discarding writes. It disables the normalize cache; say so in the help.

**Output shape — frozen and versioned**, because tests, Phase 11's UI and any newsroom's script all
parse it:

```jsonc
{
  "schema": "thibi.transcript/1",
  "run": { "id": "…", "provider": "google", "model": "chirp_2", "language": "my-MM",
           "mode": "sync_chunked", "engineVersion": "0.1.0", "wordTimingQuality": "full",
           "startedAt": "…", "finishedAt": "…", "costUsd": 0.96 },
  "media": { "sha256": "…", "filename": "interview.m4a", "durationMs": 3612000, "format": "mov,mp4,…" },
  "chunks": [ { "idx": 0, "offsetMs": 0, "contentStartMs": 0, "endMs": 54000,
                "overlapLeadMs": 0, "status": "done" } ],
  "seams":  [ { "afterChunk": 0, "method": "lcs", "score": 0.86, "droppedWords": 4, "flagged": false } ],
  "segments": [
    { "idx": 0, "startMs": 120, "endMs": 4310, "chunkIdx": 0, "confidence": 0.94, "hasWords": true,
      "text": "…", "textRaw": "…",
      "words": [ { "idx": 0, "startMs": 120, "endMs": 410, "text": "…", "confidence": 0.91 } ] }
  ],
  "warnings": [ { "code": "seam_low_confidence", "chunk": 12, "message": "…" } ]
}
```

`--format text` prints `[00:00:01.120] text` using `formatClock` from `packages/core`, the same
function the editor will use.

Exit codes: `0` ok · `1` usage · `2` not configured · `3` provider rejects the language · `4`
partial (a chunk exhausted its retries) · `5` aborted. **Exit 4 still prints the transcript** — a
3-hour transcript with one bad 55-second chunk is still valuable, and this is the CLI's face of
that principle.

`apps/cli/src/context.ts` is the only environment reader, and the list is exhaustive and reviewed:
`DATABASE_URL`, `STORAGE_DRIVER`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `STORAGE_FS_ROOT`, `FFMPEG_PATH`, `FFPROBE_PATH`, `GOOGLE_SA_JSON`,
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_PROJECT_ID`, `GOOGLE_REGION`, `GOOGLE_MODEL`,
`THIBI_TMP_DIR`, `LOG_LEVEL`. Precedence is DB row → env → default, ported in spirit from
`lib/settings.ts:43-50` along with the mask-aware write logic at `:75-82` (an untouched masked field
must never clobber a stored secret). Encryption is Phase 10.

## Porting notes

Paths on the left are `~/Coding_work/myanmar-transcription`.

| Old | New | Treatment |
|---|---|---|
| `lib/audio/probe.ts:16-38` | `engine/src/audio/probe.ts` | **changed** — ms, more fields, `hasAudio` guard. Keeps the graceful-nulls behaviour *and* its comment; the justification changes (no browser fallback exists, so null routes conservatively) |
| `lib/audio/chunk.ts:19-24` normalize comment | `engine/src/audio/normalize.ts` | **verbatim** — the "48 kHz stereo produced measurably worse transcripts" finding is not re-derivable |
| `chunk.ts:25-34` normalize args | `engine/src/audio/normalize.ts` | **changed** — `+ loudnorm=I=-16:TP=-1.5:LRA=11`, `+ asplit` for peaks, decoupled from chunking, cached by recipe version |
| `chunk.ts:36-59` `detectSilences` | `engine/src/audio/silences.ts` | **verbatim** (seconds→ms). Keep the stderr/null-muxer comment and the `maxBuffer` |
| `chunk.ts:61-77` `cut` + comment | `engine/src/audio/cut.ts` | **verbatim**. The re-encode-not-`-c copy` comment documents a real Google rejection — it must survive |
| `chunk.ts:79-102` `planBoundaries` | `engine/src/audio/plan.ts` | **verbatim core, changed wrapper** — the back-half-of-window rule and its comment are untouched; `planChunks` wraps it with overlap and the corrected budget |
| `chunk.ts:132-136` byte budget | same file | **verbatim** — including "size can bind before duration" |
| `chunk.ts:113-117, 151, 156-158` `DATA_DIR`, `rmSync`, `cleanupChunks` | — | **delete** — replaced by `ObjectStore` + `await using` |
| `lib/providers/types.ts` whole file | `engine/src/providers/types.ts` | **replaced** — seconds→ms, words are first-class, submit/poll/fetch split, capabilities are probed not asserted |
| `lib/providers/google.ts:6-15` header comment | — | **delete** — the region doctrine is measured false |
| `google.ts:11-14`, `:139-141` | — | **delete on sight.** A test asserts no error message names a region |
| `google.ts:17-19` sync caps + comment | `google/capabilities.ts` | **verbatim**, including "margin under the 60s ceiling" |
| `google.ts:36-41` `parseOffset` | `google/parse.ts` | **verbatim** → ms, plus a `{seconds,nanos}` branch |
| `google.ts:43-66` `resolveServiceAccountJson` | `apps/cli/src/context.ts` | **moved out of the engine.** The comment about file-path ergonomics survives with it |
| `google.ts:68-77` `projectIdFrom` | `apps/cli/src/context.ts` | **verbatim** |
| `google.ts:89-94` `speechEndpoint` | `google/recognize.ts` | **verbatim** |
| `google.ts:96-129` token cache | `google/auth.ts` | **changed** — off the module global into a per-context instance, keyed by sha256, with in-flight coalescing. Keeps the 45-minute renewal and its comment, and the "paste the whole file" error text |
| `google.ts:131-152` `toError` | `google/errors.ts` | **changed** — same "surface Google's own message" principle, region hint deleted, classified into typed errors |
| `google.ts:175` `readFileSync` | `google/recognize.ts` | **changed** — async read |
| `google.ts:183-194` request body | `google/recognize.ts` | **changed** — `+ enableWordConfidence`, `+ adaptation` (gated on S1), `+ AbortSignal` |
| `google.ts:200-224` result loop | `google/parse.ts` | **replaced** — the word array is the output; the three-tier fallback is recorded as `wordTimingQuality` instead of degrading silently |
| `lib/queue.ts:52-69` `withRetry`/`RETRYABLE` | `engine/src/retry.ts` | **changed** — full jitter, `Retry-After`, per-kind policy, `AbortSignal` |
| `lib/queue.ts:110` `DELETE FROM segments WHERE run_id` | — | **delete** — runs are append-only; re-transcribing creates a new run |
| `lib/queue.ts:113-136` the chunk loop | `engine/src/pipeline/asr.ts` | **changed** — bounded parallel pool instead of serial; one transaction per chunk (insert segments, `COPY` words, mark chunk done, bump progress, archive raw). The *reason* for per-chunk commits (`:112-113`) is correct and travels |
| `lib/queue.ts:118` `languageCode: "my-MM"` | — | **delete** — language comes from `jobs.language_code` |
| `lib/queue.ts:126` normalize-in-place | `pipeline/normalizeText.ts` | **replaced** — `text_raw` preserved |
| `lib/queue.ts:1-41` in-process queue | — | **not ported.** Phase 1 runs stages inline; Phase 9 brings pg-boss + `run_steps` |
| `lib/myanmar.ts:13-19` | `engine/src/text/normalizers/zawgyi.ts` | **changed** — per-word conversion, registry-gated. The `myanmar-tools`-ships-unbuilt comment travels |
| `lib/settings.ts:43-82` precedence + masking | `engine/src/settings.ts` + `apps/cli/src/context.ts` | **verbatim in spirit** — the "untouched masked field must not clobber" logic is the valuable part |
| `lib/settings.ts:27-37` region doctrine comment | — | **delete**; the `asia-southeast1` default value survives without it |
| `lib/db.ts:5` `DATA_DIR = process.cwd()/data` | — | **must not survive** — banned by lint |
| `lib/db.ts:61-66` boot sweep | — | **must not survive.** Its replacement (heartbeat-based, `awaiting_external` re-polled never reset) is Phase 9 |
| `lib/db.ts:68-70` `DELETE FROM runs WHERE provider NOT IN ('google')` | — | **must not survive.** A startup that deletes user data is not a migration |
| `app/api/jobs/route.ts:47` `Buffer.from(await file.arrayBuffer())` | `storage.putStream` | **replaced** — streaming with a sha256 passthrough |

## Tests

**`packages/engine/src/audio/__tests__/plan.test.ts`**

| Case | Expectation |
|---|---|
| `single chunk when duration < max` | one plan, `overlapLeadMs 0` |
| `snaps to the last silence in the back half` | silences at 20/40/52 s, max 55 → boundary 52 s |
| `ignores silences in the front half` | silence at 8 s with max 55 → boundary 55 s |
| `hard-cuts when no silence is usable` | boundaries at exactly `n × max` |
| `byte budget beats duration budget` | 250 kB/s fixture, 10 MB cap → 36 s chunks |
| `overlap lead never pushes a chunk over the cap` | max 55 000 ms, lead 1200 → every `endMs − offsetMs ≤ 55 000` **(the named regression)** |
| `chunk 0 has no lead` | `overlapLeadMs === 0` |
| `lead is clamped near t=0` | a boundary at 800 ms with lead 1200 → lead 800, `offsetMs 0` |

**`packages/engine/src/audio/merge/__tests__/seam.test.ts`** — fixtures in `__fixtures__/seams/`

| Fixture | Expectation |
|---|---|
| `clean-latin.json` (Hausa, 6 duplicated words) | `method 'lcs'`, `score > 0.9`, exactly 6 words dropped from next |
| `mid-word-my.json` (Burmese, seam inside a word; grapheme path) | no doubled syllable in the joined text; word count = union, not sum |
| `divergent.json` (both chunks transcribe the overlap differently) | `score < 0.5`, `method 'hard-cut'`, `flagged` |
| `grey-zone.json` (score 0.6) | `method 'lcs'` **and** `flagged` |
| `no-words.json` | `method 'no-words'`, segment-granularity, `flagged` |
| `silence-seam.json` (nothing spoken in the overlap) | `method 'empty'`, `score === 1` (**not NaN**), nothing dropped, not flagged |
| `repeated-phrase.json` ("thank you" genuinely said three times) | does not over-drop — the time window, not the whole chunk, bounds the alignment |
| `lead-longer-than-speech.json` | no crash, 0 dropped |
| `apply-drops-whole-segment.json` | a `next` segment whose every word was dropped disappears and indices are renumbered contiguously |
| `apply-rederives-text.json` | partially-dropped segment: `text` re-joined from survivors, `textRaw` **unchanged** |

**`packages/engine/src/providers/google/__tests__/`** — recorded fixtures
`recognize-my-full.json`, `recognize-no-words.json`, `recognize-no-word-confidence.json`,
`recognize-empty.json`, `recognize-nanos-offsets.json`.

- `parse: keeps every word` — count equals the fixture's, not 2
- `parse: applies offsetMs to every word and segment timestamp`
- `parse: confidence is null, not 0, when the field is absent`
- `parse: wordTimingQuality is full | none | partial` (three fixtures)
- `parse: a wordless segment gets hasWords=false and a bounded interval, and a warning`
- `parse: handles {seconds,nanos} offsets identically to "1.500s"`
- `errors: status → classification table` (429/503/500/400-language/400-size/401/teapot)
- `errors: no message mentions a GCP region` — `expect(msg).not.toMatch(/asia-southeast1|europe-west4|us-central1/)`
- `auth: eight concurrent get() calls mint one token` (assert the mint spy called once)
- `auth: a token within 60 s of expiry is refreshed` (FakeClock)
- `recognize: adaptation is omitted when capabilities().adaptation === 'none'`

**`packages/engine/src/text/__tests__/zawgyi.test.ts`** — a Zawgyi segment: word count preserved
after conversion; segment text equals `joinWords(words)`; a Unicode segment is untouched; a
non-Burmese language never invokes the converter (spy).

**`packages/storage/src/__tests__/contract.test.ts`** — one `describe.each` over the three adapters:
put/get round-trip, range GET, `head` on a missing key returns null, `deletePrefix` counts,
`list` pagination, `toTempFile` removes its directory on normal dispose **and when the body throws**,
`presignGet` throws `NotSupportedError` on fs and memory.

**`packages/db/src/__tests__/constraints.test.ts`** — against a real Postgres:
a second live `(run_id, idx)` segment raises 23505; superseding the first lets it in;
two `segment_texts` rows with the same `(segment, 'verbatim', '')` collide (**the NULL-uniqueness
trap, asserted**); `layer='translated'` with `target_lang=''` violates the check;
`copyWords` inserts 30 000 rows and the `words_low_conf` partial index is used by the QA query
(assert via `EXPLAIN`).

**`packages/engine/src/pipeline/__tests__/transcribe.e2e.test.ts`** — `FakeFfmpeg` + fixture
provider + `MemoryObjectStore` + `withTestDb`, on a synthetic 3-chunk file:
all `run_chunks` rows exist **before** the first provider call (assert via call ordering on the
spy); segments are contiguous and ordered; word rows match the fixture count;
`runs.word_timing_quality` is correct; a chunk that fails past `max_attempts` leaves the run
`partial` with a placeholder segment and the other chunks intact; `--overlap-ms 0` produces the
duplicate-bearing output (proving the merge is what removes it).

**Live smoke, behind `THIBI_LIVE=1`** — `google.live.test.ts`: a 2-second real clip; asserts the
output contains Myanmar codepoints, and asserts that the observed presence of `wordConfidence`
**matches the S2 verdict compiled into `capabilities()`**, failing loudly if Google's behaviour has
changed. That is the check that keeps the capability table honest over time.

## Verification

```bash
$ docker compose -f infra/compose.dev.yml up -d postgres minio
$ pnpm --filter @thibi/db migrate
applied 0000_init.sql  (17 tables)

$ pnpm thibi transcribe ./fixtures/burmese-90s.m4a --lang my --out - > out.json
normalize: computed (norm_16k_mono_flac@a1b2c3d4) in 2.1s
plan: 2 chunks, overlap 1200ms
asr: chunk 1/2 done · chunk 2/2 done
seam 0→1: lcs score 0.86, dropped 4 duplicated words
words: 251 · word timings: full · cost $0.024

$ jq '.run.wordTimingQuality, (.segments|length), ([.segments[].words[]]|length)' out.json
"full"
7
251
$ psql "$DATABASE_URL" -tAc "select count(*) from words"
251
$ jq '.segments[0].words[0]' out.json
{ "idx": 0, "startMs": 120, "endMs": 410, "text": "အာဆီယံ", "confidence": 0.91 }
```

Correct output means: `words` is non-empty (this is the whole point of the phase — the old code
would print segments only), every `confidence` is either a number in (0,1) or `null` and never `0`,
and the `psql` count matches the JSON count.

```bash
# the normalize cache
$ pnpm thibi transcribe ./fixtures/burmese-90s.m4a --lang my --out /dev/null
normalize: cached (norm_16k_mono_flac@a1b2c3d4)

# the seam merge is what removes the duplicate
$ pnpm thibi transcribe ./fixtures/seam-word.m4a --lang my --overlap-ms 0 --out - | jq -r '.segments[].text' | grep -c 'ဆုံးဖြတ်ချက်'
2
$ pnpm thibi transcribe ./fixtures/seam-word.m4a --lang my --out - | jq -r '.segments[].text' | grep -c 'ဆုံးဖြတ်ချက်'
1

# the no-words path degrades instead of breaking
$ pnpm thibi transcribe ./fixtures/oromo-20s.m4a --lang om --out - | jq '.run.wordTimingQuality, (.warnings|length)'
"none"
1
#  → exit 0, valid JSON, a stderr warning. Not an exception.

# partial failure is survivable
$ THIBI_FAULT_CHUNK=3 pnpm thibi transcribe ./fixtures/long.m4a --lang my --out -; echo "exit=$?"
exit=4
#  → the transcript still printed, with a placeholder segment for chunk 3

# the architectural invariants
$ grep -rn "process\.env\|process\.cwd\|__dirname" packages/*/src | grep -v __tests__
$ grep -rn "asia-southeast1" packages/engine/src
packages/engine/src/providers/google/capabilities.ts:  region: 'asia-southeast1',   // default only
$ grep -rn "my-MM" packages/engine/src apps/cli/src | grep -v __tests__ | grep -v fixtures
#  no output — the language is data

$ pnpm test && pnpm --filter @thibi/engine test --coverage
#  engine/src/audio/merge ≥ 90% lines
```

Real-audio checks that no test can replace:

1. Open the source file in an editor, seek to three word timestamps from the JSON, confirm each is
   within ±150 ms.
2. On `fixtures/seam-word.m4a`, whose known word straddles a boundary, confirm the word appears
   exactly once and its timing is contiguous with its neighbours.
3. Confirm `runs/{id}/raw/000.json` in MinIO is the untouched Google response.

## Risks and open questions

1. **S2 may say Chirp has no word confidence.** Half the QA surface then degrades to segment level.
   Not a blocker for this phase, but `capabilities()` must say so today and the live smoke test must
   fail if reality diverges. Do not write `wordConfidence: true` and plan to check later.
2. **LCS de-duplication on genuinely repeated speech.** A speaker saying "no, no, no" across a seam
   is the adversarial case. The time-windowed alignment and the `repeated-phrase` fixture are the
   defence, but this will need tuning against real recordings. `--overlap-ms 0` is the escape hatch
   and must stay working.
3. **The grey zone (0.5–0.7) is a guess.** The 0.5 threshold comes from the overview; 0.7 for
   "accept but flag" is invented here. Both are constants in one file, and Phase 12's flagged-seam
   UI is what will produce the evidence to tune them.
4. **Rounding across 65 chunks.** Rule: parse converts to integer ms with `Math.round` exactly once,
   and `offsetMs` is added as an integer. Any float seconds surviving past `parse.ts` is a bug.
5. **Single-pass loudnorm can pump** on music-heavy or highly dynamic audio. Unlikely for
   interviews; the `normalize.twoPass` setting is the answer if a newsroom reports it.
6. **Test Postgres in CI.** `CREATE DATABASE … TEMPLATE` needs a role that can create databases. If
   the CI Postgres will not allow it, fall back to one schema per test file; decide on day one, not
   after 40 tests assume the template.
7. **`await using` / `Symbol.asyncDispose`** must be verified working under Node 22 with the chosen
   tsconfig before the storage package is written. It is a five-minute check and a painful
   retrofit.
8. **Concurrency default.** `min(configured, 8)` for Google is a guess at the point where the
   per-project quota starts pushing back. The outbound token bucket that makes this safe across
   containers is Phase 9; until then, an operator running two CLIs at once can self-429. Note it in
   the help text.
9. **Open:** whether the redundant `(verbatim, asr)` row in `segment_texts` is worth its rows.
   Decided yes for uniformity; revisit at Phase 12 if the editor's read path or the row count hurts.
10. **Open:** whether `run_chunks.raw_key` should point into MinIO or whether raw responses should
    be retention-swept by default. Phase 1 archives them unconditionally; Phase 15's retention
    policy decides their lifetime.

## Definition of done

- [ ] `thibi transcribe ./fixtures/burmese-90s.m4a --lang my` prints `schema: "thibi.transcript/1"` JSON with non-empty `words` on every segment that has them.
- [ ] The word count in the JSON equals `select count(*) from words` for that run.
- [ ] `words.confidence` is `NULL` where the provider gave none, and no row is `0` as a stand-in.
- [ ] Running the same file twice logs `normalize: cached` the second time, and `media_derivatives` has exactly one row.
- [ ] `run_chunks` rows — including `overlap_lead_ms` — exist before the first provider request, asserted by a test on call ordering.
- [ ] A file with a word straddling a chunk boundary yields that word exactly once; `--overlap-ms 0` yields it twice.
- [ ] A provider response with an empty word array produces exit 0, `wordTimingQuality: "none"`, a warning, and valid JSON — and there is a test for that fixture in parse, seam, persist and CLI.
- [ ] A chunk failing past its retries yields exit 4 **with the transcript printed** and the run marked `partial`.
- [ ] `segments.text_raw` holds the provider's exact bytes for a Zawgyi fixture, and `segments.text` holds the converted text with word offsets still aligned.
- [ ] One `segment_texts` row per segment at `(verbatim, '', asr)`; a second insert on the same key raises 23505.
- [ ] The storage contract suite passes identically against S3/MinIO, fs and memory.
- [ ] `toTempFile`'s directory is gone after both a normal return and a thrown error.
- [ ] `grep -rn 'process.env\|process.cwd\|__dirname' packages/*/src` (excluding tests) is empty, and `apps/cli/src/context.ts` is the only env reader.
- [ ] No error message, comment or string in `packages/engine` asserts a region constraint; the test asserting this passes.
- [ ] `grep -rn 'my-MM' packages/engine/src apps/cli/src` (excluding tests and fixtures) is empty.
- [ ] `capabilities()` values for `wordConfidence` and `adaptation` are literals traceable to a row in `spikes/RESULTS.md`, with the date in a comment.
- [ ] The live smoke test (`THIBI_LIVE=1`) passes and fails loudly if Google's word-confidence behaviour diverges from the recorded verdict.
- [ ] `packages/db/migrations/0000_init.sql` is committed; `drizzle-kit push` appears in no script.
- [ ] `pnpm test` green; `packages/engine/src/audio/merge` line coverage ≥ 90%.

