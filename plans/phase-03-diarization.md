# Phase 3 — Diarization and reconciliation

## Goal

At the end of this phase `thibi transcribe interview.wav --lang my --diarize` runs ASR and a
whole-file pyannote diarization concurrently against the same normalized derivative, reconciles
turns against words into per-word and per-segment speaker attribution with an honest purity score
and a review flag, and persists speakers **against the job** so a human's "Speaker 01 = Daw Khin"
survives every re-transcription. It sits at position 3 because reconciliation is the hardest
correctness problem in the product and the one most likely to force a data-model change:
`segments.speaker_id`, `speaker_purity`, `needs_speaker_review`, per-word speakers and the
`speakers`-scoped-to-job decision all have to be right before the editor (Phase 12/13), export
(Phase 7) and the queue's `awaiting_external` shape (Phase 9) are built on top of them. It also
builds the Python sidecar image and its task API, which Phase 4 fills the other half of.

## Prerequisites

| From | What |
|---|---|
| Phase 1 | `EngineContext`, `ObjectStore`, presigned-GET minting, `segments` + `words` with timings, `run_steps` |
| Phase 1 | `media_derivatives` `norm_16k_mono_flac` — ASR and diarization consume the *same* file. **Note it only actually became 16 kHz on 2026-08-10:** `loudnorm` resamples internally to 192 kHz and emits at its own rate, so the `aresample=16000` in front of it was silently discarded and the derivative had always been 192 kHz. pyannote 3.1 expects 16 kHz and resamples anything else itself, so this would have cost decode time and nothing else — but the sidecar's throughput numbers in §5 assume a 16 kHz input, and any measured before that date were taken against a file 6× larger. `RECIPE_VERSION` is derived from the filter string, so every pre-fix derivative is already invalidated |
| Phase 2 | `util/retry.ts` with full jitter; the submit/poll/JSON-only-handle pattern (`BatchOp`) to copy |
| Phase 0 · S2 | Whether Google word confidence exists — affects nothing here, but `has_words` does |
| Infra | A `sidecar` compose service and an `hf-cache` volume; an `HF_TOKEN` for the gated pyannote repo |

## Deliverables

| Path | Purpose |
|---|---|
| `services/sidecar/Dockerfile` | One Python image: torch, pyannote.audio, faster-whisper (Phase 4), ffmpeg |
| `services/sidecar/app/main.py` | FastAPI app, lifespan model load, the four routes |
| `services/sidecar/app/config.py` | pydantic-settings: device, `MAX_CONCURRENT_TASKS`, cache dirs, HF token |
| `services/sidecar/app/tasks.py` | Task registry, idempotency keys, single-slot semaphore, TTL eviction, on-disk task journal |
| `services/sidecar/app/diarize.py` | pyannote pipeline, progress hook, cooperative cancel, deadline |
| `services/sidecar/app/audio.py` | Presigned-URL fetch to temp, ffprobe sanity, guaranteed cleanup |
| `services/sidecar/app/schemas.py` | Pydantic request/response models — the contract |
| `services/sidecar/app/asr.py` | Stub raising 501 until Phase 4 |
| `services/sidecar/tests/` | pytest suite with a canned pipeline |
| `packages/engine/src/diarize/types.ts` | `DiarizationSource`, `Turn`, `DiarizeRequest/Handle/Status/Result` |
| `packages/engine/src/diarize/pyannote.ts` | Sidecar-backed source |
| `packages/engine/src/diarize/scribe.ts` | ElevenLabs Scribe source + `wordsToTurns` |
| `packages/engine/src/diarize/reconcile.ts` | **The centrepiece** — assignment, smoothing, voting, fallback |
| `packages/engine/src/diarize/identity.ts` | Prior-speaker matching via Hungarian assignment |
| `packages/engine/src/diarize/persist.ts` | Writes `diarization_runs`, `speaker_turns`, `speakers`, segment/word updates |
| `packages/core/src/algo/hungarian.ts` | ~70-line O(n³) assignment, zero deps |
| `packages/db/src/schema/speakers.ts` + migration | `speakers`, `diarization_runs`, `speaker_turns`, segment/word columns |
| `apps/cli/src/commands/transcribe.ts` | *(modified)* `--diarize`, `--speakers N`, `--min-speakers`, `--max-speakers`, `--diarize-source` |
| `apps/cli/src/commands/speakers.ts` | `thibi speakers list/rename/merge <jobId>` |
| `apps/cli/src/commands/diarize.ts` | `thibi diarize score <run> --reference turns.rttm` — DER/JER for tuning, **and `thibi diarize run <runId>`** |
| `packages/engine/src/diarize/run.ts` | *(added 2026-08-11)* the stage itself: submit, poll, reconcile, persist. Not in the original table — the plan described the pieces and not the thing that calls them in order |
| `packages/engine/src/diarize/speakers.ts` | *(added 2026-08-11)* `listSpeakers` / `renameSpeaker` / `mergeSpeakers`, so the CLI holds no SQL |
| `packages/engine/src/diarize/score.ts` | *(added 2026-08-11)* RTTM parsing and DER/JER, so the scorer is testable without a CLI |
| `packages/engine/src/diarize/__tests__/pyannote.contract.test.ts` | *(added 2026-08-12)* the contract test, `PyannoteSource` against the running container |
| `packages/engine/src/diarize/__fixtures__/en-2spk-short.flac` + `.truth.json` | *(added 2026-08-12)* 11 s, four alternating TTS turns, and the reference the fixture's own generator emitted |
| `packages/engine/scripts/make-2spk-fixture.mjs` | *(added 2026-08-12)* regenerates both, so a committed binary is a fact somebody can re-derive |

## Design

### 1. The sidecar, diarization half

```
services/sidecar/app/
  main.py      FastAPI + lifespan(load models) + routes
  config.py    DEVICE, MAX_CONCURRENT_TASKS=1, TASK_TTL_S=86400, HF_HOME=/cache/hf
  tasks.py     registry, uuid5 ids, Semaphore(1), journal
  diarize.py   pyannote
  asr.py       501 until Phase 4
  audio.py     fetch + probe + cleanup
  schemas.py
```

The contract, exactly as the overview specifies it:

