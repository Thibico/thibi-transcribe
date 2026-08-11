/**
 * DER and JER against a hand-labelled RTTM reference.
 *
 * The thresholds in `reconcile.ts` — 0.6 margin, 400 ms, 0.6 purity, 500 ms nearest-gap,
 * 2 s identity floor — are **chosen, not measured**, and this file is the instrument that
 * lets Phase 5 move them on evidence instead of taste. It is deliberately a scorer for the
 * *diarization*, not for reconciliation: what it compares is turns against turns, so a bad
 * number here means the diarizer, and a good number here with a bad transcript means the
 * reconciler.
 *
 * Two honesty notes that belong with any figure this prints:
 *
 * - **No collar and no UEM.** NIST's convention forgives 250 ms either side of a reference
 *   boundary and scores only inside an evaluation map. Both make the number look better.
 *   Ours is the unforgiving version, so it is comparable to itself across threshold sweeps
 *   and *not* directly comparable to a published DER.
 * - **Overlap counts.** A region where the reference has two speakers contributes twice to
 *   the denominator, so a system that never emits overlap cannot score below the overlap
 *   fraction. pyannote does emit overlap; most hosted sources do not, and the difference
 *   shows up here rather than in a footnote.
 */
import { hungarian } from '@thibi/core';
import { intervalOverlapMs, totalMs } from './identity.js';
import type { Turn } from './types.js';

export interface RttmTurn extends Turn {
  /** The RTTM's file id. Kept so a multi-file reference can be filtered. */
  fileId: string;
}

/**
 * Parse NIST RTTM.
 *
 * `SPEAKER <file> <chan> <start> <dur> <ortho> <stype> <name> <conf> <slat>`, whitespace
 * separated, seconds as decimals. Only `SPEAKER` lines carry turns; everything else in the
 * format describes segmentation experiments we do not run. Comments start with `;;`.
 */
export function parseRttm(text: string): RttmTurn[] {
  const out: RttmTurn[] = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo += 1;
    const line = raw.trim();
    if (line === '' || line.startsWith(';;')) continue;
    const f = line.split(/\s+/);
    if (f[0] !== 'SPEAKER') continue;
    if (f.length < 8) {
      throw new Error(`RTTM line ${lineNo} has ${f.length} fields, expected at least 8: ${line}`);
    }
    const start = Number(f[3]);
    const dur = Number(f[4]);
    if (!Number.isFinite(start) || !Number.isFinite(dur)) {
      throw new Error(`RTTM line ${lineNo} has a non-numeric start or duration: ${line}`);
    }
    // Milliseconds everywhere, rounded once at the edge. Float seconds carried inward is
    // where frame-off errors live.
    out.push({
      fileId: f[1]!,
      startMs: Math.round(start * 1000),
      endMs: Math.round((start + dur) * 1000),
      speakerKey: f[7]!,
    });
  }
  return out;
}

export interface DerScore {
  /** Total reference speech, overlap counted once per simultaneous speaker. */
  totalMs: number;
  missMs: number;
  falseAlarmMs: number;
  confusionMs: number;
  /** `(miss + falseAlarm + confusion) / total`. Can exceed 1 — false alarm is unbounded. */
  der: number;
  /** Mean over reference speakers of `1 − Jaccard(ref, mapped hyp)`. Unmapped scores 1. */
  jer: number;
  referenceSpeakers: number;
  hypothesisSpeakers: number;
  /** The optimal reference→hypothesis label mapping the score was computed under. */
  mapping: Array<{ reference: string; hypothesis: string; overlapMs: number }>;
}

function bySpeaker(turns: readonly Turn[]): Map<string, Array<[number, number]>> {
  const m = new Map<string, Array<[number, number]>>();
  for (const t of turns) {
    if (t.endMs <= t.startMs) continue;
    const arr = m.get(t.speakerKey);
    if (arr) arr.push([t.startMs, t.endMs]);
    else m.set(t.speakerKey, [[t.startMs, t.endMs]]);
  }
  return m;
}

/**
 * Score a hypothesis against a reference.
 *
 * The optimal label mapping comes from the same Hungarian solver `identity.ts` uses, for the
 * same reason: greedy takes the single best pair first and can strand a later speaker with
 * the partner it needed more, which understates a system that got the diarization right and
 * the numbering shuffled — the exact case this is here to measure.
 */
