# Phase 0 spikes — recorded answers

Questions that could invalidate parts of the design. **A spike without a row here is not
done**, and downstream plans cite the row rather than folklore.

S1–S3 ran **2026-08-09** · project `myanmar-transcription` · region `asia-southeast1` ·
model `chirp_2` · clip `asean-myanmar.m4a`, 105.8 s of Burmese news audio normalised to
16 kHz mono FLAC. Long inputs synthesised by concatenating that clip 17× and 68× and
re-encoding (FLAC `-c copy` leaves the original duration in STREAMINFO).

S4–S5 ran **2026-08-10** at the top of Phase 2, against the staging bucket
`gs://thibi-stt-staging-asse1` and the Cloud Billing Catalog. They exist because S3 left
two things unsettled that Phase 2 rests on entirely — whether the credentials can validate
a staging bucket, and whether batch is actually cheaper — and building on either
unmeasured would have been the exact mistake this project exists to avoid.

| id | date | region | model | verdict | evidence | raw |
|----|------|--------|-------|---------|----------|-----|
| S1 | 2026-08-09 | asia-southeast1 | chirp_2 | **FAIL — adaptation is inert on Chirp.** Boost 0/10/20 byte-identical; relevant keyterms produced zero lexical change and did not fix the targeted error; an *irrelevant* phrase set corrupted အာဆီယံ → အာစီယံ in all five occurrences. | Never send `config.adaptation` to Chirp. The glossary entity pass in Phase 6 is the *only* entity mechanism for the exclusive-language set, not a supplement. Nothing in the product may promise keyterm biasing on Google. | `raw/s1-*.json` |
| S2 | 2026-08-09 | asia-southeast1 | chirp_2 | **PASS — word confidence is genuine, across the long tail.** On 50 s of Burmese: 101/101 words carried a confidence, with **101 distinct values** over 0.728–0.99, and 101/101 carried both start and end offsets. Confirmed per language over a ten-language sample (below). | Low-confidence QA highlighting (Phase 12) is viable on the primary provider, for the long-tail languages too. One distinct value would have meant a placeholder. | `raw/base.json` |
| S3 | 2026-08-09 | asia-southeast1 | chirp_2 | **Works, but it is the slow path.** Flat 5.9× realtime (305 s for 30 min, 1211 s for 2 h) against chunked parallel sync's 43 s and 338 s at concurrency 8 — 3.6–7× faster at every size, zero 429s across 136 requests. | The 15-minute duration threshold is deleted. Chunked sync is the default at any length; batch becomes an admin cost choice justified only by the Dynamic Batch SKU and sync-quota pressure. | `raw/batch-*.json` |
| S4 | 2026-08-10 | asia-southeast1 | — | **FAIL then PASS — `roles/storage.objectAdmin` cannot read bucket metadata.** Write 200, delete 204, `storage.buckets.get` **403**, so region and lifecycle were unverifiable and Phase 2 would have refused a correctly configured bucket. After granting `roles/storage.legacyBucketReader`: `ASIA-SOUTHEAST1`, `region`, `STANDARD`, `Delete age=1`. | The remediation in the plan changes from `roles/storage.admin` to `roles/storage.legacyBucketReader`. Fold case before comparing `location`. The Speech service agent needed nothing — a same-project bucket is covered by the project's automatic `roles/speech.serviceAgent`. | — |
| S5 | 2026-08-10 | — | — | **PASS — the Dynamic Batch rate advantage is real: 5.33×.** `Cloud Speech-to-Text Recognition` $0.016/min against `Cloud Speech-to-Text Dynamic Batch Recognition` $0.003/min, from the Cloud Billing Catalog rather than from documentation. | Batch's one surviving justification holds, so Phase 2 is worth building. Recognition is tiered and Dynamic Batch is flat, so the ratio belongs in the `rates` table, not in code. A `(Logged)` SKU is 25% cheaper in exchange for Google retaining the audio: never a default. | — |

## S2 per language, over the sample most likely to be missing the word array

The phase plan requires S2's verdict per language, not as one global answer. Run against
the committed 2 s probe clip (`fixtures/probe-2s.flac`, Burmese) on 2026-08-09:

```
lang     segs  words  withConf  distinct  minConf  maxConf  withOffsets  segConf
my-MM       1      5         5         5    0.738    0.973            5    0.933
ha-NG       1     10        10        10    0.245    0.606           10    0.442
yo-NG       1      6         6         6    0.461    0.969            6    0.885
am-ET       1      5         5         5    0.254    0.545            5    0.464
km-KH       1      8         8         8    0.453    0.772            8    0.615
ps-AF       1      1         1         1    0.970    0.970            1    0.969
ceb-PH      1      6         6         6    0.431    0.970            6    0.892
om-ET       1      4         4         4    0.788    0.957            4    0.884
zu-ZA       1      5         5         5    0.128    0.333            5    0.357
si-LK       1      6         6         6    0.484    0.692            6    0.567
```

Every language returned words, every word carried a confidence and both offsets, and
`distinct == words` throughout. Nothing here is a placeholder. (`ps-AF` shows one distinct
value because it returned one word; with n=1 that is not the placeholder signal.)

**The confidence signal is calibrated, which is the more useful finding.** The clip is
Burmese. Asked to hear it as Zulu, Chirp returns 0.128–0.333; asked to hear it as Burmese,
0.738–0.973. Confidence tracks whether the model is actually right rather than decorating
the output, which is what makes Phase 12's uncertain-word toolbar worth building and gives
its 0.6 default threshold an empirical basis rather than a round number.

