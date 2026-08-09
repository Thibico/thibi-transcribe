import type { Segment, Word } from '@thibi/core';
import { diceScore, lcsPairs } from './lcs.js';
import { tokenize, tokenizeText, type TokenizeRules } from './tokenize.js';

/**
 * Overlap de-duplication at a chunk seam.
 *
 * Chunk *k+1* is extracted starting `leadMs` before chunk *k* ends, so its transcript
 * repeats the tail of chunk *k*. Concatenating duplicates those words; hard-cutting at the
 * boundary loses any word straddling it — which is measured, not theoretical: spike S3
 * found hard cuts lose 2-3 words at every seam, 2.1% of all words at 30 minutes and 3.4%
 * at 2 hours. The overlap exists to recover them and this is what removes the duplicate.
 *
 * Geometry: chunk *k* covers `[a_k, b_k]`, chunk *k+1* is extracted from `b_k − lead`, the
 * overlap region is `[b_k − lead, b_k]` and `seamMs := b_k`.
 */

/** The 0.5 floor comes from the overview. 0.7 for "accept but flag" is invented here. */
export const DEFAULT_MIN_SCORE = 0.5;
export const GREY_ZONE_MAX = 0.7;
/** Provider timing drift either side of the nominal overlap. */
export const DEFAULT_SLACK_MS = 300;
/** Bound on the DP. 60 words is far more than a 1.2 s overlap can contain. */
const MAX_WINDOW_WORDS = 60;
const MAX_WINDOW_CHARS = 400;

export type SeamMethod = 'lcs' | 'hard-cut' | 'no-words' | 'empty';

export interface SeamInput {
  /** Absolute ms, chunk k. */
  prevWords: readonly Word[];
  /** Absolute ms, chunk k+1. */
  nextWords: readonly Word[];
  seamMs: number;
  leadMs: number;
  lang: TokenizeRules;
  minScore?: number;
  slackMs?: number;
}

export interface SeamResult {
  /** Index into prevWords, inclusive. -1 drops the whole tail. */
  keepPrevThrough: number;
  /** Index into nextWords, inclusive. -1 drops nothing. */
  dropNextThrough: number;
  method: SeamMethod;
  score: number;
  flagged: boolean;
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return i;
  return -1;
}

export function mergeSeam(input: SeamInput): SeamResult {
  const { prevWords, nextWords, seamMs, leadMs, lang } = input;
  const slack = input.slackMs ?? DEFAULT_SLACK_MS;
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

  // 1. Window. Bounded so the DP stays trivially cheap, and time-bounded so a phrase
  //    genuinely repeated elsewhere in the chunk cannot be mistaken for the overlap.
  const lo = seamMs - leadMs - slack;
  const hi = seamMs + slack;
  const pStartByTime = prevWords.findIndex((w) => w.endMs >= lo);
  const pStart =
    pStartByTime === -1
      ? prevWords.length
      : Math.max(pStartByTime, prevWords.length - MAX_WINDOW_WORDS);
  const pTail = prevWords.slice(pStart);
  const nHead = nextWords.filter((w) => w.startMs <= hi).slice(0, MAX_WINDOW_WORDS);

  // Nothing was spoken in the overlap. Score 1 by convention — not NaN, and deliberately
  // not a low score, which would flag every pause in the recording.
  if (pTail.length === 0 || nHead.length === 0) {
    return {
      keepPrevThrough: prevWords.length - 1,
      dropNextThrough: -1,
      method: 'empty',
      score: 1,
      flagged: false,
    };
  }

  // 2. Tokenize, then 3. align.
  const tokens = tokenize(pTail, nHead, lang);
  const pairs = lcsPairs(tokens.a, tokens.b);
  const score = diceScore(pairs.length, tokens.a.length, tokens.b.length);

  if (score < minScore || pairs.length === 0) {
    // 4. The two chunks disagree about what was said in the overlap. Hard-cut at the
    //    midpoint and flag it. A duplicated sentence reads as the speaker repeating
    //    themselves, which is worse for a reader than a missing one.
    const mid = seamMs - leadMs / 2;
    return {
      keepPrevThrough: lastIndexWhere(prevWords, (w) => w.endMs <= mid),
      dropNextThrough: lastIndexWhere(nextWords, (w) => w.startMs <= mid),
      method: 'hard-cut',
      score,
      flagged: true,
    };
  }

  // 5. Split at the aligned pair nearest the planned boundary. Both transcriptions are
  //    least reliable at the far edges of the overlap — prev's truncated tail, next's
  //    context-free head — and most reliable in the middle, which is also where the
  //    silence-snapped boundary already sits.
  const midOf = (pair: { i: number; j: number }): number => {
    const word = pTail[tokens.aOwner[pair.i]!]!;
    return (word.startMs + word.endMs) / 2;
  };
  let best = pairs[0]!;
  for (const pair of pairs) {
    if (Math.abs(midOf(pair) - seamMs) < Math.abs(midOf(best) - seamMs)) best = pair;
  }

  return {
    keepPrevThrough: pStart + tokens.aOwner[best.i]!,
    dropNextThrough: tokens.bOwner[best.j]!,
    method: 'lcs',
    score,
    flagged: score < GREY_ZONE_MAX,
  };
}