export function scoreDiarization(reference: readonly Turn[], hypothesis: readonly Turn[]): DerScore {
  const ref = bySpeaker(reference);
  const hyp = bySpeaker(hypothesis);
  const refKeys = [...ref.keys()].sort();
  const hypKeys = [...hyp.keys()].sort();

  if (refKeys.length === 0) {
    throw new Error('The reference contains no speech, so there is nothing to score against.');
  }

  const size = Math.max(refKeys.length, hypKeys.length);
  const cost: number[][] = [];
  const ovl: number[][] = [];
  for (let i = 0; i < size; i++) {
    const c: number[] = [];
    const o: number[] = [];
    for (let j = 0; j < size; j++) {
      const v =
        i < refKeys.length && j < hypKeys.length
          ? intervalOverlapMs(ref.get(refKeys[i]!)!, hyp.get(hypKeys[j]!)!)
          : 0;
      o.push(v);
      c.push(-v);
    }
    cost.push(c);
    ovl.push(o);
  }

  const refToHyp = new Map<string, string>();
  const mapping: DerScore['mapping'] = [];
  for (const [i, j] of hungarian(cost)) {
    if (i >= refKeys.length || j >= hypKeys.length) continue;
    // A zero-overlap pairing is the solver filling out a square matrix, not a claim that
    // these two are the same speaker. Recording it would invent a mapping the data does not
    // support and make JER look better than it is.
    if (ovl[i]![j]! === 0) continue;
    refToHyp.set(refKeys[i]!, hypKeys[j]!);
    mapping.push({ reference: refKeys[i]!, hypothesis: hypKeys[j]!, overlapMs: ovl[i]![j]! });
  }

  // Elementary intervals: every boundary from either side, so within each slice the set of
  // active speakers on both sides is constant and the frame accounting is exact rather than
  // sampled at some frame rate we would then have to justify.
  const bounds = new Set<number>();
  for (const t of [...reference, ...hypothesis]) {
    if (t.endMs <= t.startMs) continue;
    bounds.add(t.startMs);
    bounds.add(t.endMs);
  }
  const points = [...bounds].sort((a, b) => a - b);

  let total = 0;
  let miss = 0;
  let falseAlarm = 0;
  let confusion = 0;

  const active = (
    sets: Map<string, Array<[number, number]>>,
    keys: string[],
    a: number,
    b: number,
  ): Set<string> => {
    const on = new Set<string>();
    for (const k of keys) {
      for (const [s, e] of sets.get(k)!) {
        if (s < b && e > a) {
          on.add(k);
          break;
        }
      }
    }
    return on;
  };

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const d = b - a;
    if (d <= 0) continue;
    const r = active(ref, refKeys, a, b);
    const h = active(hyp, hypKeys, a, b);
    let correct = 0;
    for (const rk of r) {
      const mapped = refToHyp.get(rk);
      if (mapped !== undefined && h.has(mapped)) correct += 1;
    }
    total += d * r.size;
    miss += d * Math.max(0, r.size - h.size);
    falseAlarm += d * Math.max(0, h.size - r.size);
    confusion += d * (Math.min(r.size, h.size) - correct);
  }

  // JER, as dscore defines it: per *reference* speaker, one minus the Jaccard index against
  // the hypothesis speaker it was mapped to. Averaging per speaker rather than per second is
  // the whole point — a speaker who says three words counts as much as one who says three
  // thousand, which DER does not capture and an interview very much has.
  let jerSum = 0;
  for (const rk of refKeys) {
    const mapped = refToHyp.get(rk);
    if (mapped === undefined) {
      jerSum += 1;
      continue;
    }
    const r = ref.get(rk)!;
    const h = hyp.get(mapped)!;
    const inter = intervalOverlapMs(r, h);
    const union = totalMs(r) + totalMs(h) - inter;
    jerSum += union > 0 ? 1 - inter / union : 1;
  }

  return {
    totalMs: total,
    missMs: miss,
    falseAlarmMs: falseAlarm,
    confusionMs: confusion,
    der: total > 0 ? (miss + falseAlarm + confusion) / total : 0,
    jer: jerSum / refKeys.length,
    referenceSpeakers: refKeys.length,
    hypothesisSpeakers: hypKeys.length,
    mapping,
  };
}
