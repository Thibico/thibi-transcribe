# thibi-transcribe — multi-language transcription engine

*Master plan. Each phase in the build order below has its own detailed execution plan —
see [README.md](./README.md) for the index.*

## Context

`~/Coding_work/myanmar-transcription` is a working Next.js app that transcribes Burmese audio
with Google Speech-to-Text v2 (`chirp_2`), edits it in a timestamped segment editor, and
exports SRT/VTT/TXT/JSON. It runs on one laptop: SQLite on local disk, uploads in `data/`, an
in-process promise-chain queue, no auth. Its own README says *"do not deploy this anywhere
public as-is."*

Measurement in that repo (`research/language-expansion-recommendations.md`, 2026-07-30, local
and not committed) established the technical case for generalising it: **44 languages work on
Google Speech-to-Text that no OpenAI model will accept, and 20 of those are refused by every
Whisper endpoint tested** — Hausa, Javanese, Yoruba, Igbo, Oromo, Amharic, Khmer, Lao, Pashto,
Sorani Kurdish, Cebuano, Zulu, Xhosa among them. Those are the languages this tool is built to
serve, and they are why Google is the primary provider rather than one option among several.

`thibi-transcribe` is that generalisation: **self-hosted, one instance per newsroom**,
multi-language, multi-provider, with diarization, glossary-driven accuracy, and an editorial
LLM layer.

Three measured findings are treated as requirements, not nice-to-haves:

1. **A permissive cleanup prompt damages transcripts.** Scored as CER against a punctuated
   reference with "do nothing" as the control, the prompt this project inherits is worse than
   doing nothing in *every* language tested, Burmese included (Burmese 0.016 → 0.033; Yoruba
   0.059 → 0.148). It silently rewrites: Yoruba `UN` → the pronoun "they"; Pashto "the
   effects" → "global warming". A pass meant to make a transcript quotable must not alter
   quotations, so the restraint-constrained rewrite is a hard requirement of v1 rather than a
   later refinement.
2. **Accepting a language code proves nothing.** Groq's `whisper-large-v3` accepts `my` and
   returns non-words. Support must be *measured*, so the FLEURS harness is part of the
   product and every language carries a tier.
3. **The ASR is not the differentiator.** Cleanup, translation, timestamped editing, speaker
   attribution and export are — and they generalise across languages far better than ASR does.

Fresh repo. No data migration from the old app; it keeps running until this reaches parity.

## Confirmed decisions

| Area | Decision |
|---|---|
| Deployment | Self-hosted, one instance per newsroom, Docker Compose, run by non-sysadmins |
| Persistence | Postgres + MinIO (S3-compatible) |
| Auth | Local username/password, roles admin/editor, per-user edit attribution |
| Stack | TS monorepo (engine + CLI + thin Next.js UI) + Python sidecar |
| ASR providers | Google STT v2 (primary), OpenAI/Groq Whisper, self-hosted faster-whisper |
| Long audio | **Chunked parallel sync at any duration** — measured faster everywhere. `batchRecognize` is the opt-in cheaper/slower path, not the long-file path |
| Diarization | pyannote sidecar (default), ElevenLabs Scribe fallback |
| Word data | Word-level timings + confidence stored |
| Accuracy | Per-job/project/instance glossary → **post-hoc entity pass only**; Google adaptation measured non-functional on Chirp (S1) |
| Segment model | ASR segments canonical; words attached; subtitles re-flowed at export |
| LLM layer | Provider-agnostic over Anthropic / OpenAI / OpenRouter; model per pass |
| Passes | Restraint cleanup · translate to configurable target · glossary entities · document |
| Languages | All ~107 Google codes, tiered verified / beta / experimental from measured CER |
| RTL | Direction in the registry now; basic RTL editor + export isolates in v1 |
| Inputs | Local upload · batch upload · yt-dlp URL import |
| Exports | SRT/VTT/TXT/JSON w/ layer picker · bilingual subs · speaker-labelled docx/md |
| Cost | Configurable rate table + recorded actual spend per run |
| Retention | Configurable, **off by default**, with a dry-run before the first sweep |

---

## Phase 0 — three spikes: RUN 2026-08-09

All three are answered. Method, numbers and limits in
**[phase-00-spike-results.md](./phase-00-spike-results.md)**; the consequences are already
folded into the sections below.

| | Question | Verdict |
|---|---|---|
| **S1** | Does Chirp honour speech adaptation? | **FAIL.** Boost 0/10/20 byte-identical; relevant keyterms produced zero lexical change; an *irrelevant* phrase set corrupted a word the baseline got right, in all five occurrences. Never send `config.adaptation` to Chirp. The glossary entity pass is the only entity mechanism for the exclusive-language set. |
| **S2** | Is `wordConfidence` populated on Chirp? | **PASS.** 101/101 words, 101 distinct values, full offsets. Low-confidence QA is viable on the primary provider. |
| **S3** | Does `batchRecognize` work, and how fast? | **Works, but it is the slow path.** Flat 5.9× realtime vs chunked parallel sync's 3.6–7× advantage at every size. Batch is an admin cost choice, not the long-file path. Also: `done: true` can hide a per-file error (1 run in 5); hard cuts lose 2–3 words per seam; sequential chunk cutting dominates long-file prep. |

Bonus control: **Chirp 2 is deterministic** — two identical requests returned byte-identical
transcripts. The eval harness therefore needs no repeat-and-average for a fixed input.

Also delete on sight when porting: the stale region doctrine at `lib/providers/google.ts:11-14`
and `:139-141`, `lib/settings.ts:29`, `app/settings/page.tsx:27`. Confirmed again here — Speech
v2 returned `200` from all three regions for this project.

---

## Repo layout

pnpm workspaces + Turborepo. One Node image for `web` and `worker` (same engine version, half
the build time), one Python image for the sidecar.

```
packages/
  core/       zero runtime deps, browser-safe: types, timecode, subtitle reflow,
              bidi, export writers, metrics (CER/WER/chrF), pricing format
  languages/  registry data + resolver + normalizers + provider matrix
  db/         Drizzle schema + committed SQL migrations
  storage/    ObjectStore port + S3/MinIO, fs, memory adapters
  engine/     providers, audio, pipeline, diarize+reconcile, llm passes,
              glossary, ingest, queue handlers, settings/secrets
  eval/       FLEURS harness
apps/
  web/        Next.js 16 App Router — thin, no business logic
  worker/     builds EngineContext, subscribes to queues
  cli/        `thibi` — the demonstrable surface for phases 1-8
services/
  sidecar/    FastAPI: pyannote diarization + faster-whisper, one image
infra/        compose.yml, compose.gpu.yml, Caddyfile, ./thibi wrapper script
```

Dependency direction is one-way: `core ← languages ← db ← engine ← {web, cli, worker}`.
`core` is importable from React client components — that is why subtitle re-flow and CER live
there (the editor previews CPS live; the harness and the app must score identically).

**The engine never reads `process.env` or `process.cwd()`.** Everything arrives via one
`EngineContext { db, store, staging?, settings, llm, sidecar?, ffmpeg, clock, logger, events,
languages, concurrency }`. Every stage is `(ctx, input) => Promise<output>`. Tests build a
context with `MemoryObjectStore`, a throwaway Postgres, a `FakeClock`, and recorded fixtures.

---

## Data model (Postgres + Drizzle)

Drizzle because the schema is the shared type surface between `db`, `engine` and `web`.
`drizzle-kit generate` emits plain `.sql`, committed, applied by a one-shot `migrate` service
that everything else `depends_on: service_completed_successfully`. Forward-only; rollback is
restore-from-backup; destructive changes use expand/contract across two releases.

**No `orgs` table.** One instance per newsroom is confirmed. `projects` gives the grouping
newsrooms actually want ("Election 2026") and is the scoping unit for glossaries. If
multi-tenancy ever arrives it's one migration.

### Core tables

```
users            username, display_name, password_hash (argon2id), role, disabled_at,
                 must_change_pw
sessions         id = sha256(token) — the token itself is never stored
projects         name, slug, default_language_code

media_assets     sha256 UNIQUE (content dedupe), storage_key, filename, mime, bytes,
                 duration_ms, source (upload|url|batch|api), source_meta jsonb, probe_raw
media_derivatives  (asset_id, kind, recipe_version) UNIQUE — 'norm_16k_mono_flac',
                 'waveform_peaks'. Normalize once, reuse across every run and provider.
jobs             project_id, asset_id, title, language_code, status, primary_run_id
```

### Runs and the pipeline DAG

The state machine lives in **our** tables; the queue is only a doorbell. This is what makes
the step timeline, resumability, cancellation and per-step cost queryable rather than hidden
inside a queue library.

```
runs        job_id, provider_id, model, language_code, mode (sync|sync_chunked|batch),
            state, pipeline jsonb, progress, operation_name (Google LRO — survives restarts),
            staging_prefix, word_timing_quality (full|partial|none), cost_usd,
            cancel_requested_at, engine_version

run_steps   run_id, kind, ordinal, shard, depends_on uuid[], state, attempt, max_attempts,
            input/output jsonb, error jsonb, external_ref, deadline_at, heartbeat_at,
            cost_usd,  UNIQUE (run_id, kind, shard)   ← makes the planner idempotent

run_chunks  run_id, idx, offset_ms, duration_ms, overlap_lead_ms, storage_key, status,
            attempts, raw_key,  UNIQUE (run_id, idx)  ← written BEFORE any network call
```

`kind` ∈ `media.normalize`, `asr.chunk`, `asr.batch.submit`, `asr.poll`, `diarize`,
`diarize.poll`, `reconcile`, `editorial.pass`, `export`, `maintenance.*`.

### Segments, words, speakers