Bonus control, and load-bearing for everything above: **Chirp 2 is deterministic.** Two
identical requests returned byte-identical transcripts (`sha1 c1202dd838f7`, 649 chars).
Without it no diff here can be told apart from sampling noise. It also means the Phase 5
eval harness needs no repeat-and-average for a fixed input.

Three further measurements from S3 that changed the implementation:

- **`done: true` does not mean success.** An operation reported `done`, `progressPercent:
  100` and no operation-level error while `results[uri].error` was set (code 13,
  `totalBilledDuration: "0s"`). It hit **1 run in 5** and an immediate retry succeeded.
  `pollBatch` must treat the per-file error as authoritative.
- **Hard cuts lose 2–3 words per seam** — 68 words (2.1%) at 30 min over 33 seams, 435
  (3.4%) at 2 h over 135. This is the measured justification for the Phase 1
  overlap-and-LCS merge, which until then was a hypothesis.
- **Sequential chunk cutting dominates long-file prep**: 200 s of the 338 s two-hour total
  is ffmpeg cutting 136 chunks one at a time. Parallelise it.

~~Still unverified: the Dynamic Batch **rate** advantage.~~ **Settled 2026-08-10, at the top
of Phase 2.** `totalBilledDuration` reports audio duration and not price, but the Cloud
Billing Catalog API publishes the SKUs directly and needs no bill to have arrived:

| SKU (service `63DE-82AB-F564`, *Cloud Speech API*) | unit | USD |
|---|---|---|
| Cloud Speech-to-Text Recognition | minute | **0.016**, tiering to 0.010 above 500k min/mo |
| Cloud Speech-to-Text Dynamic Batch Recognition | minute | **0.003**, flat |
| Cloud Speech-to-Text Recognition (Logged) | minute | 0.012 |
| Cloud Speech-to-Text Dynamic Batch Recognition (Logged) | minute | 0.00225 |

**5.33× cheaper, so batch's one surviving justification holds.** Two riders. Recognition is
tiered and Dynamic Batch is flat, so the ratio is a property of the tier rather than a
constant — this is why the numbers are seeded into `rates` rather than written in code. And
the `(Logged)` SKUs are 25% off in exchange for Google retaining the audio to train on; for a
newsroom transcribing confidential sources that is a disclosure, not a saving. Neither is
seeded and no code sets the flag.

What remains open is narrower than it was: the catalog gives the *price of the SKU we believe
we used*, not the invoice. Confirming that a `DYNAMIC_BATCHING` submission is billed against
Dynamic Batch rather than Recognition needs the billing export and a run id, and is recorded
as risk 8 in the Phase 2 plan.

Also settled 2026-08-10, both against the live bucket and both recorded in the Phase 2 plan
(§5) and the overview's amendments 22 and 23:

- **`roles/storage.objectAdmin` cannot read bucket metadata.** Write 200, delete 204,
  `storage.buckets.get` **403**. The obvious grant for a staging bucket leaves the region and
  the lifecycle rule unverifiable. `roles/storage.legacyBucketReader` is the narrow fix.
- **The Speech service agent needed no bucket grant at all.** It is absent from the bucket's
  IAM policy; the project-level `roles/speech.serviceAgent` binding created with the API
  covers it. That is why S3 worked. The cross-project case is still a hazard.
- GCS returns `location` upper-cased — `ASIA-SOUTHEAST1`. Fold case before comparing.

**The full method, numbers, limits and Burmese readings are in
[../plans/phase-00-spike-results.md](../plans/phase-00-spike-results.md).** This file is the
index; that one is the analysis.

## Reproducing

The scripts are committed so a disputed number can be re-measured rather than argued about.
They read `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_REGION`, `GOOGLE_MODEL` and
`GOOGLE_GCS_STAGING_BUCKET` from `.env` — see `.env.example`.

```bash
node spikes/s1-adaptation.mjs      fixtures/clip.flac          # the A/B, five cells
node spikes/s2-word-confidence.mjs fixtures/clip.flac          # census over ten languages
node spikes/s3-batch-recognize.mjs long-2h.flac 2h DYNAMIC_BATCHING
node spikes/s3-chunked-sync.mjs    8 ./chunks                  # the comparison
node spikes/get-operation.mjs      projects/…/operations/…     # resume a poll
node spikes/s4-staging-preflight.mjs                           # bucket, IAM, lifecycle
node spikes/s5-rates.mjs                                       # the billing catalog
```

`s5-rates.mjs` uses the developer's own `gcloud` credential rather than the service account:
the catalog needs no project permission but does need a token, and there is no reason for
the app's account to hold one for this.

`spikes/raw/` holds the response bodies and is gitignored — several MB of provider JSON.
The distilled numbers are here and in the plans document.

### Deviation from the phase plan, recorded rather than hidden

The plan specified `spikes/RESULTS.md` plus shell scripts (`token.sh`, `s1-adaptation.sh`,
`s3-batch-recognize.sh`). The spikes were actually run from ad-hoc Node scripts and the
analysis was written straight into `plans/phase-00-spike-results.md`. What is committed
here is those working scripts, cleaned up, plus this summary table — not a set of shell
scripts reconstructed to match a plan and never executed. The numbers came from the code
in this directory.