```
GET /health
→ { "status": "ok",
    "models": { "diarization": "loaded", "asr": "not_loaded" },
    "device": "cpu", "torch": "2.4.1", "pyannote": "3.3.2",
    "slots": { "max": 1, "busy": 0 },
    "realtime_factor_estimate": 0.28 }

POST /v1/diarize
{ "idempotency_key": "<run_step_id>",
  "audio_url": "http://minio:9000/thibi/…?X-Amz-Signature=…",
  "expected_duration_ms": 3612000,
  "num_speakers": null, "min_speakers": null, "max_speakers": null,
  "deadline_s": 21720 }
→ 202 { "task_id": "…", "state": "queued", "accepted_at": …, "expires_at": … }
→ 200 same body, if this key is already known (in flight or complete)
→ 429 { "error": "busy", "retry_after_s": 60 }  when a DIFFERENT key arrives while the slot is held

GET /v1/tasks/{id}
→ { "task_id", "state": "queued|running|succeeded|failed|cancelled|lost",
    "progress": 0.34, "started_at", "finished_at",
    "result": DiarizeResult?, "error": { "code", "message", "retryable" }? }

DELETE /v1/tasks/{id}
→ 204   cooperative cancel; idempotent; 204 even if already terminal
```

**Idempotency.** `idempotency_key` is the `run_step_id`, and `task_id = uuid5(NAMESPACE_URL, key)`.

> *Amended 2026-08-11.* `run_steps` does not exist until Phase 9, so there is no step id to
> send. The engine derives the key instead — `diarizeStepKey(runId)` is `` `${runId}:diarize` ``
> — which keeps the property this design is for: reconstructible without having stored the
> 202 response. One diarization per run, so the run id determines it. When Phase 9 adds
> `run_steps` the step id becomes the key and nothing else changes.
Deterministic on purpose: the engine can reconstruct the task id without having stored the 202
response, so a lost response is recoverable by `GET` alone. Re-POST with the same key while
running returns 200 with the current task and **never** starts a second run; after success it
returns the cached result until the 24-hour TTL evicts it.

The registry is an in-memory dict plus a `/data/tasks/<task_id>.json` journal. After a container
restart a known id resolves to `state: "lost"` rather than 404. That distinction is load-bearing:
404 means "never seen, safe to submit", while `lost` means "this ran and was killed", which the
engine must count as an attempt.

**Two-sided deadline.** The client sets `run_steps.deadline_at = now + max(10 min, 12 × durationS)`
— twelve times realtime is roughly three times the worst measured CPU factor — and polls every
15 s with a 5 s connect / 30 s read timeout on control calls. On breach it fails the step
`deadline_exceeded` **and** issues `DELETE /v1/tasks/{id}`. The server is told
`deadline_s = client_deadline + 120` and checks a flag inside pyannote's progress hook, so the
client always wins the race and the failure is attributed on our side; the server side exists only
so a runaway job frees the slot without a container restart.

**Failure taxonomy.**

| code | HTTP | Retryable | Cause | Engine action |
|---|---|---|---|---|
| `busy` | 429 | yes, **no attempt counted** | another key holds the slot | reschedule after `retry_after_s` |
| `bad_audio` | 400 | no | ffprobe cannot decode, 0 duration, or duration mismatch | fail step; run → `partial` |
| `audio_unreachable` | 502 | yes | presigned URL expired / 403 / DNS | re-mint the URL, retry |
| `oom` | 500 | no at the same size | torch OOM or SIGKILL 137 | fail with "increase sidecar memory"; see §5 |
| `model_unavailable` | 503 | yes | HF token missing, repo gated, weights absent | fail fast, print the gate URL |
| `deadline_exceeded` | 504 | no | server-side backstop fired | fail step |
| `cancelled` | — | no | `DELETE` | terminal, not an error |
| `internal` | 500 | yes ×2 | anything else | retry twice, then fail |
| `lost` | 200 (state) | yes | container restarted mid-task | attempt + 1, resubmit |

**`MAX_CONCURRENT_TASKS=1`** is a `threading.Semaphore(1)` acquired non-blocking in the POST
handler. pyannote and faster-whisper both saturate every core and both allocate GB-scale tensors;
two concurrent tasks are *slower* than running them in sequence and can OOM the container. The 429
is what makes that single slot visible to the caller instead of turning into a mysterious timeout.
`worker-heavy` at concurrency 1 is the redundant outer guard, and the two are deliberately
belt-and-braces because the failure mode is an OOM kill, not an error message.

**Audio arrives as an internally-presigned MinIO URL.** Minted by the engine with the `s3` client
at `http://minio:9000` — *not* `s3Public` through Caddy; the sidecar is on the compose network and
has no business traversing the reverse proxy.

> *Amended 2026-08-11, measured.* This sentence assumes the engine also runs inside compose, and
> the CLI does not. SigV4 signs the `Host` header, so a URL minted on a developer's laptop against
> `localhost:9000` comes back **403 `audio_unreachable`** the moment the sidecar requests it as
> `minio:9000` — which is exactly what happened on the first real run. There are **two** presign
> audiences: the sidecar on the internal network, and (Phase 10) a browser through Caddy.
> `S3ObjectStore` already takes a `signingClient` for the second; nothing supplies one for the
> first, and `apps/cli/src/context.ts` sets neither. Overview amendment 43. Until it is wired up,
> a local `thibi transcribe --diarize` cannot reach the sidecar's audio. TTL is `min(6 h, deadline + 30 min)`. The sidecar
streams to `/tmp/<task_id>.flac`, checks `Content-Length` and the ffprobe duration against
`expected_duration_ms` within ±1 s, and treats a mismatch as `bad_audio` rather than diarizing half
a file in silence. The temp file is removed in a `finally`, on every path, asserted by a test.

The sidecar never receives credentials and never talks to Postgres. It is a pure function of
(audio, params) → turns. That is what makes it safe to run at low privilege and easy to test.

```json
// DiarizeResult
{ "turns": [ { "start_ms": 0, "end_ms": 4120, "speaker": "SPEAKER_00" } ],
  "num_speakers": 3,
  "model": "pyannote/speaker-diarization-3.1",
  "params": { "min_speakers": null, "max_speakers": null },
  "audio_duration_ms": 3612000, "compute_ms": 5400000,
  "realtime_factor": 0.67, "device": "cpu" }
```

Turns are sorted by start and **may overlap** — pyannote 3.1 emits overlapping speech. Reconcile
must not assume they are disjoint, and the fixtures include an overlapping case for exactly that
reason.

### 2. `DiarizationSource` — an interface, so Scribe is an alternate and not a special case

