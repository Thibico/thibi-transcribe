# Phase 0 spikes — recorded answers

Three questions that could invalidate parts of the design. **A spike without a row here is
not done**, and downstream plans cite the row rather than folklore.

Run **2026-08-09** · project `myanmar-transcription` · region `asia-southeast1` · model
`chirp_2` · clip `asean-myanmar.m4a`, 105.8 s of Burmese news audio normalised to 16 kHz
mono FLAC. Long inputs synthesised by concatenating that clip 17× and 68× and re-encoding
(FLAC `-c copy` leaves the original duration in STREAMINFO).

| id | date | region | model | verdict | evidence | raw |
|----|------|--------|-------|---------|----------|-----|
| S1 | 2026-08-09 | asia-southeast1 | chirp_2 | **FAIL — adaptation is inert on Chirp.** Boost 0/10/20 byte-identical; relevant keyterms produced zero lexical change and did not fix the targeted error; an *irrelevant* phrase set corrupted အာဆီယံ → အာစီယံ in all five occurrences. | Never send `config.adaptation` to Chirp. The glossary entity pass in Phase 6 is the *only* entity mechanism for the exclusive-language set, not a supplement. Nothing in the product may promise keyterm biasing on Google. | `raw/s1-*.json` |
| S2 | 2026-08-09 | asia-southeast1 | chirp_2 | **PASS — word confidence is genuine, across the long tail.** On 50 s of Burmese: 101/101 words carried a confidence, with **101 distinct values** over 0.728–0.99, and 101/101 carried both start and end offsets. Confirmed per language over a ten-language sample (below). | Low-confidence QA highlighting (Phase 12) is viable on the primary provider, for the long-tail languages too. One distinct value would have meant a placeholder. | `raw/base.json` |
| S3 | 2026-08-09 | asia-southeast1 | chirp_2 | **Works, but it is the slow path.** Flat 5.9× realtime (305 s for 30 min, 1211 s for 2 h) against chunked parallel sync's 43 s and 338 s at concurrency 8 — 3.6–7× faster at every size, zero 429s across 136 requests. | The 15-minute duration threshold is deleted. Chunked sync is the default at any length; batch becomes an admin cost choice justified only by the Dynamic Batch SKU and sync-quota pressure. | `raw/batch-*.json` |

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

Still unverified: the Dynamic Batch **rate** advantage. `totalBilledDuration` reports audio
duration, not price, so the API cannot confirm the $0.016-vs-$0.003 figure. Since cost is
now batch's only justification, confirm against the actual bill before writing the routing
rule into code.

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
```

`spikes/raw/` holds the response bodies and is gitignored — several MB of provider JSON.
The distilled numbers are here and in the plans document.

### Deviation from the phase plan, recorded rather than hidden

The plan specified `spikes/RESULTS.md` plus shell scripts (`token.sh`, `s1-adaptation.sh`,
`s3-batch-recognize.sh`). The spikes were actually run from ad-hoc Node scripts and the
analysis was written straight into `plans/phase-00-spike-results.md`. What is committed
here is those working scripts, cleaned up, plus this summary table — not a set of shell
scripts reconstructed to match a plan and never executed. The numbers came from the code
in this directory.