/**
 * The no-words branch.
 *
 * When either side has `wordTimingQuality: 'none'`, word alignment is impossible. Fall back
 * to character-level LCS over the text either side of the seam, and if that also fails,
 * drop whole `next` segments whose midpoint precedes the overlap midpoint. **Never silently
 * concatenate** — a duplicated sentence with no way to detect it is the worst outcome.
 */
export interface NoWordsSeamInput {
  prevSegments: readonly Segment[];
  nextSegments: readonly Segment[];
  seamMs: number;
  leadMs: number;
  lang: TokenizeRules;
  minScore?: number;
}

export interface NoWordsSeamResult {
  /** Index into nextSegments, inclusive; segments up to here are dropped. */
  dropNextThrough: number;
  method: 'no-words';
  score: number;
  flagged: boolean;
}

export function mergeSeamNoWords(input: NoWordsSeamInput): NoWordsSeamResult {
  const { prevSegments, nextSegments, seamMs, leadMs, lang } = input;
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

  const prevText = prevSegments
    .map((s) => s.text)
    .join(' ')
    .slice(-MAX_WINDOW_CHARS);
  const nextText = nextSegments
    .map((s) => s.text)
    .join(' ')
    .slice(0, MAX_WINDOW_CHARS);

  const a = tokenizeText(prevText, lang.code);
  const b = tokenizeText(nextText, lang.code);
  const score = a.length && b.length ? diceScore(lcsPairs(a, b).length, a.length, b.length) : 0;

  // Whether or not the characters aligned, segment granularity is all we have: drop the
  // `next` segments that lie inside the overlap region.
  const overlapMid = seamMs - leadMs / 2;
  const dropNextThrough = lastIndexWhere(
    nextSegments,
    (s) => (s.startMs + s.endMs) / 2 < overlapMid,
  );

  return {
    dropNextThrough,
    method: 'no-words',
    score,
    // Always flagged. Attribution at segment granularity is a guess, and the operator
    // should be able to see which seams were guessed at.
    flagged: true,
  };
}

export interface ChunkOutput {
  segments: Segment[];
}

export interface ApplySeamOptions {
  wordJoin: ' ' | '';
}

/**
 * Apply a seam result: drop words first, then rebuild the segments that lost any.
 *
 * `textRaw` is **never** re-derived. It is the provider's bytes, duplicate included: the
 * audit trail records what was said to us, `text` records what we concluded.
 */
export function applySeam(
  next: ChunkOutput,
  result: Pick<SeamResult, 'dropNextThrough'>,
  options: ApplySeamOptions,
): { segments: Segment[]; droppedWords: number } {
  if (result.dropNextThrough < 0) return { segments: next.segments, droppedWords: 0 };

  let dropped = 0;
  let seen = -1;
  const kept: Segment[] = [];

  for (const segment of next.segments) {
    if (!segment.hasWords || segment.words.length === 0) {
      // Nothing to align against; the caller's no-words path owns this case.
      kept.push(segment);
      continue;
    }

    const survivors: Word[] = [];
    for (const word of segment.words) {
      seen++;
      if (seen <= result.dropNextThrough) dropped++;
      else survivors.push(word);
    }

    // Every word dropped: the segment disappears entirely.
    if (survivors.length === 0) continue;

    if (survivors.length === segment.words.length) {
      kept.push(segment);
      continue;
    }

    kept.push({
      ...segment,
      startMs: survivors[0]!.startMs,
      text: survivors.map((w) => w.text).join(options.wordJoin),
      // Deliberately unchanged.
      textRaw: segment.textRaw,
      words: survivors.map((w, idx) => ({ ...w, idx })),
    });
  }

  // Renumber so indices stay contiguous after a segment disappears.
  return {
    segments: kept.map((segment, idx) => ({ ...segment, idx })),
    droppedWords: dropped,
  };
}