```ts
export interface Turn { startMs: number; endMs: number; speakerKey: string }

export interface DiarizationSource {
  id: string;                                  // 'pyannote' | 'elevenlabs-scribe'
  label: string;
  capabilities(): {
    mode: 'async-task' | 'sync';
    needsAudioUrl: boolean;      // pyannote: presigned URL; scribe: uploads bytes
    overlapAware: boolean;       // pyannote 3.1 true; scribe false
    speakerCountHint: 'exact' | 'range' | 'none';
    maxDurationMs?: number;
    costModel: { unit: 'audio_minute'; usdPerUnit: number };
  };
  submit(ctx: EngineContext, req: DiarizeRequest): Promise<DiarizeHandle>;
  poll(ctx: EngineContext, h: DiarizeHandle): Promise<DiarizeStatus>;
  fetch(ctx: EngineContext, h: DiarizeHandle): Promise<DiarizationResult>;
  cancel?(ctx: EngineContext, h: DiarizeHandle): Promise<void>;
}

export interface DiarizeRequest {
  runId: string; stepId: string;
  audio: { key: string; uri?: string; durationMs: number };
  hints: { numSpeakers?: number; minSpeakers?: number; maxSpeakers?: number };
  deadlineMs: number;
}
/** JSON-only, same Phase 9 constraint as BatchOp: no clients, no closures. */
export interface DiarizeHandle { sourceId: string; taskId: string; submittedAtMs: number; meta: Record<string, unknown> }
export interface DiarizationResult { turns: Turn[]; numSpeakers: number; model: string; params: unknown; raw: unknown }
```

Scribe returns diarized **words**, not turns, so its adapter collapses runs of same-speaker words:

```ts
export function wordsToTurns(words: ScribeWord[], opts = { gapMs: 250 }): Turn[] {
  const turns: Turn[] = [];
  for (const w of words) {
    if (w.type === 'spacing') continue;            // spacing tokens carry no speaker
    const startMs = Math.round(w.start * 1000);
    const endMs = Math.round(w.end * 1000);
    const last = turns[turns.length - 1];
    if (last && last.speakerKey === w.speaker_id && startMs - last.endMs <= opts.gapMs) {
      last.endMs = endMs;                          // extend the run
    } else {
      turns.push({ startMs, endMs, speakerKey: w.speaker_id });
    }
  }
  return turns;
}
```

Two honest caveats to carry in the docs. Scribe's boundaries derive from *its own* ASR's
tokenization, not Google's, so purity against Google segments tends to run slightly higher and
boundaries land slightly differently — comparable, not identical. And Scribe re-transcribes the
audio, so you pay for ASR twice. It is the answer to "this box cannot run pyannote", not a default.

Because both sources emit `Turn[]`, **reconcile has exactly one input type.** That is the entire
justification for the interface.

### 3. `reconcile.ts`

```ts
// packages/engine/src/diarize/reconcile.ts
import type { Turn } from './types';

export interface RWord    { id: string; segmentId: string; idx: number; startMs: number; endMs: number; text: string }
export interface RSegment { id: string; idx: number; startMs: number; endMs: number; hasWords: boolean }

export interface ReconcileOptions {
  nearestGapMs: number;         // 500  — attach a word to a turn it does not overlap
  medianMarginMax: number;      // 0.6  — only smooth words we are unsure about
  medianDurationMaxMs: number;  // 400  — only smooth words too short to be an utterance
  purityReviewBelow: number;    // 0.6
  minIdentityOverlapMs: number; // 2000
  minIdentityOverlapFrac: number; // 0.2
}
export const DEFAULTS: ReconcileOptions = {
  nearestGapMs: 500, medianMarginMax: 0.6, medianDurationMaxMs: 400,
  purityReviewBelow: 0.6, minIdentityOverlapMs: 2000, minIdentityOverlapFrac: 0.2,
};

export interface WordAssignment {
  wordId: string; speakerKey: string | null;
  /** (best - runnerUp) / (best + runnerUp) ∈ [0,1]. 1 = uncontested, 0 = dead tie. */
  margin: number;
  source: 'overlap' | 'nearest' | 'median' | 'none';
}
export interface SegmentAssignment {
  segmentId: string; speakerKey: string | null;
  purity: number; needsReview: boolean;
  source: 'words' | 'interval' | 'none';
}

const overlapMs = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
```

**Step 1 — interval index and max-overlap assignment.** Words and turns are both time-sorted, so
the whole assignment is one linear pass with a moving cursor. An interval tree is unnecessary
complexity at this scale (≈40k words, ≈2k turns for a three-hour file).

```ts
export function assignWords(words: RWord[], turns: Turn[], o = DEFAULTS): WordAssignment[] {
  const T = [...turns].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: WordAssignment[] = [];
  let lo = 0;

  for (const w of words) {
    // Retire turns that can no longer overlap or serve as "nearest".
    while (lo < T.length && T[lo].endMs < w.startMs - o.nearestGapMs) lo++;

    const per = new Map<string, number>();
    let nearestKey: string | null = null;
    let nearestDist = Infinity;

    for (let i = lo; i < T.length; i++) {
      const t = T[i];
      if (t.startMs > w.endMs + o.nearestGapMs) break;
      const ov = overlapMs(w.startMs, w.endMs, t.startMs, t.endMs);
      if (ov > 0) {
        // Overlapping turns from the SAME speaker accumulate — pyannote can emit two.
        per.set(t.speakerKey, (per.get(t.speakerKey) ?? 0) + ov);
      } else {
        const d = t.startMs > w.endMs ? t.startMs - w.endMs : w.startMs - t.endMs;
        if (d < nearestDist) { nearestDist = d; nearestKey = t.speakerKey; }
      }
    }

    let best = 0, second = 0, bestKey: string | null = null;
    for (const [k, v] of per) {
      if (v > best) { second = best; best = v; bestKey = k; }
      else if (v > second) { second = v; }
    }

    if (bestKey !== null) {
      out.push({ wordId: w.id, speakerKey: bestKey,
                 margin: (best - second) / (best + second || 1), source: 'overlap' });
    } else if (nearestKey !== null && nearestDist <= o.nearestGapMs) {
      out.push({ wordId: w.id, speakerKey: nearestKey, margin: 0, source: 'nearest' });
    } else {
      out.push({ wordId: w.id, speakerKey: null, margin: 0, source: 'none' });
    }
  }
  return out;
}
```

`margin` is defined **once, here**, and never redefined: `(best − second) / (best + second)`. A
word wholly inside one turn scores 1.0; a word split evenly between two scores 0. Everything
downstream that says "unsure" means this number.

**Step 2 — width-3 median filter, guarded.**

```ts
export function medianSmooth(words: RWord[], a: WordAssignment[], o = DEFAULTS): WordAssignment[] {
  const out = a.map(x => ({ ...x }));
  for (let i = 1; i < a.length - 1; i++) {
    const prev = a[i - 1], cur = a[i], next = a[i + 1];
    if (!prev.speakerKey || !cur.speakerKey || !next.speakerKey) continue;
    if (prev.speakerKey !== next.speakerKey) continue;     // not a one-word island
    if (cur.speakerKey === prev.speakerKey) continue;      // nothing to fix

    if (cur.margin >= o.medianMarginMax) continue;                       // guard A
    if (words[i].endMs - words[i].startMs >= o.medianDurationMaxMs) continue; // guard B

    out[i] = { ...cur, speakerKey: prev.speakerKey, source: 'median',
               margin: Math.min(prev.margin, next.margin) };
  }
  return out;
}
```