```
segments   run_id, idx, start_ms, end_ms,
           text        normalized verbatim, IMMUTABLE
           text_raw    exactly what the provider returned, pre-normalizer
           confidence, chunk_id, has_words,
           speaker_id, speaker_purity, needs_speaker_review,
           split_of, superseded_at, superseded_by     ← human-split lineage
           UNIQUE (run_id, idx) WHERE superseded_at IS NULL

words      segment_id, run_id, idx, start_ms, end_ms, text, confidence, speaker_id,
           is_estimated
           INDEX (run_id) WHERE confidence < 0.5      ← risk-based QA

speakers   job_id (not run_id — a human rename must survive re-transcription),
           key ('speaker-00'), display_name, color_idx, is_merged_into
diarization_runs   provider, model, params, state, task_id, speakers_found
speaker_turns      diarization_run_id, speaker_id, start_ms, end_ms
```

Words as rows, not jsonb: ~10k words per audio-hour, so 1,000 hours is 10M rows — small for
Postgres, and rows are required for low-confidence queries, corpus entity search, and
export-time joins against speaker turns. Batch writes use `COPY`.

### Editorial layers — the key modelling decision

Not columns, not one table per pass. One table addressed by `(segment, layer, target_lang)`:

```
editorial_passes   run_id, kind, layer, target_lang, source_layer,
                   llm_provider, model, prompt_id, prompt_version, glossary_ids,
                   state, segments_done, segments_skipped_human, tokens_in/out, cost_usd

segment_texts      segment_id, run_id,
                   layer        verbatim | cleaned | translated | entity_corrected
                   target_lang  '' except for translations
                   origin       asr | llm | human | rule
                   text, pass_id, author_id, meta jsonb, superseded_at
                   UNIQUE (segment_id, layer, target_lang) WHERE superseded_at IS NULL

documents          run_id, kind (summary|chapters|quotes), target_lang, content jsonb,
                   content_md, pass_id, superseded_at
```

What this buys:

- **N target languages = N rows**, never new columns.
- **Human edits are a layer value.** Editing verbatim writes `(verbatim, origin=human)` and
  supersedes the previous row while `segments.text` stays as the immutable ASR record.
- **Provenance is free** — every row points at the pass carrying provider, model, prompt
  version and cost. Reverting a pass is one `UPDATE`, because supersession is history, not
  destructive overwrite.
- **An LLM pass never supersedes a human row** unless explicitly forced; it counts them in
  `segments_skipped_human`.
- Resolution for editor and exporters is `resolveLayer(seg, texts, want, fallback)` in
  `packages/core/src/layers/resolve.ts`.

`quotes` content carries `segmentIds` so the editor can jump to the audio — a newsroom checks
every quote against the recording.

### Glossaries, settings, spend, eval

```
glossaries        scope (instance|project|job), project_id?, job_id?, language_code?
glossary_terms    term, variants[], kind, boost, translations jsonb, do_not_translate
```
One term row feeds three consumers: `term`+`variants`+`boost` → Google inline phrase set
(if S1 says yes); `variants → term` → constrained substitution pass; `translations` +
`do_not_translate` → the translation prompt's fixed lexicon.

```
settings          key, value jsonb, secret_ct/nonce/tag bytea, is_secret, hint, updated_by
model_profiles    'cleanup.default' | 'translate.default' | … → provider, model, temperature
rates             provider, model, unit, usd_per_unit, source (default|override)
usage_records     run_id, step_id, kind (asr_minutes|llm_tokens), quantity, usd
language_support  code, tier, cer, cer_baseline, cer_ratio, eval_* , enabled, notes
eval_runs / eval_results
segment_revisions segment_id, layer, prev_text, next_text, author_id, source, created_at
audit_log / media_access_log
run_events        bigserial seq, run_id, kind, data — the SSE replay log
```

`rates` + `usage_records` replaces the old 420-line Cloud Billing catalog scraper: a
configurable USD/minute per provider+model, a pre-run estimate reusing `ConfirmRunDialog`, and
recorded actual spend rolled up per user and per project.

---

## Queue and resumability

**pg-boss as transport, `run_steps` as the source of truth.** Postgres-only, no Redis. pg-boss
contributes `SKIP LOCKED` fetch, delayed jobs, singleton keys, cron and archival; it does not
own state. `retryLimit: 0` on every send — retries are ours, so they are visible in the UI and
fight nothing.

A `reconcile(runId)` function runs after every step completion and on a 30 s tick, under
`pg_advisory_xact_lock`. It promotes `pending → ready` when `depends_on` is satisfied, sends
the pg-boss job, recomputes weighted progress, and completes or fails the run.

Concurrency in three layers: queue routing (`worker` takes media/cloud-ASR/editorial;
`worker-heavy` takes diarize/local-ASR at concurrency 1), pg-boss per-queue `batchSize`, and a
`pg_try_advisory_lock` global slot so scaling `worker-heavy` by accident can't OOM the GPU.
Plus an outbound token bucket per provider in Postgres, because Google's quota is per-project,
not per-container.

Retry policy per step kind, generalising `withRetry`/`RETRYABLE` from `lib/queue.ts:52-69` with
full jitter and `Retry-After`:

```
media.normalize  2 × 5s    asr.chunk  5 × 2s (jitter)   asr.batch.submit 3 × 30s
diarize          2 × 60s   editorial.pass 4 × 5s (jitter)
```

**Long async steps never hold a worker slot.** `asr.batch.submit` persists the LRO name to
`external_ref` and sets `awaiting_external`; `asr.poll` self-reschedules with capped backoff
(30 → 300 s). Same shape for the sidecar. A container restart mid-`batchRecognize` costs
nothing and is not re-billed.

**Delete the boot sweep at `lib/db.ts:63-66`.** Its replacement, on worker boot and every 60 s:
steps whose `heartbeat_at` is stale get `attempt + 1` and go back to `pending`; steps in
`awaiting_external` are **re-polled, never reset**; every non-terminal run is reconciled. Long
steps heartbeat every 15 s. A `docker compose restart` during a 3-hour transcription now loses
at most one chunk instead of the whole run.

Partial failure is survivable: a chunk past `max_attempts` marks the run `partial`, not
`failed`, with a placeholder segment and a per-chunk retry in the UI. A 3-hour transcript with
one bad 55-second chunk is still valuable.

Cancellation is `runs.cancel_requested_at` + NOTIFY: pending steps cancel immediately, running
steps get an `AbortSignal` checked between chunks, external ops get a best-effort cancel call.

Dead-letter queue → `/admin/queue`, listing dead steps with payload, error and a Retry button.

---

## Pipeline

```
ingest → probe → normalize ──┬──► plan ──► ASR ──┐
                             └──► diarize ───────┴──► reconcile ──► normalize-text ──► persist
                                                                            │
                                            editorial passes (on demand) ───┘ ──► export (pure)
```

ASR and diarization consume the **same normalized derivative** and run concurrently — they are
independent, diarization is the long pole, and sharing one timeline is what makes
reconciliation possible at all.

**ingest.** Stream to MinIO via `@aws-sdk/lib-storage` with a sha256 passthrough — never
`Buffer.from(await file.arrayBuffer())` on a 2 GB file the way `app/api/jobs/route.ts:47` does.
URL import is a worker-only step: yt-dlp `--dump-json` first to show title and duration, then
confirm cost with real numbers, then download. Guardrails: `--max-filesize`, duration filter,
domain allowlist, non-root, 2 concurrent max.

**probe / normalize.** Port `lib/audio/probe.ts` including its graceful nulls-not-throws
behaviour. Two changes from `chunk.ts:25-34`: loudnorm added, and normalization decoupled from
chunking and cached in `media_derivatives`. Waveform peaks (20 buckets/s, min+max int8 =
~144 KB/hour) produced in the same pass.

**The resample must come after `loudnorm`, and this is not obvious.** `loudnorm` runs
internally at 192 kHz and emits at its own rate, so any resample *before* it is silently
discarded. Written as `-af ... -ar 16000` it happens to survive, because `-ar` is an output
option and inserts a resampler after the graph; written inside a `filter_complex` — which the
implementation needs, since peaks and FLAC come from one `asplit` — it does not. Phase 1 wrote
the second form and shipped a `norm_16k_mono_flac` that produced 192 kHz for a month of runs
before Phase 2 noticed the file size. The recipe is:

```
aformat=channel_layouts=mono,aresample=16000,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=16000
```

The trailing `aresample` is the fix and is worth 6× the bytes. See amendment 24.

**plan.** Writes `run_chunks` before any network call.
```
duration ≤ syncMaxSeconds && bytes ≤ syncMaxBytes  → sync
admin opted into "cheaper, slower"                 → batch
sync quota exhausted / sustained 429s              → batch          ← NOT BUILT, see below
otherwise                                          → sync_chunked   ← the default at ANY duration
```
**Phase 2 implemented three of these four.** The quota-pressure fallback is not built and was
not designed: `planMode` takes no quota input, and it would have to, since the decision would
depend on live 429 rates rather than on anything about the file. It also cannot be a silent
fallback — a run that quietly becomes 5× slower because a *different* run exhausted the quota
is a support ticket, not a feature. It belongs with Phase 9's token bucket, which is the only
place that knows the quota state, and it is listed there as unbuilt rather than assumed.
**Amended 2026-08-09 by spike S3.** The original rule split on duration at 15 minutes and
justified it on latency. That was wrong. `batchRecognize` runs at a flat **5.9× realtime**
(305 s for 30 min, 1211 s for 2 h) while chunked parallel sync at concurrency 8 is **3.6–7×
faster at every size measured**, with zero 429s across 136 requests. Batch's only
justifications are cost — the Dynamic Batch SKU, **confirmed 2026-08-10 at 5.33x**
($0.016/min against $0.003/min, from the Cloud Billing Catalog rather than from documentation;
see amendment 21) — and
sync-quota pressure. It is therefore an admin trade-off, not something the engine infers from
duration. No staging bucket configured is now the normal case, not a degraded one. Full numbers
in [phase-00-spike-results.md](./phase-00-spike-results.md).

**Chunk cutting must be parallelised.** At 2 h it is 200 s of the 338 s total — ffmpeg cutting
136 chunks sequentially, which is what `lib/audio/chunk.ts` does today. Parallelised across
cores it drops to roughly 30 s. Without this, prep dominates on exactly the long files the
product exists for.

