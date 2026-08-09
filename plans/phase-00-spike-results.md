# Phase 0 — spike results

Recorded answers to the three decision gates in
[phase-00-spikes-and-registries.md](./phase-00-spikes-and-registries.md). Each gate names the
design change its outcome forces.

**Run date:** 2026-08-09 · **Project:** `myanmar-transcription` · **Region:** `asia-southeast1`
· **Model:** `chirp_2` · **Clip:** `asean-myanmar.m4a`, 105.8 s Burmese news audio, normalised to
16 kHz mono FLAC, first 50 s used for the sync spikes (Google's sync ceiling is 60 s).

---

## Control: Chirp 2 is deterministic

Two identical requests returned **byte-identical** transcripts (`sha1 c1202dd838f7`, 649 chars).

This control is load-bearing: without it, no diff below can be distinguished from sampling
noise. It also means the eval harness does not need to average across repeated runs for a fixed
input, which removes a cost multiplier from Phase 5.

---

## S2 — Is `wordConfidence` populated on Chirp? **PASS**

| Measure | Result |
|---|---|
| Words with a `confidence` field | 101 / 101 |
| **Distinct** confidence values | **101** — genuine per-word variance, not a placeholder |
| Range | 0.728 – 0.99 |
| Words with both `startOffset` and `endOffset` | 101 / 101 |
| Segment-level confidence | Present (0.90085196, 0.8982026) |

`enableWordConfidence: true` and `enableWordTimeOffsets: true` both work on `chirp_2` for
`my-MM`.

**Design consequence:** none — the design assumed this and it holds. Low-confidence QA
highlighting (Phase 12) is viable on the primary provider, and `word_timing_quality` is `full`
for Burmese. The `has_words = false` degradation path is still required, because this result
covers one language; do not generalise it to the long tail without measuring.

---

## S1 — Does Chirp honour speech adaptation? **FAIL — do not ship pre-recognition biasing**

Method: the same 50 s clip, five runs. A relevant phrase set at boost 0 / 10 / 20, a control
phrase set of five *irrelevant* Burmese nouns (egg, goat meat, basketball, television, banana)
at boost 15, and the no-adaptation baseline. Diffs classified as lexical vs punctuation-only.

Relevant terms: `အပစ်အခတ်ရပ်စဲရေး` (ceasefire), `စစ်ကောင်စီ` (military council),
`ဘုံသဘောတူညီချက်ငါးရပ်` (five-point consensus), `နေပြည်တော်` (Naypyidaw),
`အာဆီယံထိပ်သီးအစည်းအဝေး` (ASEAN summit).

| Run | HTTP | Lexical changes vs baseline |
|---|---|---|
| baseline (no adaptation) | 200 | — |
| relevant, boost 0 | 200 | **0** |
| relevant, boost 10 | 200 | **0** |
| relevant, boost 20 | 200 | **0** |
| irrelevant, boost 15 | 200 | **6 — all regressions** |

Four findings, in order of how much they matter:

1. **The boost value is inert.** Boost 0, 10 and 20 produced byte-identical output. A working
   implementation would show *some* sensitivity between no boost and maximum boost.
2. **Relevant keyterms produced zero lexical change.** The only differences from baseline were
   five inserted `။` sentence marks and one spacing merge (`ဆွေးနွေး ပွဲ` → `ဆွေးနွေးပွဲ`) —
   the punctuation path, not the lexicon. The targeted error was not corrected: the clip's
   "ceasefire" remained `အပြစ် အခက် ရပ်ဆဲ`, a three-syllable homophone corruption of
   `အပစ်အခတ်ရပ်စဲ`, despite the correct form being in the phrase set.
3. **Irrelevant keyterms actively degraded the transcript.** `အာဆီယံ` (ASEAN, correct in
   baseline) became `အာစီယံ` in **all five occurrences**. Supplying a phrase set is therefore
   not free — a stale or over-broad glossary makes output worse.
4. Presence of the `adaptation` field perturbs decoding whatever it contains. Nonsense, relevant
   and absent all produced three distinct outputs, so the field is *consumed*; it is simply not
   consumed as lexical bias.

**Design consequences — these amend the plans:**

- **Do not send `config.adaptation` to Chirp.** It cannot help and can hurt. `adaptation` stays
  a probed per-`(provider, model, language)` capability, and for `chirp_2` it is
  `adaptation: "none"` until re-measured.
- **The glossary's ASR-side consumer disappears for the primary provider.** Phase 6's
  glossary-assisted entity-correction pass is not a supplement to keyterm biasing — for the
  exclusive-language set it is the *only* entity mechanism. Its priority rises accordingly.
- Glossary terms still reach the Whisper providers through `initial_prompt` / `prompt`
  (Phase 4), where the mechanism is different and unmeasured. Measure before claiming it there.
- **Nothing in the product may promise keyterm biasing on Google.** Not the docs, not the
  glossary UI's help text, not the roadmap.

**Limits of this result.** One clip, one language, five terms, one model. It is strong evidence
of boost-inertness and zero benefit, not proof that no phrase set helps any language. The
Burmese readings above should be confirmed by a native speaker; the `အာဆီယံ` → `အာစီယံ`
regression is unambiguous, the ceasefire reading is high-confidence but not verified. Re-run
this A/B whenever the Google model changes, and extend it to `chirp_3` if that becomes the
default. The harness in Phase 5 should carry it as a standing check rather than a one-off.

---

## S3 — Does `batchRecognize` work end to end? **YES — but it is the slow path, not the fast one**

Long inputs were synthesised by concatenating the 105.8 s clip (17× and 68×) and re-encoding
rather than stream-copying, since FLAC `-c copy` leaves the original duration in STREAMINFO.
Content repetition is irrelevant to a latency measurement.

### The headline result

| Input | `batchRecognize` | Chunked parallel sync (prep + ASR, concurrency 8) | Sync advantage |
|---|---|---|---|
| 106 s | 31 s | — | — |
| 30 min | **305 s** (5.9× realtime) | **43 s** = 12 s prep + 30.5 s / 34 chunks | **7.1×** |
| 2 h | **1211 s** (5.94× realtime) | **338 s** = 202 s prep + 135.7 s / 136 chunks | **3.6×** |

Batch throughput is almost exactly linear at **5.9× realtime** across both sizes, so it will
not overtake chunked sync at any duration. **Chunked parallel sync is faster everywhere.**

**This overturns the routing rule.** `00-overview.md` justified the sync/batch split on latency
and set the threshold at 15 minutes. That rationale is wrong. The only reasons to use batch are:

1. **Cost** — the Dynamic Batch SKU, if the rate difference is real (see caveat below).
2. **Sync quota pressure** — many concurrent jobs competing for the same per-project quota.

Neither is latency. Amended rule:

```
default                          → chunked parallel sync, any duration
admin opts into "cheaper, slower" → batchRecognize + DYNAMIC_BATCHING
sync quota exhausted / 429 storm  → fall back to batch
```

The choice is a cost/latency trade the admin makes, not something the engine infers from
duration. For a journalist waiting on a transcript, sync is strictly better.

### Rate limiting: not a constraint at this scale

**136 sync requests at concurrency 8 produced zero 429s and zero retries.** Chunked sync for
multi-hour files is viable, which is the precondition for the rule above. Higher concurrency is
untested; 8 is the measured-safe value and should be the default.

### `done: true` does not mean success

The first 106 s run returned `done: true`, `progressPercent: 100`, **no operation-level error**
— and, buried in the per-file result:

```json
"results": { "gs://…/audio.flac": {
    "uri": "gs://…/out/audio_transcript_….json",
    "error": { "code": 13, "message": "An internal error occurred." } } },
"totalBilledDuration": "0s"
```

A poller trusting `operation.done` and `operation.error` reports success, then fails to find an
output object that was never written. **It hit 1 run in 5.** An immediate retry succeeded, so
code 13 here is transient.

**Design consequence:** `pollBatch` must treat `response.results[<uri>].error` as authoritative,
classify code 13 as retryable, and re-submit. `totalBilledDuration: "0s"` confirms failed files
are not billed, so retrying is free. This is not an edge case at a 20% observed rate.

### Chunk cutting is the bottleneck, and it is sequential

At 2 h, prep is 202 s of the 338 s total — and 200 s of that is ffmpeg cutting 136 chunks **one
at a time**. `silencedetect` over 2 h takes 2 s; the cutting dominates. The old implementation
(`lib/audio/chunk.ts`) is a sequential `for` loop and Phase 1 inherits it.

**Design consequence:** parallelise chunk cutting across cores. Prep drops to roughly 30 s and
the 2 h total to about 165 s — **7× faster than batch**, matching the 30-minute ratio. Without
this, prep becomes the dominant cost on exactly the long files the product is for.

### Seam loss is real and now quantified

Same audio, same model, no overlap configured:

| Input | Batch (one pass, no seams) | Chunked sync | Loss |
|---|---|---|---|
| 30 min | 3207 words | 3139 | 68 (2.1%), 33 seams → ~2.1 words/seam |
| 2 h | 12907 words | 12472 | 435 (3.4%), 135 seams → ~3.2 words/seam |

**Roughly 2–3 words are lost at every hard cut.** This is the measured justification for the
Phase 1 overlap-and-LCS merge, which until now was a hypothesis. It is also the one quality
argument in batch's favour: a single pass has no seams at all.

### `DYNAMIC_BATCHING` works, and the rate claim is still unverified

Accepted as `processingStrategy`; on the 106 s clip it took 30.8 s vs 31.2 s for default and
produced byte-identical output — no latency penalty at that size.

**But `totalBilledDuration` reports audio duration, not price** — 106 s for both strategies,
1800 s for the 30-minute run. The API cannot confirm a cheaper rate. The $0.016 vs $0.003
figure quoted in `GCP-SETUP.local.md` comes from the SKU catalogue, not from measurement, and
since cost is now batch's *only* justification, **it should be verified against the actual bill
before the routing rule is written into code.**

### Output correctness

Batch output matches sync in kind: word-level timings and confidence throughout
(12907/12907 on the 2 h run), offsets absolute to the whole file (last word ends at 7196.8 s of
7198.7 s). Output lands as JSON in GCS at
`gcsOutputConfig.uri` + `/audio_transcript_<opid>.json`, never inline.

### Staging environment, verified

### Staging environment, verified

| Check | State |
|---|---|
| Bucket | `thibi-stt-staging-asse1` |
| Location | `ASIA-SOUTHEAST1`, `location_type: region` — matches the recognizer |
| Lifecycle | Delete at age 1 day |
| Access | Uniform bucket-level access; public access prevention enforced |
| IAM | `roles/storage.objectAdmin`, service account only, scoped to this bucket |
| Round trip as the service account | write 200 · read 200 · list 200 · delete 204 |

### Incidental finding

The Speech v2 API returned `200` from **`asia-southeast1`, `europe-west4` and `us-central1`**
for this project. Independent confirmation of the research finding that the region doctrine in
the old app was wrong, and justification for having deleted it from four places in the port.