Reads from `a`, writes to `out` — one pass over the *original* assignments, so a flip can never
cascade into a run. Width 3, one pass, deliberately.

Why each guard exists:

- **`margin < 0.6`.** A word sitting almost entirely inside one turn has margin near 1. Flipping it
  would be the filter overruling the evidence it was given. Only genuinely ambiguous words are
  eligible for smoothing.
- **`duration < 400 ms`.** The artefact being fixed is sub-word: pyannote clipping one short token
  at a turn edge. A word lasting longer than 400 ms is a real utterance. In an interview, a real
  one-word utterance — *"Yes." "No." "1988."* — is very often the most quotable thing in the file.
  **Eating those is a worse bug than the flicker they resemble.** The filter is deliberately biased
  toward leaving genuine interjections alone, and there are two separate fixtures (short-but-certain,
  long-but-uncertain) so that a later "simplification" that drops either guard fails a test.

**Step 3 — duration-weighted majority vote and `speaker_purity`.**

```ts
export function voteSegments(
  segments: RSegment[], words: RWord[], assigned: WordAssignment[], turns: Turn[], o = DEFAULTS
): SegmentAssignment[] {
  const byId = new Map(assigned.map(x => [x.wordId, x]));
  const bySeg = new Map<string, RWord[]>();
  for (const w of words) {
    const arr = bySeg.get(w.segmentId); if (arr) arr.push(w); else bySeg.set(w.segmentId, [w]);
  }

  return segments.map(seg => {
    const ws = bySeg.get(seg.id);
    if (!seg.hasWords || !ws || ws.length === 0) return intervalFallback(seg, turns);

    const ms = new Map<string, number>();
    let total = 0;
    for (const w of ws) {
      const d = Math.max(1, w.endMs - w.startMs);   // a zero-length word still gets a vote
      total += d;
      const k = byId.get(w.id)?.speakerKey;
      if (k) ms.set(k, (ms.get(k) ?? 0) + d);
    }

    let winner: string | null = null, winMs = 0;
    for (const [k, v] of ms) if (v > winMs) { winMs = v; winner = k; }

    const purity = total > 0 ? winMs / total : 0;
    return { segmentId: seg.id, speakerKey: winner, purity,
             needsReview: winner === null || purity < o.purityReviewBelow, source: 'words' };
  });
}
```

Weighted by duration, not count, for two reasons. A segment holding eight filler words from A and
two long content words from B is B's sentence, and counting votes gets that backwards. And word
*count* is not comparable across languages — unspaced scripts tokenize unevenly — while duration is.

`purity` is stored on the segment and feeds three things: `needs_speaker_review`, export-time
speaker splitting (Phase 7), and the editor's "two speakers in this segment" affordance (Phase 13).

**Step 4 — the `has_words = false` fallback, always flagged.**

```ts
function intervalFallback(seg: RSegment, turns: Turn[]): SegmentAssignment {
  const ms = new Map<string, number>();
  for (const t of turns) {
    const ov = overlapMs(seg.startMs, seg.endMs, t.startMs, t.endMs);
    if (ov > 0) ms.set(t.speakerKey, (ms.get(t.speakerKey) ?? 0) + ov);
  }
  let winner: string | null = null, winMs = 0;
  for (const [k, v] of ms) if (v > winMs) { winMs = v; winner = k; }
  const span = Math.max(1, seg.endMs - seg.startMs);
  return {
    segmentId: seg.id, speakerKey: winner,
    purity: winner ? winMs / span : 0,
    needsReview: true,              // ← unconditional, even at purity 1.0
    source: 'interval',
  };
}
```

`needsReview` is `true` unconditionally — **even at purity 1.0**. Without words we cannot see a
mid-segment speaker change at all, so a high interval overlap is evidence about the segment's
*span*, not about who spoke each part of it. Chirp returns empty word arrays exactly for the
long-tail languages that are this product's reason to exist, so this is not an edge case. **Never
silently attribute.** The editor renders these with a distinct marker: *"attributed by time overlap
only — no word timings"*.

**Step 5 — re-diarization identity preservation via Hungarian assignment.**

```ts
// packages/engine/src/diarize/identity.ts
import { hungarian } from '@thibi/core/algo/hungarian';

export interface PriorSpeaker { speakerId: string; key: string; intervals: Array<[number, number]> }
export interface FreshSpeaker { key: string; intervals: Array<[number, number]> }

export function matchSpeakers(
  prior: PriorSpeaker[], fresh: FreshSpeaker[], o = DEFAULTS
): Map<string /* fresh key */, string /* speakers.id */> {
  const n = prior.length, m = fresh.length;
  if (n === 0 || m === 0) return new Map();
  if (Math.max(n, m) > 64) throw new Error('Refusing speaker identity matching above 64 speakers');

  const size = Math.max(n, m);
  const cost: number[][] = [];
  const ovl: number[][] = [];
  for (let i = 0; i < size; i++) {
    cost.push([]); ovl.push([]);
    for (let j = 0; j < size; j++) {
      const v = (i < n && j < m) ? intervalOverlapMs(prior[i].intervals, fresh[j].intervals) : 0;
      ovl[i].push(v);
      cost[i].push(-v);                // maximise overlap ≡ minimise negative overlap
    }
  }

  const pairs = hungarian(cost);       // square, padded with zero-overlap dummies
  const out = new Map<string, string>();
  for (const [i, j] of pairs) {
    if (i >= n || j >= m) continue;
    const ov = ovl[i][j];
    const floor = Math.max(
      o.minIdentityOverlapMs,
      o.minIdentityOverlapFrac * Math.min(totalMs(prior[i].intervals), totalMs(fresh[j].intervals)),
    );
    if (ov < floor) continue;          // coincidence, not identity — mint a new speaker
    out.set(fresh[j].key, prior[i].speakerId);
  }
  return out;
}
```

Four decisions:

- **A small hand-written O(n³) Hungarian in `packages/core/src/algo/hungarian.ts`, not a
  dependency.** Real matrices are ≤ 12×12 (more than a dozen speakers in one recording is a
  different kind of failure), so 12³ = 1728 operations. `core` is the zero-runtime-deps package by
  policy, `munkres-js` is unmaintained, and this is a textbook algorithm with a closed test set —
  brute-force verifiable against every permutation at n ≤ 8.
