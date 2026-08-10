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
| Phase 1 | `media_derivatives` `norm_16k_mono_flac` — ASR and diarization consume the *same* file |
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
| `apps/cli/src/commands/diarize.ts` | `thibi diarize score <run> --reference turns.rttm` — DER/JER for tuning |

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
has no business traversing the reverse proxy. TTL is `min(6 h, deadline + 30 min)`. The sidecar
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

alter table segments
  add column speaker_id           uuid references speakers(id),
  add column speaker_purity       real,
  add column needs_speaker_review boolean not null default false;
alter table words
  add column speaker_id uuid references speakers(id);

create index on segments (run_id) where needs_speaker_review;
create index on words (segment_id, idx);
```

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

| Device | Realtime factor | 1-hour file | 3-hour file |
|---|---|---|---|
| CPU, 8 cores | 0.15–0.4× | **2.5–7 h** | 7.5–20 h |
| One 12 GB GPU | 8–20× | 3–8 min | 9–25 min |

These are design decisions, not caveats:

1. **Diarization is off by default.** `--diarize` is opt-in in the CLI; the UI checkbox shows the
   estimate — *"≈4 h 10 m on this machine"* — **before** the run starts, not after.
2. `deadline_at = max(10 min, 12 × duration)`. Generous, because the alternative is killing a job
   at hour six.
3. Progress must come from pyannote's `ProgressHook`, forwarded as task `progress` and into
   `run_events`. Without it an operator watches nothing happen for hours and concludes it hung.
4. `worker-heavy` runs at concurrency 1, and the estimate shown to the user is computed from the
   **measured** `realtime_factor` of the last five `diarization_runs` on this instance, not a
   constant. The number gets more honest on its own.
5. The docs say outright that the GPU tier is the difference between "overnight" and "coffee". This
   belongs in the deployment guide's tier table, not in a footnote.

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

Contract test in CI: the TypeScript `PyannoteSource` runs against the real container
(`docker compose run --rm sidecar`) with the canned pipeline, so the JSON schema cannot drift
between the two languages without a red build.

## Verification

```
$ docker compose --profile local up -d sidecar
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

**The headline demo — identity survives re-transcription:**

```
$ thibi speakers rename <jobId> speaker-01 "Daw Khin"
$ thibi transcribe fixtures/interview-2spk-6min.wav --lang my --diarize      # new run
$ thibi runs show <newRunId> --speakers
speaker-00  (unnamed)  61%
speaker-01  Daw Khin   39%          ← carried across, via Hungarian on attributed time
```

**Restart resilience:** `docker compose restart sidecar` mid-task → engine polls, sees `lost`,
counts an attempt, resubmits once, completes.

**Single slot:** launch two `--diarize` runs at once → the second reports *"diarizer busy, retrying
in 60s"* and eventually succeeds. It must never surface as an error.

**No-words path:** run `no-words-oromo` audio end to end → every segment carries
`needs_speaker_review = true` and the export marks them.

**Tuning hook:** `thibi diarize score <runId> --reference fixtures/interview.rttm` prints DER and
JER, so the thresholds in §3 can be moved on evidence in Phase 5.

## Risks and open questions

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

- [ ] `services/sidecar` builds one image and serves `/health`, `POST /v1/diarize`,
      `GET /v1/tasks/{id}`, `DELETE /v1/tasks/{id}` with the exact schemas above.
- [ ] `task_id = uuid5(NAMESPACE_URL, run_step_id)`; a re-POST with the same key never starts a
      second run, and a restart yields `lost`, not 404.
- [ ] `MAX_CONCURRENT_TASKS=1` enforced by semaphore; a second key gets 429 + `Retry-After`, and
      the engine does not count it as an attempt.
- [ ] Every failure maps to a code in the taxonomy table with the documented retryability; the
      temp audio file is deleted on every path.
- [ ] Audio reaches the sidecar only as an internally-presigned MinIO URL; the sidecar holds no
      credentials and no database connection.
- [ ] `DiarizationSource` implemented twice — pyannote and Scribe — with Scribe collapsing diarized
      words into turns via `wordsToTurns`, and reconcile seeing only `Turn[]`.
- [ ] `reconcile.ts` implements all five steps; `margin` is defined in exactly one place.
- [ ] Both median-filter guards are covered by separate fixtures, so dropping either one fails CI.
- [ ] `has_words = false` segments are **always** flagged, including at purity 1.0.
- [ ] Hungarian assignment lives in `packages/core/src/algo/hungarian.ts` with no dependency, is
      brute-force verified, and refuses above 64 speakers.
- [ ] Speaker rename survives a re-diarization, demonstrated by the CLI sequence in Verification.
- [ ] `speakers` is scoped to `job_id`; `speaker_turns` keeps `raw_key`; `segments` carries
      `speaker_id`, `speaker_purity`, `needs_speaker_review`.
- [ ] Diarization runs whole-file; no chunk-boundary speaker logic exists anywhere in the tree.
- [ ] The measured realtime factor is recorded per run and used for the next run's estimate.
- [ ] `thibi transcribe interview.wav --diarize` works end to end on real audio, and
      `thibi diarize score` reports DER against an RTTM reference.

