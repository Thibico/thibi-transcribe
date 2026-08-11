# Reconciliation fixtures

**These are hand-written, and that is correct here** — which is the opposite of the rule in
`providers/whisper/__fixtures__/`, so it is worth saying why.

Those fixtures pin the shape of somebody else's API, and a hand-written one would only ever
test that the parser matches our *memory* of that shape. These pin the behaviour of an
algorithm we wrote against inputs we chose. There is no external truth to record: the
question is "given these turns and these words, what should reconcile decide", and the
answer is a design decision, not an observation.

Recorded pyannote output belongs in this directory too once Phase 3's sidecar can produce
it — as an end-to-end case, not a replacement for these. A real 40-minute diarization is
useless as a unit fixture precisely because nothing in it is isolated.

Each file is `{ name, why, turns, segments, words, expect }`, except the three
`rediarize-*` ones which are `{ name, why, prior, fresh, expect }` and drive
`identity.ts` instead.

**The `why` field is the point of the file.** Every fixture here encodes a decision that
somebody will later be tempted to simplify away, and `why` is the argument against doing
that, sitting next to the case that proves it.

| Fixture | Asserts |
|---|---|
| `two-speaker-clean.json` | The baseline: purity 1.0, no reviews, no flips |
| `flicker-single-word.json` | A 180 ms token across a turn edge, margin 0.30 → **flipped** |
| `interjection-genuine.json` | A 620 ms *"Yes."* at margin 0.90 → **not flipped**. Both guards refuse |
| `interjection-short-but-certain.json` | 200 ms at margin 0.95 → not flipped by the **margin** guard alone |
| `interjection-long-but-uncertain.json` | 700 ms at margin 0.20 → not flipped by the **duration** guard alone |
| `turn-shorter-than-word.json` | A 120 ms turn inside a 900 ms word → dominant speaker wins, margin drops to 0.76 |
| `overlapping-turns.json` | Same-speaker overlapping turns **accumulate**; without it the wrong speaker wins |
| `gap-no-turn.json` | Within 500 ms → `nearest` at margin 0; beyond it → `null`, never a guess |
| `no-words-oromo.json` | `hasWords: false` → interval fallback, **every** segment flagged, including at purity 1.0 |
| `rediarize-identity.json` | Three names survive a permuted re-diarization |
| `rediarize-new-speaker.json` | A fresh 4th with 1.2 s of overlap → **new row**, not a hijack |
| `rediarize-fewer-speakers.json` | Fresh finds 2; the prior third is retained, unmapped |

The two `interjection-*-but-*` fixtures exist as a matched pair so that dropping either
guard from `medianSmooth` fails CI. `interjection-genuine` alone would not catch it: both
guards refuse that one, so removing one still leaves the other holding.