- **An overlap floor of `max(2000 ms, 0.2 × min(priorMs, freshMs))`.** Below it, mint a new speaker.
  **A wrong identity carry-over is worse than an extra speaker row**, because a human has already
  put a real name on the old one and the mistake is invisible.
- **Unmatched prior speakers are kept, never deleted.** If this run found three speakers where the
  last found four, the fourth's name survives, unattributed.
- ***Except* speakers a human merged away**, added 2026-08-11 while building `persist.ts`. A
  merged-away row still holds the attributed time this match runs against, so keeping it in the
  prior set means the next diarization matches the same acoustic cluster back onto the row the
  human retired and the split reappears. `mergeSpeakers` repoints segments, words and turns to
  the target and marks the loser; `persistDiarization` filters `is_merged_into is null`.
- **Matching is against prior *attributed time*** — the union of intervals of segments currently
  attributed to that `speakers` row in any earlier run of the job — not against the previous
  diarization's raw turns. That is what lets a human's manual reassignment feed forward into the
  next run's identity matching.

Ties are broken deterministically by prior `key` then fresh `key`, so identical inputs always give
an identical mapping; there is a property test for it.

### 4. Schema

```sql
create table speakers (
  id             uuid primary key,
  job_id         uuid not null references jobs(id) on delete cascade,
  key            text not null,                    -- 'speaker-00'
  display_name   text,
  color_idx      smallint not null default 0,
  is_merged_into uuid references speakers(id),
  created_at     timestamptz not null default now(),
  unique (job_id, key)
);

create table diarization_runs (
  id                uuid primary key,
  run_id            uuid not null references runs(id) on delete cascade,
  job_id            uuid not null references jobs(id) on delete cascade,
  source            text not null,          -- 'pyannote' | 'elevenlabs-scribe'
  model             text not null,
  params            jsonb not null default '{}',
  state             text not null,          -- queued|running|succeeded|failed|cancelled
  task_id           text,
  speakers_found    smallint,
  audio_duration_ms integer,
  compute_ms        integer,
  realtime_factor   real,
  cost_usd          numeric(12,6),
  error             jsonb,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create table speaker_turns (
  id                   bigserial primary key,
  diarization_run_id   uuid not null references diarization_runs(id) on delete cascade,
  speaker_id           uuid references speakers(id),   -- null until reconcile maps it
  raw_key              text not null,                  -- 'SPEAKER_00' as emitted
  start_ms             integer not null,
  end_ms               integer not null
);
create index on speaker_turns (diarization_run_id, start_ms);

-- Amended 2026-08-11. These four columns already exist: Phase 1 created them in
-- 0000_init.sql with a `-- FK added in Phase 3` note, so 0003_speakers.sql adds only the
-- two foreign keys and the review index. `create index on words (segment_id, idx)` is
-- likewise already there, as the UNIQUE index `words_segment_idx`.
alter table segments
  add constraint segments_speaker_id_speakers_id_fk
  foreign key (speaker_id) references speakers(id) on delete set null;
alter table words
  add constraint words_speaker_id_speakers_id_fk
  foreign key (speaker_id) references speakers(id) on delete set null;

create index segments_needs_speaker_review on segments (run_id, idx)
  where needs_speaker_review;
```

`on delete set null`, not `cascade`. Deleting a speaker must orphan the *attribution*,
never the transcript — the text is what the user came for, and a cascade here would delete
a segment because somebody tidied up a speaker list. The same applies to
`speaker_turns.speaker_id`, where it additionally keeps `raw_key` readable after the
mapping is gone.

`speakers.job_id`, not `run_id`, is the decision worth defending. A re-run creates a new `runs` row
and a new `diarization_runs` row, but *"Speaker 01 is Daw Khin"* is a fact about the recording, not
about a run. Scoping speakers to a run would discard the name on every re-transcription — the most
annoying possible bug in this feature, and one that only shows up after a user has done real work.

`raw_key` is kept alongside `speaker_id` so a mis-mapping is diagnosable months later.

### 5. Whole file, never per chunk

Reconcile runs **once**, over the whole timeline, after both the ASR steps and the `diarize` step
complete. Chunk boundaries are irrelevant because diarization never saw them. State it plainly in
the docs: *this is the entire answer to "how do you keep speaker identity across chunk boundaries" —
you don't chunk.*

The tempting fallback for a file long enough to OOM the sidecar is windowed diarization: ten-minute
windows with sixty seconds of overlap, stitched by matching speaker embeddings across the overlap.
**Do not build it in Phase 3, and prefer never to build it.** It reintroduces exactly the identity
problem whole-file diarization removes; stitch quality depends on the overlap containing speech
from every speaker, which it frequently does not; and errors compound window over window, so a
single bad stitch corrupts everything downstream of it. The correct fix is memory: pyannote 3.1 on
a three-hour 16 kHz mono file peaks around 6–8 GB, so give the sidecar 16 GB and the problem
disappears. If a newsroom genuinely cannot, the supported answer is ElevenLabs Scribe — somebody
else's memory. Measure and document the actual OOM ceiling on the reference box rather than
guessing at it.

### 6. CPU versus GPU, and what it forces

| Device | Realtime factor | 1-hour file | 3-hour file | status |
|---|---|---|---|---|
| CPU, 6 threads (i9-8950HK) | **0.56–0.61×** | **~1 h 40 m** | **~5 h** | measured ×2, [S6](../spikes/RESULTS.md) 2026-08-10 |
| CPU, single-speaker audio | 0.74–0.79× | ~1 h 20 m | ~4 h | measured ×2, S6 |
| One 12 GB GPU | 8–20× | 3–8 min | 9–25 min | **still unmeasured** |

*Amended 2026-08-10.* This table read `CPU, 8 cores | 0.15–0.4× | 2.5–7 h | 7.5–20 h` and had
never been measured. S6 ran the real pipeline: **every measurement beat it by 1.5–4×**. Phase 15
§9 had already written the instruction — *"if pyannote on this box is not 0.15–0.4× realtime,
fix the table, not the claim"* — so this is that, and the same correction is applied in the
overview, Phase 9's step table and Phase 15's tier and troubleshooting tables.

Three things the measurement changed beyond the numbers:

- **Speaker count drives the cost, not duration.** 4 speakers over 317 turns ran ~25% slower
  than 1 speaker over 21. Plan with **~0.6×**; 0.74–0.79× is a single-speaker best case, and
  single-speaker audio is the case least worth diarizing. Every clip was measured twice and
  run-to-run variance is 6–8%, so two significant figures is the honest precision here.