Chunking reuses `detectSilences` and `planBoundaries` (`lib/audio/chunk.ts:40-102`) nearly
verbatim, including the back-half-of-window rule and the bitrate-derived byte budget at
`:134-136` — both correct and non-obvious. Keep the re-encode-not-`-c copy` comment; it
documents a real Google rejection. **One substantive change: overlap.** Each chunk after the
first starts `overlap_lead_ms` (1200 default) early; at merge, align the two word sequences by
LCS on normalized text and drop the later chunk's duplicated prefix. Below 0.5 LCS confidence,
hard-cut at the overlap midpoint and flag the seam. For unspaced scripts, LCS over graphemes.

**ASR sync_chunked.** Bounded pool of `min(configured, provider.maxConcurrentRequests)`,
default 4-8. Per chunk in one transaction: insert segments, `COPY` words, mark chunk done,
bump progress, archive the raw response to `runs/{id}/raw/{idx}.json`.

**diarize.** Whole file, never per chunk — that is the complete answer to chunk-boundary
speaker handling. `POST sidecar /v1/diarize { idempotency_key: step_id, audio_url: presigned }`
→ task_id → poll.

**reconcile** (`packages/engine/src/diarize/reconcile.ts`) — the highest-value new algorithm:

1. Interval index over turns; per word, assign the max-overlap turn (nearest within 500 ms if
   none overlaps), recording the margin over the runner-up.
2. **Width-3 median filter** over the word sequence, guarded by `margin < 0.6` and
   `duration < 400 ms`. Removes pyannote's single-word flicker at turn edges without eating
   genuine one-word interjections — which in an interview are exactly the words that matter.
3. Per segment, majority vote **weighted by word duration, not count**; `purity =
   winnerMs / totalMs`; `needs_speaker_review` below 0.6.
4. Segments with `has_words = false` fall back to interval overlap and are **always** flagged.
   Never silently attribute.
5. **Re-diarization reuses existing speaker rows** via Hungarian assignment on the overlap
   matrix against previously attributed time. A human's "Speaker 01 = Daw Aung San Suu Kyi"
   survives every re-run.

**normalize-text.** Registry-driven normalizer chain. Two rules the current code gets wrong:
`text_raw` keeps the exact provider bytes (the current app normalizes in place at
`lib/queue.ts:126` and loses the audit trail), and Zawgyi conversion is applied **per word**
with segment text re-derived — it isn't length-preserving, so doing it at segment level
desynchronises word alignment.

---

## Providers

```ts
interface TranscriptionProvider {
  id; label;
  capabilities(model?): {
    modes: ('sync'|'batch')[]; wordTimestamps; wordConfidence; segmentConfidence;
    diarization: 'none'|'native'; adaptation: 'none'|'phrase-set'|'prompt';
    languageDetection; limits {syncMaxBytes, syncMaxSeconds, maxConcurrentRequests, rpm};
    staging: 'none'|'gcs'|'s3';
  };
  supportsLanguage(code, model?): ProviderLanguageCapability | null;
  resolveModel(code, { requireWordTimestamps }): string | null;
  isConfigured(cfg); costModel(mode);
  transcribe(cfg, req): Promise<TranscribeResult>;
  submitBatch?(cfg, req); pollBatch?(cfg, op); fetchBatchResult?(cfg, op, req); cancelBatch?;
}

ProviderWord    { startMs, endMs, text, confidence?, speakerTag?, isEstimated? }
ProviderSegment { startMs, endMs, text, confidence?, words: ProviderWord[], ... }
TranscribeResult{ segments, wordTimingQuality: 'full'|'partial'|'none', usage, raw }
```

The submit/poll/fetch split is the load-bearing change from today's single `transcribeChunk`.

