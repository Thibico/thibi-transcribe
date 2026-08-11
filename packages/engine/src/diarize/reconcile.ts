/**
 * Reconciliation — turning speaker *turns* into per-word and per-segment attribution.
 *
 * This is the centrepiece of Phase 3 and the hardest correctness problem in the product.
 * ASR and diarization run against the same normalized derivative but know nothing about
 * each other: ASR produces words with timings, diarization produces spans with speakers,
 * and neither has any notion of the other's boundaries. Everything a user sees — "who said
 * this", the export's speaker prefixes, the editor's review flags — comes out of the five
 * steps below.
 *
 * Two properties hold throughout, and both are load-bearing:
 *
 * - **It runs once, over the whole timeline.** Diarization is whole-file, so chunk
 *   boundaries are invisible here. This is the entire answer to "how do you keep speaker
 *   identity across chunk boundaries": you don't chunk.
 * - **It never silently attributes.** Every uncertain outcome is representable — a null
 *   speaker, a low margin, a low purity, a `needsReview` flag — and the fallback path for
 *   wordless segments is flagged unconditionally. A confident wrong speaker label is worse
 *   than an honest "unknown", because the user cannot see it to correct it.
 */
import type { Turn } from './types.js';

/** A word as the reconciler needs it. `id` is the `words` row id. */
export interface RWord {
  id: string;
  segmentId: string;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface RSegment {
  id: string;
  idx: number;
  startMs: number;
  endMs: number;
  /**
   * False ⇒ the provider returned no words for this segment, and the interval fallback
   * runs. Chirp returns empty word arrays exactly for the long-tail languages this product
   * exists for, so this is a main path, not an edge case.
   */
  hasWords: boolean;
}

export interface ReconcileOptions {
  /** Attach a word to a turn it does not overlap, if the gap is no wider than this. */
  nearestGapMs: number;
  /** Only smooth words whose assignment margin is below this — see `medianSmooth`. */
  medianMarginMax: number;
  /** Only smooth words shorter than this. */
  medianDurationMaxMs: number;
  /** Segments below this purity are flagged for human review. */
  purityReviewBelow: number;
  minIdentityOverlapMs: number;
  minIdentityOverlapFrac: number;
}

/**
 * **Initial values, unmeasured.** Every number here was chosen from reasoning about the
 * failure modes, not from data. `thibi diarize score` reports DER/JER against a
 * hand-labelled RTTM so Phase 5 can move them on evidence. Do not cite them as findings.
 */
export const DEFAULTS: ReconcileOptions = {
  nearestGapMs: 500,
  medianMarginMax: 0.6,
  medianDurationMaxMs: 400,
  purityReviewBelow: 0.6,
  minIdentityOverlapMs: 2000,
  minIdentityOverlapFrac: 0.2,
};

export interface WordAssignment {
  wordId: string;
  speakerKey: string | null;
  /**
   * `(best − runnerUp) / (best + runnerUp)` ∈ [0,1]. 1 = uncontested, 0 = a dead tie.
   *
   * Defined **once, here**, and never redefined. Everything downstream that means "we are
   * unsure about this word" means this number.
   */
  margin: number;
  source: 'overlap' | 'nearest' | 'median' | 'none';
}

export interface SegmentAssignment {
  segmentId: string;
  speakerKey: string | null;
  /** Fraction of the segment's word-duration belonging to the winning speaker. */
  purity: number;
  needsReview: boolean;
  source: 'words' | 'interval' | 'none';
}

export interface ReconcileStats {
  words: number;
  assignedByOverlap: number;
  assignedByNearest: number;
  medianFlips: number;
  unassignedWords: number;
  segments: number;
  segmentsByInterval: number;
  meanPurity: number;
  flaggedForReview: number;
}

export interface ReconcileResult {
  words: WordAssignment[];
  segments: SegmentAssignment[];
  stats: ReconcileStats;
}

const overlapMs = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * A zero-length word still has to be attributable.
 *
 * Providers do emit `start === end`, and under a plain overlap test such a word overlaps
 * nothing — it would fall through to `nearest`, or to null, purely because of a timing
 * quirk rather than because anything was ambiguous. Widening it to 1 ms puts it inside
 * whichever turn contains that instant. `voteSegments` makes the matching allowance when
 * weighting.
 */
const wordSpan = (w: RWord): [number, number] =>
  w.endMs > w.startMs ? [w.startMs, w.endMs] : [w.startMs, w.startMs + 1];

/**
 * Time order for the reconciler's working copy.
 *
 * `(startMs, endMs, segment idx, word idx)`, so the order is total and deterministic —
 * two words starting and ending at the same millisecond still sort stably, and an
 * identical input always produces an identical result.
 */
const byTime = (segmentIdx: Map<string, number>) => (a: RWord, b: RWord): number =>
  a.startMs - b.startMs ||
  a.endMs - b.endMs ||
  (segmentIdx.get(a.segmentId) ?? 0) - (segmentIdx.get(b.segmentId) ?? 0) ||
  a.idx - b.idx;

/**
 * Step 1 — max-overlap assignment.
 *
 * Words and turns are both time-sorted, so this is one linear pass with a moving cursor.
 * An interval tree would be complexity with nothing to buy at this scale: a three-hour
 * file is roughly 40k words against 2k turns.
 *
 * **`words` must be sorted by start time.** The cursor only ever advances, so an
 * out-of-order word would be matched against turns that have already been retired and come
 * back with a wrong answer rather than an error. `reconcile()` sorts; call that unless you
 * are testing this step in isolation.
 */
export function assignWords(
  words: readonly RWord[],
  turns: readonly Turn[],
  o: ReconcileOptions = DEFAULTS,
): WordAssignment[] {
  const T = [...turns].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: WordAssignment[] = [];
  let lo = 0;

  for (const w of words) {
    const [wStart, wEnd] = wordSpan(w);

    // Retire turns that can no longer overlap this or any later word, and can no longer
    // serve as "nearest" either.
    while (lo < T.length && T[lo]!.endMs < wStart - o.nearestGapMs) lo++;

    const per = new Map<string, number>();
    let nearestKey: string | null = null;
    let nearestDist = Infinity;

    for (let i = lo; i < T.length; i++) {
      const t = T[i]!;
      if (t.startMs > wEnd + o.nearestGapMs) break;
      const ov = overlapMs(wStart, wEnd, t.startMs, t.endMs);
      if (ov > 0) {
        // Two overlapping turns from the *same* speaker accumulate rather than compete —
        // pyannote can emit both, and treating them as rivals would halve the margin of a
        // word nobody is actually unsure about.
        per.set(t.speakerKey, (per.get(t.speakerKey) ?? 0) + ov);
      } else {
        const d = t.startMs > wEnd ? t.startMs - wEnd : wStart - t.endMs;
        if (d < nearestDist) {
          nearestDist = d;
          nearestKey = t.speakerKey;
        }
      }
    }

    let best = 0;
    let second = 0;
    let bestKey: string | null = null;
    for (const [k, v] of per) {
      if (v > best) {
        second = best;
        best = v;
        bestKey = k;
      } else if (v > second) {
        second = v;
      }
    }

    if (bestKey !== null) {
      out.push({
        wordId: w.id,
        speakerKey: bestKey,
        margin: (best - second) / (best + second || 1),
        source: 'overlap',
      });
    } else if (nearestKey !== null && nearestDist <= o.nearestGapMs) {
      // Margin 0: attaching a word to a turn it does not overlap is a guess, and it must
      // be as eligible for smoothing and as visible to review as any other tie.
      out.push({ wordId: w.id, speakerKey: nearestKey, margin: 0, source: 'nearest' });
    } else {
      out.push({ wordId: w.id, speakerKey: null, margin: 0, source: 'none' });
    }
  }
  return out;
}

/**
 * Step 2 — width-3 median filter, guarded twice.
 *
 * The artefact being fixed is one word attributed to B inside a run of A, where the cause
 * is pyannote clipping a token at a turn edge rather than a real interjection. Reads from
 * `a` and writes to `out`, one pass over the *original* assignments, so a flip can never
 * cascade into a run.
 *
 * Both guards exist to protect the same thing, from two directions:
 *
 * - **`margin < medianMarginMax`.** A word sitting almost entirely inside one turn has a
 *   margin near 1. Flipping it would be the filter overruling the evidence it was handed.
 * - **`duration < medianDurationMaxMs`.** The artefact is sub-word. A word lasting longer
 *   than 400 ms is a real utterance, and in an interview a genuine one-word utterance —
 *   *"Yes." "No." "1988."* — is very often the most quotable thing in the file. **Eating
 *   those is a worse bug than the flicker they resemble.**
 *
 * There are separate fixtures isolating each guard, so a later simplification that drops
 * either one fails CI rather than quietly eating interjections.
 */
export function medianSmooth(
  words: readonly RWord[],
  a: readonly WordAssignment[],
  o: ReconcileOptions = DEFAULTS,
): WordAssignment[] {
  const out = a.map((x) => ({ ...x }));
  for (let i = 1; i < a.length - 1; i++) {
    const prev = a[i - 1]!;
    const cur = a[i]!;
    const next = a[i + 1]!;
    const word = words[i]!;
    if (!prev.speakerKey || !cur.speakerKey || !next.speakerKey) continue;
    if (prev.speakerKey !== next.speakerKey) continue; // not a one-word island
    if (cur.speakerKey === prev.speakerKey) continue; // nothing to fix

    if (cur.margin >= o.medianMarginMax) continue; // guard A — the evidence is strong
    if (word.endMs - word.startMs >= o.medianDurationMaxMs) continue; // guard B

    out[i] = {
      ...cur,
      speakerKey: prev.speakerKey,
      source: 'median',
      margin: Math.min(prev.margin, next.margin),
    };
  }
  return out;
}

/**
 * Step 4 — the `hasWords === false` fallback.
 *
 * `needsReview` is `true` **unconditionally, even at purity 1.0.** Without words we cannot
 * see a mid-segment speaker change at all, so high interval overlap is evidence about the
 * segment's *span*, not about who spoke each part of it. The editor renders these with a
 * distinct marker: *attributed by time overlap only — no word timings*.
 */
function intervalFallback(seg: RSegment, turns: readonly Turn[]): SegmentAssignment {
  const ms = new Map<string, number>();
  for (const t of turns) {
    const ov = overlapMs(seg.startMs, seg.endMs, t.startMs, t.endMs);
    if (ov > 0) ms.set(t.speakerKey, (ms.get(t.speakerKey) ?? 0) + ov);
  }
  let winner: string | null = null;
  let winMs = 0;
  for (const [k, v] of ms) {
    if (v > winMs) {
      winMs = v;
      winner = k;
    }
  }
  const span = Math.max(1, seg.endMs - seg.startMs);
  return {
    segmentId: seg.id,
    speakerKey: winner,
    // Capped at 1: overlapping same-speaker turns can accumulate past the segment's own
    // span, and a purity above 1 would be nonsense in the editor's review query.
    purity: winner ? Math.min(1, winMs / span) : 0,
    needsReview: true,
    source: winner ? 'interval' : 'none',
  };
}

/**
 * Step 3 — duration-weighted majority vote, and `speaker_purity`.
 *
 * Weighted by duration rather than by word count, for two reasons. A segment holding eight
 * filler words from A and two long content words from B is B's sentence, and counting
 * votes gets that backwards. And word *count* is not comparable across languages —
 * unspaced scripts tokenize unevenly — while duration is.
 *
 * `purity` feeds three things: `needs_speaker_review`, export-time speaker splitting
 * (Phase 7), and the editor's "two speakers in this segment" affordance (Phase 13).
 */
export function voteSegments(
  segments: readonly RSegment[],
  words: readonly RWord[],
  assigned: readonly WordAssignment[],
  turns: readonly Turn[],
  o: ReconcileOptions = DEFAULTS,
): SegmentAssignment[] {
  const byId = new Map(assigned.map((x) => [x.wordId, x]));
  const bySeg = new Map<string, RWord[]>();
  for (const w of words) {
    const arr = bySeg.get(w.segmentId);
    if (arr) arr.push(w);
    else bySeg.set(w.segmentId, [w]);
  }

  return segments.map((seg) => {
    const ws = bySeg.get(seg.id);
    if (!seg.hasWords || !ws || ws.length === 0) return intervalFallback(seg, turns);

    const ms = new Map<string, number>();
    let total = 0;
    for (const w of ws) {
      const d = Math.max(1, w.endMs - w.startMs); // a zero-length word still gets a vote
      total += d;
      const k = byId.get(w.id)?.speakerKey;
      if (k) ms.set(k, (ms.get(k) ?? 0) + d);
    }

    let winner: string | null = null;
    let winMs = 0;
    for (const [k, v] of ms) {
      if (v > winMs) {
        winMs = v;
        winner = k;
      }
    }

    const purity = total > 0 ? winMs / total : 0;
    return {
      segmentId: seg.id,
      speakerKey: winner,
      purity,
      needsReview: winner === null || purity < o.purityReviewBelow,
      source: winner === null ? 'none' : 'words',
    };
  });
}

/**
 * The whole reconciliation, in the order the steps have to run.
 *
 * **Sorting happens here, once.** Both the moving cursor in `assignWords` and the notion
 * of "neighbour" in `medianSmooth` mean *temporal* order; taking words in database order —
 * segment then word index — would silently give a wrong answer on any run whose segments
 * are not perfectly time-ordered, which chunked runs with merged seams are not guaranteed
 * to be. The returned `words` are in that same time order.
 */
export function reconcile(
  segments: readonly RSegment[],
  words: readonly RWord[],
  turns: readonly Turn[],
  o: ReconcileOptions = DEFAULTS,
): ReconcileResult {
  const segmentIdx = new Map(segments.map((s) => [s.id, s.idx]));
  const ordered = [...words].sort(byTime(segmentIdx));

  const raw = assignWords(ordered, turns, o);
  const smoothed = medianSmooth(ordered, raw, o);
  const segmentAssignments = voteSegments(segments, ordered, smoothed, turns, o);

  const withWords = segmentAssignments.filter((s) => s.source === 'words');
  return {
    words: smoothed,
    segments: segmentAssignments,
    stats: {
      words: smoothed.length,
      assignedByOverlap: smoothed.filter((w) => w.source === 'overlap').length,
      assignedByNearest: smoothed.filter((w) => w.source === 'nearest').length,
      medianFlips: smoothed.filter((w) => w.source === 'median').length,
      unassignedWords: smoothed.filter((w) => w.speakerKey === null).length,
      segments: segmentAssignments.length,
      segmentsByInterval: segmentAssignments.filter((s) => s.source === 'interval').length,
      // Over word-voted segments only. Averaging in the interval fallback's purity would
      // mix a measure of "who spoke this text" with a measure of "what overlapped this
      // span", and the two are not the same quantity.
      meanPurity: withWords.length
        ? withWords.reduce((sum, s) => sum + s.purity, 0) / withWords.length
        : 0,
      flaggedForReview: segmentAssignments.filter((s) => s.needsReview).length,
    },
  };
}