- **The GPU tier is no longer mandatory.** At 0.15× a 1-hour file was 6 h 40 m and the honest
  answer for the small tier was to not offer diarization at all. At ~0.6× it is a slow
  background job, so the GPU becomes a throughput choice rather than a precondition. The
  8–20× row is still inherited and unmeasured — do not quote it in the deployment guide until
  it is.
- **This number is probably a floor.** It came off a 2018 six-core laptop chip, pinned to
  pyannote 3.3.2 because x86 macOS has no torch wheel past 2.2.2. The sidecar runs Linux with
  pyannote 4.x on torch ≥ 2.8. **Re-measure there** before treating ~0.6× as the deployment
  figure, and note that S6's `use_auth_token` shim exists only because of that pin and must
  not be carried into `services/sidecar/`.

The routes to making it faster — profile the stages first, then GPU, ONNX int8, reusing ASR
segment boundaries, thread count, and caching or skipping single-speaker files — are recorded
with their evidence in [S6](../spikes/RESULTS.md#s6--how-slow-is-pyannote-diarization-on-a-cpu-actually).

These are design decisions, not caveats. **None of them are relaxed by the faster number** —
1.6× slower than realtime is still a background job:

1. **Diarization is off by default.** `--diarize` is opt-in in the CLI; the UI checkbox shows the
   estimate — *"≈4 h 10 m on this machine"* — **before** the run starts, not after.
2. `deadline_at = max(10 min, 12 × duration)`. Generous, because the alternative is killing a job
   at hour six.
3. Progress must come from pyannote's `ProgressHook`, forwarded as task `progress` and into
   `run_events`. Without it an operator watches nothing happen for hours and concludes it hung.
4. `worker-heavy` runs at concurrency 1, and the estimate shown to the user is computed from the
   **measured** `realtime_factor` of the last five `diarization_runs` on this instance, not a
   constant. The number gets more honest on its own.
5. The deployment guide's tier table carries the honest trade, in the deployment guide rather
   than a footnote. *Amended 2026-08-10:* the line was "the GPU tier is the difference between
   overnight and coffee", which overstates it now that CPU measures ~0.6×. Overnight starts at
   roughly three hours of audio, not one, and a 30-minute interview is a 49-minute wait. The
   GPU claim also cannot be written as a ratio until the 8–20× row is measured rather than
   inherited.
6. **Diarization must never gate the transcript.** ASR finishes a 1-hour file in about a minute
   (S3: 43 s for 30 min via chunked sync) while diarization takes ~1 h 40 m, so a design where
   speaker labels block the transcript would turn a one-minute product into a two-hour one for
   no reason. `diarize` is its own `run_steps` row and the transcript is readable and editable
   the moment ASR lands; speaker attribution appears when it appears. This was implicit in the
   DAG and is written down here because the measurement is what makes it load-bearing.

## Porting notes

Almost nothing ports. This is new code, and that is the point of putting it early.

| Old | Treatment |
|---|---|
| `lib/queue.ts:52-69` `withRetry` / `RETRYABLE` | Already generalised in Phase 2 into `util/retry.ts`; `diarize` gets 2 × 60 s |
| `lib/queue.ts:126` `normalizeMyanmarText` applied in place | **The anti-pattern this phase must avoid.** Reconcile joins on word rows; any text mutation that changes word count desynchronises the alignment. `text_raw` keeps provider bytes and Zawgyi conversion is applied *per word* with segment text re-derived |
| `lib/audio/chunk.ts` | Not used. Diarization is whole-file |
| `lib/providers/google.ts` `speakerLabel` / `enableSpeakerDiarization` | **Deliberately unused.** Not available on `chirp_2` in most locales, and mixing two diarization sources in one run makes `speaker_purity` meaningless. One source per run, recorded in `diarization_runs.source` |
| `lib/db.ts:63-66`, `lib/db.ts:70` | Must not survive — already on the overview's hazard list |

## Tests

Synthetic fixtures in `packages/engine/src/diarize/__fixtures__/`, each a small JSON of
`{ segments, words, turns, expect }`:

| Fixture | Asserts |
|---|---|
| `two-speaker-clean.json` | Alternating 5 s turns, words fully inside → purity 1.0 everywhere, zero reviews |
| `flicker-single-word.json` | 180 ms word at a turn edge, margin 0.3 → **flipped** by the filter |
| `interjection-genuine.json` | 620 ms "Ha!" from B inside A's turn, margin 0.9 → **not flipped**. The regression test that matters most |
| `interjection-short-but-certain.json` | 200 ms, margin 0.95 → not flipped (margin guard alone) |
| `interjection-long-but-uncertain.json` | 700 ms, margin 0.2 → not flipped (duration guard alone) |
| `turn-shorter-than-word.json` | 120 ms turn inside a 900 ms word → dominant speaker wins, low margin |
| `overlapping-turns.json` | pyannote 3.1 overlap; same-speaker turns accumulate; margin < 0.6 |
| `gap-no-turn.json` | Word in silence beyond 500 ms → `speakerKey: null`, counted in stats |
| `no-words-oromo.json` | `has_words=false` throughout → interval fallback, **every** segment flagged |
| `rediarize-identity.json` | Prior 3 named speakers, fresh 3 with permuted keys → mapping restored |
| `rediarize-new-speaker.json` | A fresh 4th speaker with 1.2 s of overlap → **new row**, not a hijack |
| `rediarize-fewer-speakers.json` | Fresh finds 2; the prior third is retained, unmapped |

Property tests: `matchSpeakers` is a bijection on the matched subset, never maps two fresh keys to
one prior id, and is invariant to input ordering. `hungarian` is checked against brute-force
permutation on 20 random 6×6 matrices plus three textbook matrices.

Sidecar `pytest`, with a 12-second WAV fixture and a monkeypatched pipeline returning canned turns:
idempotent replay returns the same `task_id`; a second, different key gets 429 with `Retry-After`;
`DELETE` cancels a running task and frees the slot; a reloaded registry reports `lost`, not 404;
the server deadline fires and releases the slot; a 0-byte download is `bad_audio`; a duration
mismatch beyond 1 s is `bad_audio`; and the temp file is absent after **every** path including
cancel and exception.

Contract test: the TypeScript `PyannoteSource` runs against the real container, so the JSON
schema cannot drift between the two languages without a red build. Built 2026-08-12 as
`packages/engine/src/diarize/__tests__/pyannote.contract.test.ts` — six assertions, none of
which duplicates the fake-source suite above: the task id matches what `/v1/tasks/by-key`
derives from the step key, a resubmit of the same key lands on the same task, a *different*
key is refused as a `DiarizerBusyError` carrying `retryAfterMs`, an unknown id polls back as
retryable rather than throwing, a real run's snake_case result maps field-for-field into
`DiarizationResult`, and a cancelled task refuses to yield one.

**Against the real model, not the canned pipeline this plan first specified** — overview
amendment 47. The canned pipeline is monkeypatched *in-process* by pytest, which nothing
outside the process can do, and the shape most likely to drift is the real pipeline's output
(amendment 42). The cost is ~40 s of CPU for 11 s of audio; the test skips itself unless
`/health` reports the model loaded, and its idempotency key is fresh on every run so the
sidecar cannot answer from cache.

The audio is `__fixtures__/en-2spk-short.flac` — four alternating macOS-TTS turns separated
by 400 ms of silence, regenerated by `packages/engine/scripts/make-2spk-fixture.mjs`, the
method of `spikes/s7-make-2spk.mjs` at a third the length. The assertion is the A-B-A-B
*pattern* at each reference turn's midpoint, never which label pyannote chose: `SPEAKER_00`
is meaningless across runs, and stating it as a pattern also survives a turn being split in
two. This is a contract test, not a measurement — two synthetic voices with no crosstalk are
a floor on difficulty, and an accuracy claim still needs `thibi diarize score` against real
audio (open question 2).

## Verification

```
$ docker compose --env-file .env -f infra/compose.dev.yml --profile diarize up -d sidecar
$ curl -s localhost:8081/health | jq '{status, models, device, slots, realtime_factor_estimate}'

$ thibi transcribe fixtures/interview-2spk-6min.wav --lang my --diarize -v
plan       mode=sync_chunked  diarize=pyannote
asr        6 chunks … done (48s)
diarize    task 5f0c…  0% … 34% … 71% … done 14m12s  rtf 0.42  speakers=2
reconcile  1204 words   1 median flip   0 unassigned
           58 segments  mean purity 0.97   2 flagged for review
```

```
$ thibi runs show <runId> --speakers
speaker-00  (unnamed)  61%  36 segments
speaker-01  (unnamed)  39%  22 segments

$ thibi export <runId> --format txt --speakers | head -3
Speaker 00: …
```

**The headline demo — identity survives re-diarization:**

```
$ thibi speakers rename <jobId> speaker-01 "Daw Khin"
$ thibi diarize run <runId>                       # re-diarize the SAME run, in place
done       0.48x realtime  speakers=2
           speaker-00  (unnamed)  carried across  (SPEAKER_01)
           speaker-01  Daw Khin   carried across  (SPEAKER_00)

$ thibi speakers list <jobId>
speaker-00  (unnamed)   34%   4 segments   39 words
speaker-01  Daw Khin    66%   5 segments   62 words
```

> *Amended 2026-08-12, measured.* This sequence used to re-run `thibi transcribe … --diarize`
> and call it "# new run". **It is a new *job*.** The `media_assets` row is content-addressed
> and deduped, the `jobs` row is not, so a second `transcribe` of the identical file lands
> its speakers on a job the rename never touched — and the demo appears to pass while
> proving nothing. `thibi diarize run <runId>` is the sequence that exercises the matcher.
> Overview amendments 45 and 46.
>
> *Resolved 2026-08-12:* `thibi transcribe --job <id>` now attaches a run to an existing
> job, which is the workflow a newsroom actually wants — re-transcribe with a better
> provider and keep the names. Verified end to end across **two different providers**:
>
> ```
> $ thibi transcribe interview.flac --provider openai --diarize
> $ thibi speakers rename <jobId> speaker-01 "Daw Khin"
> $ thibi transcribe interview.flac --provider groq --job <jobId> --diarize
>            speaker-01  Daw Khin  carried across  (SPEAKER_00)
> ```
>
> It refuses a job holding a different recording, because a speaker name is a fact about a
> recording and the Hungarian matcher would otherwise place a human's names onto a timeline
> they never heard, by coincidental overlap, without complaining.

**Restart resilience:** `docker compose restart sidecar` mid-task → engine polls, sees `lost`,
counts an attempt, resubmits once, completes.

**Single slot:** launch two `--diarize` runs at once → the second reports *"diarizer busy, retrying
in 60s"* and eventually succeeds. It must never surface as an error.

**No-words path:** run `no-words-oromo` audio end to end → every segment carries
`needs_speaker_review = true` and the export marks them.

**Tuning hook:** `thibi diarize score <runId> --reference fixtures/interview.rttm` prints DER and
JER, so the thresholds in §3 can be moved on evidence in Phase 5.

**The contract holds against the container:** with Postgres, MinIO and the sidecar up,
`pnpm test` reports 646 tests and includes six under *"PyannoteSource against the real
sidecar"*, one of which is a genuine 11-second diarization. Stop the sidecar and the same
six are reported as skipped, with a line saying which service is missing — a clone with no
Docker must not read as a failure.

## Risks and open questions

> **Settled 2026-08-11 by spike [S7](../spikes/RESULTS.md#s7--is-a-hosted-diarizing-asr-an-alternative-to-running-pyannote-ourselves)
> — `gpt-4o-transcribe-diarize` is not being added, and nothing in this document changes.**
>
> Phase 4a spotted the model in OpenAI's docs and wrote the probe here as a day-one decision,
> because if it worked most of this phase would have been unnecessary. It was run before any
> Phase 3 code was written. The result splits cleanly in two, and the split is the point.
>
> **The diarization is good.** Against a constructed two-speaker reference with
> millisecond-exact boundaries: 2 of 2 speakers, **0.0% confusion**, DER 9.2% (all of it miss),
> **63 ms median boundary error**. The model is not the problem.
>
> **Everything around it lands on the long tail.** `language=my` is HTTP 400,
> *"Language code 'my' is not recognized"*. A 142-code sweep found **39 of our 116 seeded
> locales have no code the endpoint will accept at all** — Khmer, Lao, Pashto, Punjabi,
> Sinhala, Uzbek, Cebuano, Sorani and most of the African set among them. `mya` *is* accepted,
> and 20 identical requests on the 2 s Burmese clip returned **20 distinct transcripts, none in
> Myanmar script** — one earlier single request had come back in correct Myanmar script, which
> is exactly the trap a one-shot probe falls into. There is a hard **1400 s (23 m 20 s)
> duration ceiling**, so a one-hour interview cannot go through it in any language. And it
> returns **no word timings at any granularity** — `timestamp_granularities[]=word` is accepted
> and silently ignored — so it would live permanently on §3 step 4's `intervalFallback` path,
> which is flagged for human review unconditionally.
>
> §6's invariant is therefore untouched: the diarizing ASR that would have forced
> *"diarization must never gate the transcript"* to be re-reasoned is not becoming a source.
>
> Read this as a verdict about **this product**, not about hosted diarization. For an
> English-language newsroom on sub-23-minute recordings it would be a serious option. That is
> why the language sweep, rather than the DER, is the part of S7 worth keeping.
>
> *Corrected later the same day:* this originally added "and its attribution beats anything
> measured here on our own hardware", which was true only because nothing had been measured
> here. pyannote 4.0.7 against the same reference scores **DER 0.4% / 44 ms**, against the
> hosted model's **9.2% / 63 ms**. The hosted model's error is all *miss* — it clips speech
> at segment edges. Our own diarizer is the more accurate one.


1. **pyannote 3.1 is a gated Hugging Face model.** Accepting the terms and supplying `HF_TOKEN` is a
   manual step, and it will be the most common first-run failure for a self-hosting newsroom.
   `/health` must report `model_unavailable` with the exact gate URL, and `./thibi doctor`
   (Phase 15) must check it before a user discovers it four hours into a job. Check the licence
   before assuming weights can be baked into an image variant.
2. **The CPU realtime factor makes diarization close to unusable on the small tier.** The honest
   mitigations are the GPU tier and Scribe. The docs must not imply otherwise, and the UI estimate
   must be shown before the run, not in a tooltip.
3. **Reconcile is only as good as the word timings.** With `wordTimingQuality: 'none'` the feature
   degrades to interval fallback with everything flagged. Per the overview's risk 2, **build and
   test that path first**, not last — the `no-words-oromo` fixture is a Phase-3 deliverable, not a
   nice-to-have.
4. **Overlapping speech is reported but not transcribed.** pyannote marks it; our model assigns one
   speaker per word. Overlap surfaces as low margin and low purity, which is the honest
   representation, but two simultaneous speakers produce one transcript. Out of scope; say so in
   the docs rather than letting a user discover it.
5. **The thresholds are chosen, not measured.** 0.6 margin, 400 ms, 0.6 purity, 500 ms nearest-gap,
   2 s identity floor. `thibi diarize score` exists so Phase 5 can tune them against hand-labelled
   RTTM. Record their provenance in the code as *"initial, unmeasured"* so nobody later cites them
   as findings.
6. **Open — do we write `words.speaker_id` for all ~40k words, or only the segment?** Write both.
   Word rows are what export-time splitting and the "two speakers in one segment" affordance need,
   and 40k `COPY`-batched updates are cheap. Revisit only with a measurement.
7. **Open — Scribe's cost and duration cap** are not yet confirmed against the live API, so its
   `capabilities().maxDurationMs` is a placeholder. Confirm before offering it as the documented
   fallback for the small tier.

## Definition of done

*Checked 2026-08-12. `[x]` means run, not read.*

- [x] `services/sidecar` builds one image and serves `/health`, `POST /v1/diarize`,
      `GET /v1/tasks/{id}`, `DELETE /v1/tasks/{id}` with the exact schemas above.
- [x] `task_id = uuid5(NAMESPACE_URL, run_step_id)`; a re-POST with the same key never starts a
      second run, and a restart yields `lost`, not 404. *(Key is derived from the run id — see
      the amendment in §1. The engine half of the replay was exercised through the CLI: a
      second `thibi diarize run` on the same run got HTTP 200 and the same task id.)*
- [x] `MAX_CONCURRENT_TASKS=1` enforced by semaphore; a second key gets 429 + `Retry-After`, and
      the engine does not count it as an attempt. *(The engine half has a test; the sidecar half
      has a pytest.)*
- [x] Every failure maps to a code in the taxonomy table with the documented retryability; the
      temp audio file is deleted on every path.
- [x] Audio reaches the sidecar only as an internally-presigned MinIO URL; the sidecar holds no
      credentials and no database connection.
- [ ] `DiarizationSource` implemented twice — pyannote and Scribe — with Scribe collapsing diarized
      words into turns via `wordsToTurns`, and reconcile seeing only `Turn[]`. **Scribe is not
      built**: it needs an ElevenLabs key nobody has, and its cost and duration cap (open
      question 7) are unconfirmed. pyannote alone is implemented behind the interface.
- [x] `reconcile.ts` implements all five steps; `margin` is defined in exactly one place.
- [x] Both median-filter guards are covered by separate fixtures, so dropping either one fails CI.
- [x] `has_words = false` segments are **always** flagged, including at purity 1.0.
- [x] Hungarian assignment lives in `packages/core/src/algo/hungarian.ts` with no dependency, is
      brute-force verified, and refuses above 64 speakers.
- [x] Speaker rename survives a re-diarization, demonstrated by the CLI sequence in Verification.
      *(Against the real pyannote sidecar, 2026-08-12, twice: `thibi diarize run <runId>` in
      place, and `thibi transcribe --job <id>` with a **different provider** — OpenAI then
      Groq into one job, both speakers `carried across`, "Daw Khin" still holding 9 segments
      and 124 words. Getting here needed amendments 45 and 46; the sequence this plan
      originally gave proved nothing.)*
- [x] `speakers` is scoped to `job_id`; `speaker_turns` keeps `raw_key`; `segments` carries
      `speaker_id`, `speaker_purity`, `needs_speaker_review`.
- [x] Diarization runs whole-file; no chunk-boundary speaker logic exists anywhere in the tree.
- [ ] The measured realtime factor is recorded per run and used for the next run's estimate.
      **Half done**: `diarization_runs.realtime_factor` is written on every successful run. The
      estimate printed before a run is still S6's 0.6x constant, because no instance has five
      real runs to average yet and averaging one stand-in's canned 0.6x would be a fiction
      dressed as a measurement.
- [x] `thibi transcribe interview.wav --diarize` works end to end on real audio, and
      `thibi diarize score` reports DER against an RTTM reference. Run 2026-08-12 through the
      built CLI: OpenAI `whisper-1` for ASR, the real pyannote 4.0.7 sidecar, reconcile at
      mean purity 1.00 with nothing flagged. `score` was verified against two hand-written
      RTTMs — 0.0% on an exact match, 16.7% on one disagreeing for 2.5 s of 15 s — and S8
      scored the container at DER 0.4%. **What has never been exercised** is anything longer
      than 34 s, any long-tail language, any audio with real overlap or crosstalk, and
      `--speakers`/`--min-speakers`/`--max-speakers`.
- [x] *(added 2026-08-11, done 2026-08-12)* The contract test — `PyannoteSource` against the
      real container, running the real model on committed two-speaker audio. Six assertions,
      ~40 s, skipped unless `/health` reports the model loaded. See *Tests* and overview
      amendment 47 for why it is not the canned pipeline this plan first asked for.
