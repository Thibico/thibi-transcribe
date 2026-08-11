/**
 * Score a diarized_json response against the constructed reference from s7-make-2spk.mjs.
 *
 * This is a diarization error rate over reference speech only, at 10 ms resolution:
 *
 *   miss       reference speech no hypothesis speaker covers
 *   confusion  reference speech attributed to the wrong speaker after optimal mapping
 *   false alarm hypothesis speech in reference silence  (reported, not folded into DER)
 *   DER        (miss + confusion) / reference speech
 *
 * It is deliberately *not* the NIST DER: there is no forgiveness collar around boundaries
 * and no overlap handling, because the reference has no overlap by construction. A collar
 * is what makes published DERs comparable across papers; leaving it off makes this number
 * strictly harsher than a published one, which is the safe direction for a go/no-go probe.
 *
 * Hypothesis-to-reference speaker mapping is brute-forced over all permutations, which is
 * the optimal mapping the Hungarian solver in packages/core would give and is tractable
 * here because the reference has two speakers.
 *
 *   node spikes/s7-score.mjs OUTDIR/en-2spk.truth.json OUTDIR/s7-en-2spk.json
 */
import { readFileSync } from 'node:fs';

const FRAME_MS = 10;

const truth = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const probe = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const segments = probe.body.segments ?? [];

const frames = Math.ceil(truth.durationMs / FRAME_MS);
const ref = new Array(frames).fill(null);
for (const t of truth.turns) {
  for (let f = Math.floor(t.startMs / FRAME_MS); f < Math.ceil(t.endMs / FRAME_MS) && f < frames; f++) {
    ref[f] = t.speakerKey;
  }
}
const hyp = new Array(frames).fill(null);
for (const s of segments) {
  const startMs = Math.round(s.start * 1000);
  const endMs = Math.round(s.end * 1000);
  for (let f = Math.floor(startMs / FRAME_MS); f < Math.ceil(endMs / FRAME_MS) && f < frames; f++) {
    hyp[f] = s.speaker;
  }
}

const refKeys = [...new Set(truth.turns.map((t) => t.speakerKey))].sort();
const hypKeys = [...new Set(segments.map((s) => s.speaker))].sort();

const permutations = (xs) =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

// Pad the shorter side so every hypothesis speaker gets a slot (or is mapped to nothing).
const slots = [...refKeys];
while (slots.length < hypKeys.length) slots.push(null);

let best = null;
for (const perm of permutations(slots)) {
  const map = new Map(hypKeys.map((k, i) => [k, perm[i] ?? null]));
  let correct = 0;
  for (let f = 0; f < frames; f++) {
    if (ref[f] !== null && hyp[f] !== null && map.get(hyp[f]) === ref[f]) correct++;
  }
  if (!best || correct > best.correct) best = { correct, map };
}

let refSpeech = 0, miss = 0, confusion = 0, falseAlarm = 0;
for (let f = 0; f < frames; f++) {
  if (ref[f] !== null) {
    refSpeech++;
    if (hyp[f] === null) miss++;
    else if (best.map.get(hyp[f]) !== ref[f]) confusion++;
  } else if (hyp[f] !== null) falseAlarm++;
}

const pct = (n) => `${((n / refSpeech) * 100).toFixed(1)}%`;
console.log(`reference     ${refKeys.length} speakers, ${truth.turns.length} turns, ${(refSpeech * FRAME_MS / 1000).toFixed(1)}s speech`);
console.log(`hypothesis    ${hypKeys.length} speakers, ${segments.length} segments`);
console.log(`mapping       ${[...best.map].map(([h, r]) => `${h}→${r ?? '(unmapped)'}`).join('  ')}`);
console.log(`miss          ${pct(miss)}`);
console.log(`confusion     ${pct(confusion)}`);
console.log(`false alarm   ${pct(falseAlarm)}  (of reference speech; not in DER)`);
console.log(`DER           ${pct(miss + confusion)}  no collar, no overlap`);

// Boundary error at every reference speaker change, matched to the nearest hypothesis
// speaker change. This is what actually matters for reconcile: a turn boundary off by
// 300 ms puts whole words on the wrong side.
// A change point is the start of a segment whose speaker differs from the previous
// segment's — not a frame-level transition, because the silence between turns makes every
// frame-level transition pass through null.
const hypChanges = segments
  .filter((s, i) => i > 0 && s.speaker !== segments[i - 1].speaker)
  .map((s) => Math.round(s.start * 1000));
const refChanges = truth.turns
  .filter((t, i) => i > 0 && t.speakerKey !== truth.turns[i - 1].speakerKey)
  .map((t) => t.startMs);
if (hypChanges.length) {
  const errors = refChanges.map((c) => Math.min(...hypChanges.map((h) => Math.abs(h - c))));
  const sorted = [...errors].sort((a, b) => a - b);
  console.log(
    `boundary      median ${sorted[Math.floor(sorted.length / 2)]}ms  max ${sorted.at(-1)}ms  ` +
      `over ${refChanges.length} reference speaker changes`,
  );
}