- **google/** — closest port. `auth.ts` is the token cache from `google.ts:101-129` (moved off
  the module global into ctx). `recognize.ts` now requests `enableWordConfidence` and **keeps
  the word array** instead of using it only for bounds (`:207-221`). `parse.ts` keeps
  `parseOffset` and the three-tier timestamp fallback, but records the outcome as
  `wordTimingQuality` rather than silently degrading.
- **whisper-http.ts** — shared base for OpenAI and Groq (identical request shape).
  `verbose_json`, `timestamp_granularities[]=word,segment`, glossary terms into `prompt`
  (≤224 tokens). OpenAI: `whisper-1` only for the timestamped path — `gpt-4o-transcribe`
  returns none, so its capability is `wordTimestamps: false`. No true confidence; map
  `exp(avg_logprob)` at *segment* level and set `wordConfidence: false` rather than lying.
- **groq.ts** — same base. Codes it accepts but mangles (the Burmese romanization failure) are
  marked `supported: false` in the matrix. **Accepting a code is not support.**
- **faster-whisper.ts** — talks to the same sidecar. Real per-word `probability`, so the only
  provider with genuine word confidence. `maxConcurrentRequests: 1`, submit/poll shape.

Adding a provider = one file plus a column in `provider-matrix.json`. It does not mean editing
107 language entries.

---

## Language registry

Three layers, deliberately:

1. **`packages/languages/data/languages.json`** — code-adjacent facts, version-controlled,
   compiled to a frozen TS object at build so it's importable from client components:
   `code, iso639_1/3, nameEn, endonym, altNames`, `script {code, direction, complex}`,
   `typography {fontFamily, googleFontSubsets, cssStack, lineHeight, minFontPx}`,
   `text {wordSegmentation, normalizers[], zawgyiApplies, zeroWidthPolicy, digits, punctuation}`,
   `subtitle {cpsMax, charsPerLineMax, maxLines, lineBreak}`, `fleurs {config}`, `waveHint`.
2. **`data/provider-matrix.json`** — the 107 × 4 capability grid, **generated** by
   `thibi probe languages --provider google`, which automates the research doc's method
   (send a 2 s clip per code, record the status). Committed with the probe date, so when
   OpenAI widens its list you re-run and diff.
3. **`language_support` table** — tier, CER, eval date, `enabled`. Written by the harness,
   editable by an admin, merged over the static entry by `resolveLanguage()`. **This is what
   makes tier data rather than code:** shipping a new tier is a DB write, not a deploy.

---

## Eval harness (`packages/eval`)

Verified against the live HF repo, and these findings change the design:

- TSVs are exactly as the research describes: `data/<cfg>/dev.tsv`, no auth, 7 tab-separated
  columns. Cache keyed by the blob `oid` from the HF tree API to revalidate for free.
- **`id` is a shared sentence key across languages** (`ha_ng` 1615 ↔ `en_us` 1615 is the same
  sentence) — that's the n-way join for translation chrF. Dedupe: multiple rows share an id.
- **Audio has no per-file URL, and the HF rows API is broken for this dataset** (`Scan size
  limit exceeded`). Do not plan on it.
- **A ranged tarball stream works.** `Range: bytes=0-N` on `audio/dev.tar.gz` → gunzip →
  `tar-stream`, take entries until you have enough, destroy the request. ~730 KB compressed per
  clip; 6 MB yielded 7 complete wavs. Tar order is by random-hash filename, so "first N" is a
  deterministic, effectively-random, reproducible sample — state that in the report.
- Split-naming trap: the file is `dev.tsv`, the HF config split is `validation`.

**Metrics in TS (`packages/core/src/metrics`), not jiwer.** The app needs the same CER and the
same normalization (run comparison, confidence review); it keeps the sidecar optional for the
harness; and **jiwer's WER tokenizer is whitespace-based, which is precisely wrong for
Burmese**. Levenshtein over a codepoint array is ~40 lines; chrF2 ported from sacrebleu is
~60. Cross-check against `jiwer`/`sacrebleu` once, freeze as `__fixtures__/parity.json`, assert
in CI.

**CER care for scriptio-continua languages** — get this wrong and every number is garbage:

1. NFC first, always. 2. Zawgyi detect+convert before scoring, or a Zawgyi-emitting provider
scores ~100% error for a rendering issue. 3. **Strip all whitespace before CER for Mymr, Khmr,
Laoo, Thai** — spacing is arbitrary on both sides; `cer_nospace` is the tiering metric.
4. Strip punctuation for the ASR metric, **keep** it for cleanup where it is the whole point.
5. Normalize digit shapes. 6. Strip ZWSP always; ZWNJ/ZWJ only for Mymr (semantic in Sinhala
and Devanagari) — encoded as `zeroWidthPolicy`. 7. Report codepoint CER (comparable to the
literature) and grapheme CER (matches intuition); tier on codepoint. 8. **Report WER as `null`
for non-word-delimited scripts**, or label it `wer_icu` so it can never be mistaken for
comparable WER.

**Tiering**, with the Burmese baseline measured every run, never hardcoded:

```
verified      ratio ≤ 1.15 AND cer ≤ 0.20 AND n ≥ 30
              AND 95% bootstrap CI clear of the beta line AND humanReview present
beta          ratio ≤ 2.0 AND cer ≤ 0.35
experimental  correct script, worse
unsupported   code rejected, OR script integrity < 0.8, OR cer > 0.6
```

Two additions beyond the research doc: a **script-integrity check** (fraction of output
characters in the language's expected Unicode block) that catches the Groq romanization failure
which CER only catches by accident, and a **bootstrap CI** — at n=30 the interval is wide,
which is the honest mechanical reason `verified` also requires human sign-off. The harness can
award beta and experimental on its own; **it can never award verified.**

The five non-FLEURS Google languages (Sinhala, Basque, Albanian, Sundanese, Aromanian) get
`experimental — no eval set` as a first-class case, plus `thibi eval asr --manifest ./local.tsv`
taking a hand-built file in the same 7-column format. That same door serves the strategically
interesting case: 30 transcribed Shan or Sgaw Karen clips enter the harness unchanged.

**LLM evals need zero audio** — TSVs only, so they're nearly free and belong in CI on every
prompt change:

- `thibi eval cleanup` — input `transcription` (lowercased, unpunctuated), reference
  `raw_transcription`, arms = `{do-nothing control} × {current, restraint} × {models}`.
  Metrics: CER **with punctuation retained**, `length_delta`, and **`entity_drift`** (Latin-script
  tokens and digit strings added/removed/changed) — the metric that actually catches
  `UN → Wọ́n` and the Pashto "global warming" insertion, which raw CER under-weights relative
  to how badly they damage a quote. **Exit non-zero if any language's prompt CER exceeds its
  control.** Wire into CI and the regression cannot come back.
- `thibi eval translate --target en` — chrF2 against the joined `en_us` reference, with two
  controls: English→English as the ceiling (87.0) and Burmese as the shipping bar (65.6).
  Reproduces "cleanup wants restraint, translation wants capability" as a table.

Caching: TSVs by blob oid, wavs by filename, **every provider and LLM response** by
`sha256(provider|model|lang|clipHash|paramsHash)`. Re-running is free unless something changed
— which is what makes iterating a prompt across 15 languages tolerable. `--dry-run` prints
estimated spend and `--budget-usd` refuses to exceed it. Every invocation writes
`results/runs/<runId>.jsonl` so reports recompute without re-calling anything.

Outputs: `results/tiers.json` (imported by the registry at build time), a dated ASR report with
**tier changes since last run at the top**, and a dated LLM report in the same shape as the
research doc's table. `/settings/languages` renders `tiers.json` directly, so the warning a
journalist sees in the picker traces to a number they can click.

---

## LLM layer

Gateway over Anthropic / OpenAI / OpenRouter via the Vercel AI SDK (`ai` +
`@ai-sdk/anthropic|openai` + `@openrouter/ai-sdk-provider`) — runs fine in plain Node with no
framework coupling, and `generateObject` normalizes the genuinely divergent structured-output
mechanisms that the current Anthropic-specific `output_config` call
(`lib/postprocess/run.ts:85`) hardcodes. Model per pass from `model_profiles`.

**Keep the idx-keyed batch matching from `lib/postprocess/run.ts:113-120` verbatim in spirit** —
results matched by `idx`, never by array position, so a short or reordered response updates only
what it covered. That is the single most important safety property in the existing file.

Passes:

- **cleanup** — *prompt rewritten, not ported.* Punctuation, capitalisation and whitespace
  only; explicitly forbid changes to spelling, grammar, word choice and names. The current
  clause "fix obvious spelling and Unicode normalization errors" is the measured cause of the
  damage. Default to a **small** model; the eval showed restraint beats capability here.
- **translate** — target parameterized, glossary lexicon injected, `do_not_translate` honoured.
  Frontier model by default. **Cap targets per run** (4); a 3-hour file × each extra language is
  a 30k-row insert and a proportional bill.
- **entities** — constrained substitution against the glossary only. Never freeform. Given
  spike S1's risk, this is the *primary* entity mechanism, not a supplement.
- **document** — summary, chapters with timecodes, speaker-attributed quotes carrying
  `segmentIds`.

---

## Infrastructure

One Node image, two commands (`web`, `worker`), so the engine version in the worker always
matches what the UI thinks it's talking to. ffmpeg, ffprobe and yt-dlp baked in.

```
caddy       TLS + /s3/* → minio (same-origin presigned URLs: no CORS, no second cert)
postgres:17 healthcheck pg_isready
minio       + minio-init one-shot (bucket, lifecycle on scratch/)
migrate     one-shot, everything depends_on service_completed_successfully
web         Next.js
worker      media, asr.cloud, asr.poll, editorial, export, maintenance — concurrency 6
worker-heavy diarize, asl.local — concurrency 1
sidecar     [profile] pyannote + faster-whisper, one Python image, shared hf-cache volume
backup      [profile] nightly cron
```

GPU stanzas go in `compose.gpu.yml` (Linux-only, differ per service, not a profile). A `./thibi`
wrapper reads `PROFILES=` and `GPU=` from `.env` and assembles the flags, because assembling
`-f` and `--profile` by hand is exactly what a non-sysadmin gets wrong.

**First run must be one question.** `./thibi init` generates all passwords and
`APP_SECRET_KEY`, asks only for the public URL, then `./thibi up -d` prints a `/setup` link and
a setup token. Everything else — provider keys, per-pass models, retention, users — is done in
the browser. Any flow that forces an admin back into `.env` to add a key is a design failure.

**Resource honesty, stated in the docs:** cloud ASR 8-way does 1 h of audio in 2-4 min. CPU
Whisper `large-v3` int8 on 8 cores is 1-2× realtime — a 1-hour interview takes 30-60 minutes;
show the realtime factor in the model picker. Default to **`large-v3`**, not `distil-large-v3`
— distil-whisper is an English-only distillation and would be the worst possible default for a
product built around 44 non-English languages. Use `distil-large-v3` for English only, and
offer `large-v3-turbo` behind a "prefer speed" setting. **pyannote on
CPU is 0.56–0.61× realtime — a 1-hour file is about 1 h 40 m** *(measured, spike S6 2026-08-10; this
read "0.15-0.4× realtime — 2.5-7 hours" and had never been measured)*. That is why diarization
is `worker-heavy` at concurrency 1, why it never gates the transcript, and why the UI must show
an estimate before you start. GPU:
both models fit comfortably in 12 GB. Tiers: small 2 vCPU/4 GB (cloud only), medium 8/16
(CPU local models), fast 8/24 + one 12 GB GPU.

**GCS is not a second object store** — it is the Google provider's wire format, structurally
the same as today's `data/chunks/`. One prefix, `gs://…/thibi-staging/<runId>/`, read by
nothing else, eager-deleted on completion with a 1-day lifecycle as backstop. The engine
asserts that lifecycle rule at first use and refuses to stage if it can't, printing the
`gsutil lifecycle set` command. `GOOGLE_GCS_STAGING_BUCKET` is **optional**; unset means long
files chunk instead. The setup wizard should state the $48-vs-$9 arithmetic so an admin can
decide whether the extra step is worth it.

**Secrets: AES-256-GCM in Postgres, key from `APP_SECRET_KEY`.** With the threat model in the
README verbatim: *this protects you if a database backup leaks — the realistic failure, since
`pg_dump` output ends up in Dropbox. It does not protect you from someone with root on the
host.* AAD-bind each ciphertext to its key name so a row can't be moved to exfiltrate it. Keep
`lib/settings.ts`'s precedence and masking logic; add a read-only "set in .env" badge instead
of an empty-looking field that silently gets overridden, and a `hint` column showing
`sk-ant-…4f2a`. `thibi secrets rotate` with `APP_SECRET_KEY_OLD`. Not Vault — that is the line.

**Auth: sessions in Postgres, not JWT.** On a single instance JWT's statelessness buys nothing
while an admin disabling a compromised account expects it dead *now*. `sha256(token)` stored,
never the token. `@node-rs/argon2` (prebuilt binaries, no compiler in the image). No auth
framework — Lucia is deprecated, Auth.js configured for credentials-only is more config than
code. Next 16 uses **`proxy.ts`**, not `middleware.ts`, and it does a **cookie-presence check
only** — it is a redirect optimisation, never an authorization boundary (CVE-2025-29927). The
real gate is `requireUser()`/`requireAdmin()` wrapped in React `cache()`, plus an `action()`
wrapper on every server action (they are publicly-callable POST endpoints) enforced by a lint
rule. `/setup` requires a setup token *and* zero users under `LOCK TABLE users` — otherwise
whoever port-scans the VPS first becomes admin. Rate-limit login per username and per IP.

**Progress: `run_events` (bigserial) + Postgres LISTEN/NOTIFY → SSE with `Last-Event-ID`
replay.** NOTIFY is the doorbell, not the transport (8 KB cap, dropped if nobody listens, no
replay). Insert the event and `pg_notify` in the same transaction so a listener never sees an
event before its data. One dedicated `pg.Client` per web process fans out through an
`EventEmitter` — the same shape as today's `runEvents()`, just fed from Postgres. Keep the 15 s
heartbeat; add a 10 s flush backstop and **`X-Accel-Buffering: no`**, without which Caddy
buffers the stream and progress appears frozen. Coalesce worker emissions to ≤1 per run per
500 ms. Simpler fallback if it fights back: 2-second polling, which is genuinely fine at this
scale.

**Audio: presigned GET, 15-minute TTL, minted by an authenticated route.** Proxying every byte
through Next.js ties up the event loop for the length of an editor scrubbing a 90-minute
interview. The gotcha: SigV4 signs `Host`, so you need **two S3 clients** — `s3` at
`http://minio:9000` for server-side I/O, `s3Public` at `${PUBLIC_URL}/s3` for signing only.
Caddy's `handle_path /s3/*` makes MinIO same-origin. Verify with `curl -r 0-1023` on day one;
this fails silently as `SignatureDoesNotMatch`. Log every access (`media_access_log`) — "who
listened to the source recording" is a question newsrooms get asked. Keep a
`MEDIA_SERVING=proxy` mode reusing the existing Range handler with `GetObjectCommand` for
newsrooms whose lawyer requires it.

**Backup order matters: DB first, then objects.** Object rows are written after the upload, so
a DB-first snapshot can only reference objects that exist; the reverse produces dangling media.
`thibi backup` warns loudly that `APP_SECRET_KEY` is **not** in the backup and must be stored
separately, and `thibi restore` probes decryption immediately so a lost key is discovered
during a drill rather than an incident.

**Logging:** pino JSON to stdout with `run_id`/`step_id`/`user_id` via `AsyncLocalStorage`, and
redaction paths. No Loki/Grafana — three containers nobody will maintain, to answer questions
that `/admin/queue` and `/runs/:id/timeline` already answer.

**Retention: configurable, off by default.** `retention_audio_days`, a *separate*
`retention_transcript_days` defaulting to never, `media.legal_hold` exempt from all sweeps, and
a **dry-run in the UI** ("this policy would delete 34 recordings totalling 8.2 GB tonight")
before the first sweep. Deleting audio keeps the row with `deleted_at` and a reason so the
transcript page says "source audio deleted per policy on 2026-05-01" rather than showing a
broken player. Note that bucket versioning and "shred now" conflict; make versioning a
documented config choice.

---

## v1 UI

Next.js 16 App Router, Tailwind v4, **shadcn/ui** (the original plan specified it and never
used it; Dialog, Popover, Command, Select, Tabs, Toast are where v1 saves the most code).

```
/(auth)/login
/                      job list + quick upload                ports app/page.tsx
/jobs/new              tabs: File | Batch | From URL
/jobs/[id]             the editor                             ports job-detail.tsx
/glossaries, /glossaries/[id]
/settings/{providers,models,languages,users,retention}
/admin/{queue,system}
```

**Language picker** — shadcn `Command` in a `Popover`; 107 languages needs search, a `<select>`
does not work. Rows show endonym + English name + sample glyph + tier pill + the provider that
will be used. Grouped verified/beta/experimental with a recently-used group on top. Tier pills
are green-outline / amber / dotted-grey — **never red**; these are honest quality statements,
not errors. Choosing beta never blocks; it reveals an inline note citing the actual number:
*"Beta — CER 0.15 on 30 FLEURS clips, 1.6× our Burmese baseline. Expect to correct more than
usual."* Experimental adds a **"Try 2 minutes first"** button — the existing run path with
`--max-duration 120`, and the highest-value affordance in the product for the long tail.
Autodetect exists, off by default, restricted to verified+beta (autodetect is where Groq
produced romanized Burmese).

**Segment editor.** `job-detail.tsx` at 572 lines is at its ceiling; words + speakers + layers
would triple it. Decompose into `editor-shell`, `audio-dock`, `run-tabs`, `run-toolbar`,
`segment-list`, `segment-row`, `segment-text`, `speaker-chip`, plus `use-playback`,
`use-run-stream`, `use-segment-mutations`.

Port verbatim — these are good and hard-won: `AutoGrowTextarea` (the `useLayoutEffect` +
window-resize reasoning is correct), `ConfirmRunDialog` (extend the estimate to cover LLM
passes), the SSE effect, `formatClock`, `STATUS_STYLES`, the run-tab strip, the sticky player.

Four things must change on the way over:

1. **Playback sync will not scale.** `onTimeUpdate → setCurrentTime` re-renders every segment
   ~4×/s. Keep time in a ref; publish only *active segment id* and *active word index* via
   `useSyncExternalStore`. Word highlighting needs `requestAnimationFrame`; `timeupdate` is too
   coarse.
2. **Virtualize** with `@tanstack/react-virtual` + `measureElement`. 90 minutes is 800-1500
   auto-sizing textareas. The virtualizer/AutoGrowTextarea interaction is the trickiest piece
   of UI engineering in v1 — budget for it.
3. **Drop the remount trick.** `key={id-text}` forces a remount per save and loses the caret;
   with optimistic updates it becomes a visible jump. Sync via ref.
4. Segment PATCH has no concurrency protection today; with multiple users it will silently lose
   edits. Add an `updated_at` precondition from day one.

**Low-confidence marks** as a dotted underline with `text-decoration-color` scaled by
confidence — not a background, which fights the active-segment highlight and complex-script
rendering. Toolbar: "38 uncertain words", `Alt+↓` to jump, threshold default 0.6. Show marks
only when the row is unfocused (the read-only span swaps in for the textarea on blur), which
sidesteps the positioned-overlay-under-a-textarea problem entirely.

**Layers** as a segmented control `Verbatim | Cleaned | Translated` + "show original
alongside" — one primary editable layer and at most one muted reference. Stacking all three,
as today, is unreadable past a few hundred segments.

**Keyboard** is where transcript correction is won: `Tab`/`Shift+Tab` between segments,
`Ctrl+Space` play/pause without leaving the textarea, `Ctrl+Enter` commit-and-advance,
`Alt+↑/↓` prev/next uncertain, `Ctrl+1..3` layer, `?` for the sheet.

**Speakers.** Chip → popover: rename globally (one PATCH on the `speakers` row — the reason
speakers are a table), reassign this segment, or **"this and all following until the next
speaker change"** (pyannote errors come in runs, not singletons — one click instead of twenty).
A toolbar "Speakers (4)" dialog handles merge, the most common correction after
over-segmentation. 8-colour categorical ramp on the chip and a 2px left border only.

**Glossary.** Plain editable table — source, preferred form, also-written-as chips, type,
notes — with inline add-row and CSV import/export. The one feature worth building beyond CRUD:
**"Add to glossary" from the editor** — select text → floating button → prefilled dialog.
Newsroom glossaries only get maintained while someone is correcting a transcript; as a separate
chore they rot.

**Multi-script rendering.** Replace `.font-myanmar` with a registry-driven `data-script`
attribute. Declare each Noto family statically in `app/fonts.ts` (`next/font/google` requires
literal module-scope args) with **`preload: false`** and `display: 'swap'` — that emits the
`@font-face` CSS but no preload link, so the browser fetches a woff2 **only when a glyph
matched by that family actually renders**. Fifteen families cost ~6-10 KB of CSS and a Hausa
job downloads zero non-Latin font files. Self-hosted from `/_next/static/media`, which matters
for air-gapped newsrooms. Per-script line-height is not cosmetic — Myanmar, Khmer and Sinhala
stack diacritics vertically and clip at 1.5, which is already why the existing rule sets 1.9. A
`<ScriptedText script dir lang>` component sets all three attributes; **`lang` is missing
entirely today** and it matters for font selection. Exclude CJK.

**RTL in v1:** `dir="rtl"` + `lang` on the text container and textarea; **do not flip the app
chrome** — UI stays LTR, only transcript content is RTL, which is what bilingual editors expect
and avoids a full logical-properties migration. Timecode gutter stays left. Caret and selection
are native once `dir` is set. `unicode-bidi: plaintext` on the reference line so an English
translation under Pashto renders LTR. **Exports are the real work:** SRT/VTT carry no
direction, so a Pashto cue beginning with a Latin acronym renders backwards. Wrap RTL cues in
U+2067 RLI … U+2069 PDI with trailing-punctuation handling, in `packages/core/src/export/bidi.ts`
with fixtures, and offer isolate-marks (default) / RLM-prefix / none since some players ignore
isolates. DOCX sets `w:bidi` + run `rtl` (the `docx` package supports `bidirectional: true`).
Deferred: RTL chrome, Eastern-Arabic numeral preference, deep shaping QA.

**Batch** shares one language + provider selection with a per-row override available but not
prominent — twenty individual pickers is the failure mode. **URL import** resolves metadata
first, then confirms cost with real numbers, and **never auto-starts** — duration is unknown
until metadata returns, and that is precisely when a surprise bill happens.

**Settings.** `/models` gets a row per pass with a "test on 3 segments" button, defaults seeded
with the research in the help text (small model for cleanup, frontier for translate, one
sentence saying why, linked to the eval report) and the cleanup prompt shown read-only with a
version label — an operator who can see the prompt is one who can report when it misbehaves.
`/languages` renders `tiers.json` with enable/disable toggles; without it a 107-language picker
is unusable for a newsroom that works in three. `/users` invites via generated link (no SMTP on
a self-hosted box).

### Deliberately cut from v1

Word-level *editing* (forced realignment; multi-week on its own — store word timings, show
confidence, edit at segment granularity). Run-vs-run diff. Document-pass editing UI (ship a
read-only panel with copy buttons). Per-file language in batch. Waveform visualisation.
Collaborative editing (ship `locked_by` + a banner). Custom export templates. Real-time
streaming. Multi-tenant/SSO/billing. Speaker voice-prints across files. Video preview and
burned-in subtitles. Mobile layout. CJK.

---

## Build order

Each phase ends in something demonstrable, and the risky parts come early. Each row links to
its detailed execution plan.

| # | Phase | Ends with |
|---|---|---|
| 0 | [Spikes S1-S3 + language & script registries](./phase-00-spikes-and-registries.md) | `thibi lang list --tier verified`; three answered questions |
| 1 | [Engine core, Google sync, Postgres/MinIO ports, CLI](./phase-01-engine-core.md) | `thibi transcribe f.m4a --lang my` → JSON with word timings |
| 2 | [**RISK** batchRecognize + GCS staging](./phase-02-batch-recognize.md) | `thibi transcribe 2hr.mp3 --mode batch`; **done** — there is no duration threshold, batch is opt-in only, and the 5.33x rate advantage that justifies it is confirmed |
| 3 | [**RISK** pyannote sidecar + reconciliation](./phase-03-diarization.md) | `thibi transcribe interview.wav --diarize`; reconcile unit-tested on synthetic fixtures |
| 4 | [**RISK** faster-whisper + OpenAI + Groq providers](./phase-04-whisper-providers.md) | `thibi transcribe --provider faster-whisper` |
| 5 | [Eval harness](./phase-05-eval-harness.md) | `thibi eval asr/cleanup/translate`; `tiers.json`; CI gate on the cleanup control |
| 6 | [LLM passes (cleanup, translate, entities, document)](./phase-06-llm-passes.md) | `thibi pass cleanup <run>`; measured better than do-nothing |
| 7 | [Export + subtitle reflow + bidi + docx](./phase-07-export.md) | `thibi export <run> --format srt --layer translated --lang en` |
| 8 | [Ingest: batch + yt-dlp](./phase-08-ingest.md) | `thibi ingest --url`, `thibi ingest ./dir` |
| 9 | [pg-boss queue, worker, reconciler, SSE](./phase-09-queue-and-worker.md) | Kill the worker mid-run; it resumes |
| 10 | [Auth, users, settings, secrets](./phase-10-auth-and-settings.md) | `/setup` → admin → provider keys in the browser |
| 11 | [UI: shell, upload, job list, language picker](./phase-11-ui-shell.md) | Upload → run → watch progress |
| 12 | [UI: segment editor (virtualized, layers, confidence)](./phase-12-ui-editor.md) | Edit a 90-min transcript without lag |
| 13 | [UI: speakers, glossary, export dialog](./phase-13-ui-speakers-glossary.md) | Rename a speaker; add a term from the editor |
| 14 | [UI: settings/admin, retention, spend](./phase-14-ui-settings-admin.md) | An admin configures the instance without a terminal |
| 15 | [Compose, Caddy, `./thibi` wrapper, backup/restore, docs](./phase-15-deployment.md) | `./thibi init && ./thibi up -d` on a clean VPS |

Phases 1-9 are the engine and are fully exercised by the CLI. That is what "engine first,
simple UX" means here.

---

## Verification

**Per phase**
- `packages/core` metrics asserted against frozen `jiwer`/`sacrebleu` parity fixtures in CI.
- `reconcile.ts` unit-tested on synthetic fixtures: overlapping turns, a turn shorter than a
  word, gaps, single-word flicker, genuine one-word interjections, `has_words = false`,
  re-diarization identity preservation.
- Chunk overlap de-dup tested on a file with a known mid-word seam.
- Provider adapters tested against recorded fixtures; a live smoke test per provider behind a
  flag.

**End to end, on real audio**
1. `./thibi init && ./thibi up -d` on a clean machine → `/setup` → admin → paste Google SA JSON
   → Test connection passes.
2. Upload a known Burmese file. Confirm the CER matches the harness baseline — this is the
   regression guard on the whole pipeline.
3. Upload a 2-hour multi-speaker interview. Confirm: batch route chosen, diarization produces
   sensible turns, speaker rename propagates, export contains speaker labels.
4. Kill `worker` mid-`batchRecognize`; `docker compose up -d`. Confirm ASR is **not** repeated,
   the poll resumes, and the browser's SSE replays from `Last-Event-ID`.
5. Run one job per script class — Latin (Hausa), Ethiopic (Amharic), Khmer, RTL (Pashto) —
   and check rendering, line-height, direction, and SRT export in a real player (VLC + a
   browser).
6. `thibi eval cleanup --languages my,yo,ps,so,ha,xh` reproduces the research table and the new
   restraint prompt beats the do-nothing control in every language.
7. `curl -r 0-1023` against a presigned MinIO URL through Caddy; scrub a 90-minute file in the
   editor and watch the network panel for Range requests.
8. `thibi backup` → `thibi restore` into a fresh stack → secrets decrypt → a transcript opens.

**Explicitly measure before claiming**
No language ships as `verified` without a measured CER, a bootstrap CI clear of the beta line,
and a human sign-off. No prompt change merges if it exceeds its do-nothing control.

---

## Open risks

1. ~~**Chirp adaptation (S1).**~~ **Measured 2026-08-09 — it does not work.** Boost 0/10/20
   produced byte-identical output; relevant keyterms produced zero lexical change and did not
   fix a targeted error; an irrelevant phrase set *degraded* five occurrences of a word the
   baseline got right. `chirp_2` is `adaptation: "none"`, the engine must not send
   `config.adaptation` to it, and nothing in the product may promise keyterm biasing on Google.
   The glossary entity-correction pass in Phase 6 is therefore the **only** entity mechanism
   for the exclusive-language set, not a supplement — its priority rises accordingly. Full
   method, numbers and limits in [phase-00-spike-results.md](./phase-00-spike-results.md).
2. **Word timings are the spine of half the design and the least reliable field in the
   response.** Subtitle re-flow, reconciliation, bilingual alignment, overlap de-dup and
   quote-to-audio all assume words exist with usable timings; Chirp can return a transcript
   with an empty word array for long-tail languages. `word_timing_quality` and
   `segments.has_words` are first-class and surfaced in the UI. **Build the no-words path
   first, not last** — otherwise the first Oromo file breaks four features at once.
   **Partially measured 2026-08-09:** all 116 Google codes returned word offsets on a 2-second
   clip, so the long-tail-Google case is less likely than assumed. The path is still built first;
   it also covers `gpt-4o-transcribe`, which returns no timestamps at all. Fallbacks:
   proportional character-count interpolation for re-flow (and say so), segment-interval
   overlap plus mandatory review flag for speakers.
3. **Segment immutability vs. two people in one segment.** ASR endpointing routinely straddles
   a speaker change — the normal case in an interview. The design keeps per-word speakers +
   `speaker_purity` + export-time splitting, but allows **one narrow exception: a human, never
   an LLM or a pipeline stage, may split a segment at an existing word boundary**
   (`split_of`, `superseded_at`). The invariant that matters is "the machine's output is never
   overwritten," and lineage preserves that better than a hard no-split rule.
4. **Scope.** This is a substantial build. If it needs to ship sooner, the honest cut list is:
   hand-roll the queue instead of pg-boss (the `run_steps` state machine is the load-bearing
   part), poll instead of SSE, one worker container instead of two, and `STORAGE_DRIVER=fs`
   instead of MinIO behind the same interface. Do **not** cut encrypted secrets, the eval
   harness, or the restraint prompt.
5. **Carry-over hazards.** `lib/db.ts:70` runs `DELETE FROM runs WHERE provider NOT IN
   ('google')` at every startup — must not survive the port. The `lib/db.ts:63-66` boot sweep
   must not survive either.

---

## Amendments from detailed planning

Findings from writing the per-phase plans that correct or sharpen this document. Each is
argued in full in the phase doc named.

| # | Amendment | Where |
|---|---|---|
| 1 | **`distil-large-v3` was the wrong default** — Distil-Whisper is an English-only distillation, the worst possible default for a product built on 44 non-English languages. `large-v3` default, distil for English only, `large-v3-turbo` behind "prefer speed". Corrected inline above. | [04](./phase-04-whisper-providers.md) |
| 2 | **There is no duration threshold — chunked parallel sync wins at every size.** Measured: batch is a flat 5.9x realtime (305 s / 30 min, 1211 s / 2 h); chunked sync at concurrency 8 is 43 s and 338 s for the same inputs, no 429s across 136 requests. Batch is an admin cost choice, not the long-file path. Also measured: hard cuts lose ~2-3 words per seam (2.1% at 30 min, 3.4% at 2 h), which is the overlap merge's justification; `results[uri].error` can be set while `done: true` and `operation.error` is absent (hit 1 run in 5, transient code 13, unbilled); and sequential chunk cutting is 200 s of the 338 s 2-hour prep. | [00 results](./phase-00-spike-results.md), [02](./phase-02-batch-recognize.md) |
| 3 | **`lib/export.ts:15-22` has a live bug.** `formatTimestamp(59.9996, ",")` → `00:00:59,1000` — a four-digit ms field and malformed SRT; the rounding never carries. The rewrite works in integer ms with a named regression test. | [07](./phase-07-export.md) |
| 4 | **FLEURS TSVs are tab-delimited but CSV-quoted.** `split('\t')` leaves stray quotes in the reference and silently corrupts every CER computed against it. Quote-aware parser + fixture. | [05](./phase-05-eval-harness.md) |
| 5 | **`num_samples` (column 5) gives exact duration**, so `--dry-run` costing needs zero audio downloaded. And the HF blob `oid` is byte-identical to the resolve endpoint's `ETag`, so caching by oid in the filename needs no conditional request. | [05](./phase-05-eval-harness.md) |
| 6 | **Burmese is expected to fail the cleanup gate on first run.** The research prose says the restraint prompt beats the control everywhere, but its own table has Burmese at 0.019 vs a 0.016 control. Five of six clear; Burmese doesn't. The gate believes the table; the cause must be diagnosed and recorded, not waived. | [05](./phase-05-eval-harness.md), [06](./phase-06-llm-passes.md) |
| 7 | **Export-time speaker splitting only works on the verbatim layer.** `cleaned` and `translated` rows are per-segment strings with no word alignment, so an impure segment on a non-verbatim layer is emitted whole and flagged, never attributed to a guessed speaker. | [07](./phase-07-export.md) |
| 8 | **`--match-filter "duration<?14400"` is a footgun** — `<?` *passes* when the field is missing, so it reads as a hard cap and isn't one. The resolver rejects null duration independently. | [08](./phase-08-ingest.md) |
| 9 | **`run_steps.shard` must be `NOT NULL DEFAULT -1`.** `NULL <> NULL` in Postgres means a unique index over a nullable shard deduplicates nothing — the difference between the planner being idempotent and quietly not being. | [09](./phase-09-queue-and-worker.md) |
| 10 | **`run_events` are idempotent state snapshots, not deltas.** `bigserial` allocates before commit, so a reader tracking `seq > last` can skip a row committed out of order. Snapshots make out-of-order delivery harmless. This is a standing constraint on future event kinds. | [09](./phase-09-queue-and-worker.md) |
| 11 | **The entities pass cannot emit text.** Candidates are generated deterministically in TS; the model returns only booleans (its schema has no text field); substitution is an offset splice with an assertion. Given spike S1, this is the primary entity mechanism and it must be auditable. | [06](./phase-06-llm-passes.md) |
| 12 | **Chunk overlap collides with the size budget** — a 55 s plan plus a 1.2 s lead exceeds the cap. Named regression test. | [01](./phase-01-engine-core.md) |
| 13 | **`Intl.Segmenter` verified on Node 22.18 full ICU** for Burmese, Thai, Lao and Khmer. `မင်္ဂလာပါခင်ဗျာ` is 15 code points but 11 graphemes, so CPS counts graphemes — now an explicit registry field, with a capability probe for small-ICU builds. Myanmar falls back to syllables; Thai/Khmer/Lao refuse to guess. | [07](./phase-07-export.md), [11](./phase-11-ui-shell.md) |
| 14 | **Interpolated word timings are computed at read time, never stored** — `is_estimated` rows would poison the low-confidence query and the reconciler. | [01](./phase-01-engine-core.md) |
| 15 | **Model IDs and per-token prices are deliberately not pinned in any plan**; they live in dated seed files (`model-profiles.default.json`, `rates.default.json`). A plan that hardcodes them is stale within a quarter. | [14](./phase-14-ui-settings-admin.md) |
| 16 | **The "44" and "exclusive to Google" are two different numbers** and Phase 0 conflated them. `--provider google --not-supported-by openai` is 44 — the live 2026-08-09 probe reproduces the 2026-07-30 research figure exactly. `--exclusive-to google`, meaning no other provider at all, is 21: the research's 20 plus Burmese, which Groq accepts and mangles and which `matrix-overrides.json` therefore marks unsupported. | [00](./phase-00-spikes-and-registries.md) |
| 17 | **Chirp returned word offsets for all 116 language codes**, measured 2026-08-09 on a 2-second clip. Risk 2 below anticipated an empty word array for long-tail languages; on this clip none occurred, and Chirp transcribes the audio as *something* in whatever language it is asked for rather than returning silence. The no-words path is still built first — one clip on one day is evidence, not proof, and it also covers providers that genuinely lack the field — but Google's long tail is no longer the expected reason it fires. | [00](./phase-00-spikes-and-registries.md) |
| 18 | **Every provider words a language rejection differently and none uses a distinguishing status code** — Google `Bad language code`, OpenAI `Language code 'ha' is not recognized`, Groq `unsupported language: xx`. A pattern that misses one degrades to `error`, which preserves the previous row: the safe direction. Phase 4's provider adapters inherit this table. | [00](./phase-00-spikes-and-registries.md) |
| 19 | **Groq's on-demand tier allows 20 requests per minute**, and probing faster turned 55 of 116 languages into `unknown` rather than data. Any Groq path needs an outbound throttle and `Retry-After`, not just retries. | [00](./phase-00-spikes-and-registries.md), [04](./phase-04-whisper-providers.md) |
| 20 | **Digraphia must be measured by whole sentences, not character share.** Latin runs at 2-5% of a Telugu, Lao, Nepali, Korean or Chinese corpus from acronyms alone; only Serbian has whole sentences in a second script (11 of 199 FLEURS rows). `LanguageEntry.altScripts` records it so the eval harness's script-integrity check cannot fail a correct Cyrillic Serbian transcript. | [00](./phase-00-spikes-and-registries.md), [05](./phase-05-eval-harness.md) |
| 21 | **The Dynamic Batch rate advantage is real — 5.33×, confirmed from the Cloud Billing Catalog** (`Cloud Speech-to-Text Recognition` $0.016/min vs `Cloud Speech-to-Text Dynamic Batch Recognition` $0.003/min, read 2026-08-10). This was the last unverified premise of Phase 2 and, since S3 removed latency as a reason to use batch, its only remaining justification. Two riders: Recognition is *tiered* (0.010 above 500k min/month) so the ratio is a tier property rather than a constant, and there is a `(Logged)` SKU at 25% off that trades the discount for Google retaining the audio — never a default, never a silent cost optimisation, and not seeded. | [02](./phase-02-batch-recognize.md) |
| 22 | **`roles/storage.objectAdmin` does not include `storage.buckets.get`.** Measured on the project's own staging bucket: the service account could write and delete objects (200/204) and got a 403 reading the bucket's location and lifecycle rule. The natural least-privilege grant for a staging bucket therefore fails Phase 2's validation on its first check and makes the retention guarantee unverifiable. The narrow remedy is `roles/storage.legacyBucketReader`; the phase doc's draft said `roles/storage.admin`, which is bad advice that would outlive the problem. Also measured: GCS returns `location` upper-cased (`ASIA-SOUTHEAST1`), so the comparison must fold case. | [02](./phase-02-batch-recognize.md) |
| 23 | **The Speech service agent needs no grant for a same-project staging bucket.** Enabling the Speech API creates a project-level `roles/speech.serviceAgent` binding that already covers it — which is why spike S3 succeeded with the agent absent from the bucket's own IAM policy. Phase 2 predicted this as the second-most-common first-run failure; it is a cross-project hazard only, and the error hint is worded accordingly. | [02](./phase-02-batch-recognize.md), [15](./phase-15-deployment.md) |
| 24 | **`norm_16k_mono_flac` had never produced 16 kHz.** `loudnorm` resamples internally to 192 kHz and emits at its own rate, so the `aresample=16000` in front of it was silently discarded. Nothing failed — Google accepts 192 kHz FLAC and transcribes it correctly — and it survived Phase 1 and every sync run since. Found in Phase 2 by a number that looked too big: 20 minutes normalizing to 136 MB. A trailing `aresample=16000` makes it 22.7 MB, **6.0× smaller**, which changes every sync chunk, every staged upload, and the byte budget the chunk planner works against. Downstream: the derivative is **~68 MB per audio-hour**, not the ~30 MB Phase 15 assumed and not the ~110 KB/s Phase 4 assumed (that figure is within 3% of the *buggy* output). | [01](./phase-01-engine-core.md), [03](./phase-03-diarization.md), [04](./phase-04-whisper-providers.md), [15](./phase-15-deployment.md) |
| 25 | **`rates` and `usage_records` shipped in Phase 2, not Phase 14.** Phase 2's only justification is a price difference, so it needed the ledger. Phase 14 reconciles rather than rebuilds: migration `0001_spend.sql` is applied, the seed is `packages/db/src/seed/rates.ts`, the units are **`minute` and `batch_minute`** (two SKUs, not one `audio_minute`), there is a `*` model wildcard row per provider, and `resolveRate` returns **null** rather than 0 when nothing matches. | [02](./phase-02-batch-recognize.md), [08](./phase-08-ingest.md), [14](./phase-14-ui-settings-admin.md) |
| 26 | **`metadata.progressPercent` is populated on batch operations** — 26/52/78 across thirteen polls, measured 2026-08-10. Phase 2's risk 3 assumed it might always be absent and designed an elapsed-time fallback; the UI can show a real bar. It is still only read when actually sent. Batch latency is **4.65× realtime** (258 s for 1200 s of audio), consistent with S3's 5.9×, and every batch run now records its own into `runs.pipeline.batch.latencyMs`. | [09](./phase-09-queue-and-worker.md), [11](./phase-11-ui-shell.md), [15](./phase-15-deployment.md) |
| 27 | **`runs.pipeline` is no longer only a specification and every writer must merge.** Phase 2 added runtime keys beside the DAG spec (`planReason`, and `batch` holding the whole `BatchOp`, its latency and its poll count). `persistResult` did `SET pipeline = $4` and silently deleted all of it; found by querying `pipeline->'batch'` after the first successful live run and getting null. `||` to merge, `jsonb_set` for a nested key, never a bare assignment. | [09](./phase-09-queue-and-worker.md) |
| 28 | **The Whisper HTTP `words[]` array leaks backwards across contiguous segment boundaries** if re-attached with a symmetric tolerance and first-match-wins. Real `verbose_json` segments abut exactly — one recorded response has segment 1 ending and segment 2 beginning at the identical float, with a word starting on it — so a 20 ms tolerance on both edges makes neighbours overlap and the later segment gets no words at all, degrading `wordTimingQuality` from `full` to `partial` at every boundary. Fix is two passes: strict containment first, tolerance only for words no segment contains. Hand-written fixtures with round numbers cannot expose this. | [04](./phase-04-whisper-providers.md) |
| 29 | **Phase 4's hallucination guard could never have fired.** `no_speech_prob > 0.6 && text.trim().length < 3` is stated in the same sentence as the phrase it exists to drop — "Thank you.", ten characters. `no_speech_prob` is the detector and length is only the safety rail; the cap is now 30 characters, both conditions still required, with a test that a genuine "Yes." at low `no_speech_prob` survives. | [04](./phase-04-whisper-providers.md) |
| 30 | **Groq's Burmese failure is broader and stranger than recorded, and it is not one failure mode.** Re-measured 2026-08-11 on the committed 2 s probe clip: `language=my` returned **Khmer script**, autodetect returned **Vietnamese** (and said so in `language`), and the same clip through the normalizer produced a **repetition loop — 96 words spanning 30.4 s for 2 s of audio** with `duration: 2` and a single segment ending at 2 s. All HTTP 200, all with `avg_logprob` ≈ −0.6 and `no_speech_prob` ≈ 0.05, i.e. numerically indistinguishable from the correct English control. Consequence for the metric: script integrity catches wrong-alphabet output but not wrong-words-right-alphabet, so it is a screen and never a guarantee. | [04](./phase-04-whisper-providers.md), [05](./phase-05-eval-harness.md) |
| 31 | **Amendment 19's "20 rpm" is not the shape Groq rate-limits on.** Live response headers, 2026-08-11: `x-ratelimit-limit-requests: 2000` with a 43.2 s reset per request — a **daily** bucket, 86400/2000 — and `x-ratelimit-limit-audio-seconds: 7200`, i.e. **two hours of audio per hour of wall clock**, which is what will actually bite a Phase 5 sweep. GroqCloud's docs list 300 RPM / 200k ASH for a different tier. `ProviderCapabilities.limits.rpm` cannot express either bucket; all three figures are recorded in `groq.ts` so Phase 9's token bucket is designed against the real shape. OpenAI, by contrast, really is per-minute: 5000 RPM with a 12 ms reset. | [04](./phase-04-whisper-providers.md), [09](./phase-09-queue-and-worker.md) |
| 32 | **The plan's "mark unmeasured Groq codes `supported: false, evidence: assumed`" is refused, and the refusal is Phase 0 doctrine.** `matrix-overrides.json` already says marking a family unsupported on a hunch is the same error as marking it supported on a status code. Phase 4 instead widened `verdict: "suspected"` from 5 codes to all **24 that Groq accepts and no OpenAI model does** — the set the measured failure came from — leaving `supported` alone, warning in the picker, and never letting a suspected row outrank a settled one. Phase 5 promotes or demotes each with a number attached. | [04](./phase-04-whisper-providers.md), [05](./phase-05-eval-harness.md) |
| 33 | **Amendment 24's 18.9 KB/s corroborates on a second, unrelated clip: 20.8 KB/s.** So the 25 MB OpenAI cap binds at ~22 minutes, not the ~230 s Phase 4 assumed, and the sync chunk duration stops being a consequence of the byte budget and becomes a **choice**. Chosen: 600 s, for a lost chunk costing ten minutes rather than twenty-two, six chunks an hour for four concurrent requests to work on, and headroom to twice the measured density inside 25 MB. | [04](./phase-04-whisper-providers.md) |
| 34 | **OpenAI ships `gpt-4o-transcribe-diarize` with a `diarized_json` response format** (docs read 2026-08-11). Phase 3 assumes diarization means the pyannote sidecar and its 1 h 40 m CPU cost; a hosted diarizing ASR is a `DiarizationSource` that did not exist when Phase 3 was written. Unmeasured — no language coverage, no quality, no price checked — but it has to be probed before Phase 3 commits to the sidecar being the only path. **Probed 2026-08-11 as spike S7; amendment 35 is the answer.** | [03](./phase-03-diarization.md), [04](./phase-04-whisper-providers.md) |
| 35 | **Amendment 34 is closed: `gpt-4o-transcribe-diarize` is not a `DiarizationSource` for this product, and Phase 3 is unchanged.** S7 measured it rather than reading about it. Its speaker attribution is good — **0% confusion and 63 ms median boundary error** against a constructed 2-speaker reference — and everything around it disqualifies it here: `language=my` is rejected outright; **39 of the 116 seeded locales have no code the endpoint accepts** (142 codes probed, one request each); `mya` *is* accepted and **20 identical requests returned 20 different transcripts, none in Myanmar script**; a hard **1400 s duration ceiling**; and **no word timings at any granularity**, which permanently confines it to the `intervalFallback` path. Cost is ~$1.00–1.25/audio-hour against Google's $0.96. The failure is specific to the long tail, so this is FAIL *for this product*, not a general verdict. | [03](./phase-03-diarization.md), [S7](../spikes/RESULTS.md#s7--is-a-hosted-diarizing-asr-an-alternative-to-running-pyannote-ourselves) |
| 36 | **Acceptance and support are different things, and S7 is the sharpest case yet.** Phase 4a found Groq returning a *consistently* wrong-language transcript at HTTP 200, which a script-integrity screen catches once and can then be trusted. `gpt-4o-transcribe-diarize` on `language=mya` is worse: 1 request in 21 came back in correct Myanmar script and the other 20 did not, so **a single probe is a coin flip presented as a measurement**. Any future language-support claim must be based on repeated sampling, and `spikes/s7-mya-stability.mjs` is the shape that does it. | [05](./phase-05-eval-harness.md), [S7](../spikes/RESULTS.md#s7--is-a-hosted-diarizing-asr-an-alternative-to-running-pyannote-ourselves) |
| 37 | **Phase 3's §4 `alter table` block is stale — Phase 1 already shipped the columns.** `segments.speaker_id`, `speaker_purity`, `needs_speaker_review` and `words.speaker_id` are in `0000_init.sql`, carrying a `-- FK added in Phase 3` note, and `create index on words (segment_id, idx)` exists as the unique `words_segment_idx`. `0003_speakers.sql` therefore adds three tables, two foreign keys and one partial index, not five columns. The FKs are `on delete set null`: deleting a speaker must orphan the attribution, never the transcript. | [03](./phase-03-diarization.md) |
| 38 | **Phase 3's `idempotency_key` cannot be a `run_step_id`, because `run_steps` does not exist until Phase 9.** The plan's §1 contract names it as one throughout. The key is instead derived — `diarizeStepKey(runId)` returns `` `${runId}:diarize` `` — which preserves the property the sidecar's `task_id = uuid5(NAMESPACE_URL, key)` was designed for: reconstructible without having stored the 202 response, so a lost response is recoverable by GET alone. One diarization per run, so the run id determines it. When Phase 9 adds `run_steps`, the step id becomes the key and nothing else moves. | [03](./phase-03-diarization.md), [09](./phase-09-queue-and-worker.md) |
| 39 | **A merge must retire a speaker from identity matching, which §3 step 5 does not say.** The plan has `is_merged_into` on the table and "unmatched prior speakers are kept, never deleted", and those two together are a trap: a merged-away row keeps the attributed time the next Hungarian match runs against, so the next diarization matches the same acoustic cluster straight back onto the row a human just retired and the split reappears. `persistDiarization` filters `is_merged_into is null` from the prior set, and `mergeSpeakers` repoints segments, words and turns to the target first. A test fails if the filter is dropped. | [03](./phase-03-diarization.md) |
| 40 | **Durable speaker keys are allocated past the job's high-water mark, never into gaps.** Not in the plan, which only says `speakers` is scoped to the job. `speaker-03` is printed in exports and typed into `thibi speakers rename`, so it must never denote two different people across two runs of one recording. `allocateSpeakerKeys` continues past the highest `speaker-NN` the job has ever used, and orders a first run by who speaks first. | [03](./phase-03-diarization.md) |
| 41 | **A sixth database-backed suite pushed an existing 2 s test past vitest's 5 s default — and the obvious fix does not work.** Measured 2026-08-11 adding `diarize/persist.test.ts`: `speakers.test.ts > answers the review query from the partial index` takes 2.0 s standalone and over 5 s inside the 40-file run. It asserts a *query plan*; the clock was measuring contention. **`testTimeout` and `hookTimeout` set at the root of `vitest.config.ts` are silently ignored once `test.projects` is used** — proved by setting both to 1 ms and watching every suite pass. Two sessions raised them there believing otherwise, and one reported it verified on a run that happened to be fast enough. The timeouts belong on the individual hook or test. | [03](./phase-03-diarization.md) |
| 42 | **pyannote 4.x returns `DiarizeOutput`, not `Annotation`, and the field to read is `speaker_diarization`.** Measured 2026-08-11 on the first real run: `'DiarizeOutput' object has no attribute 'itertracks'`, after 30 green tests against a canned pipeline returning the 3.x shape. `exclusive_speaker_diarization` sits beside it as pyannote's overlap-free convenience view — taking it would silently discard the same-speaker overlap `reconcile.ts` is built to accumulate and make `overlapAware: true` a lie. Duck-typed rather than version-gated; the fixture now returns the 4.x shape and puts a sentinel in the wrong field. | [03](./phase-03-diarization.md), [S8](../spikes/RESULTS.md#s8--is-our-own-diarizer-any-good-and-what-does-the-container-cost) |
| 43 | **A presigned URL is signed for the host that minted it, and nothing configures an *internal* signing endpoint.** SigV4 signs `Host`, so a URL minted by a CLI on the developer's laptop against `localhost:9000` is rejected **403** when the sidecar fetches it as `minio:9000`. Phase 3 §1 assumed the engine runs inside compose. `S3ObjectStore` already has a `signingClient` seam but its doc and every caller point it the *other* way — at the public URL through Caddy for Phase 10. There are two presign audiences, not one, and `apps/cli/src/context.ts` sets neither. | [03](./phase-03-diarization.md), [10](./phase-10-auth-and-settings.md) |
| 44 | **pyannote's progress goes backwards.** `ProgressHook` reports `completed`/`total` per *stage* and restarts at each one — measured 0%, 100%, 0%, 33%, 67%, 100% on one run. A percentage running backwards tells an operator the job restarted. No honest overall figure is available, since the stage list and its relative costs are not known in advance, so `progress` is documented as within-step and `TaskStatus` gained a `step` name beside it. | [03](./phase-03-diarization.md) |
| 45 | **Identity matching had never run with a non-empty prior, through any path a user has.** `persist.ts` read prior attribution with `and s.run_id <> $2`, excluding the run being diarized — correct for a *new* run of a job, and fatal for `thibi diarize run <runId>`, which re-diarizes in place and is the only CLI path that reaches the matcher at all. Measured through the CLI 2026-08-12: a rename to "Daw Khin" survived on `speaker-01` holding **0 segments and 0 words** while fresh `speaker-02`/`speaker-03` took every word — a name orphaned in place, which is worse than one lost because the speakers list still shows it. The unit test was green because it built a **new** run each time. The exclusion is removed; prior attribution is read across all runs of the job, before anything writes. | [03](./phase-03-diarization.md) |
| 46 | **`thibi transcribe` mints a fresh job for a byte-identical file, so Phase 3's Verification sequence cannot work as written.** The plan says to rename a speaker and then re-run `thibi transcribe … --diarize` as "# new run". It is a new *job*: the `media_assets` row is deduped by sha256, the `jobs` row is not, so the second run's speakers live somewhere the rename never touched. The demo that does work is `thibi diarize run <runId>`, and the plan's Verification is corrected to it. Whether `transcribe` should take a `--job <id>` is open. | [03](./phase-03-diarization.md), [08](./phase-08-ingest.md) |

### Open decisions, surfaced not assumed

- **Viewer role** — a third role that can read and export but not start runs (starting a run is
  the only action that spends money). Recommendation: ship the `CHECK` constraint permitting it,
  implement on request. ([10](./phase-10-auth-and-settings.md))
- **Editorial passes on the run DAG** vs a separate DAG per `editorial_passes` row. Unified is
  one timeline; separate is cleaner for re-runs but doubles the reconciler. Revisit before
  Phase 12. ([09](./phase-09-queue-and-worker.md))
- **Bidi trailing punctuation** defaults to `inside` (correct Pashto typography under UAX #9);
  `outside` is implemented as an escape hatch. Settle against a real VLC/browser player matrix
  before the UI exposes the choice. ([07](./phase-07-export.md))
- **Per-row language override in batch upload** — on this document's cut list, resolved in the
  plan as a single overflow-menu item over an existing API field. Delete if it costs more.
  ([11](./phase-11-ui-shell.md))
- **Should exporting a `partial` run require explicit acknowledgement?** ([09](./phase-09-queue-and-worker.md))
- **Should `thibi init` write an `APP_SECRET_KEY.backup` alongside `.env`?** ([15](./phase-15-deployment.md))
