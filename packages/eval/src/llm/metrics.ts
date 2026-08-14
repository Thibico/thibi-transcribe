import { editStats, normalizeForScoring, type EditStats, type ScoreProfile } from '@thibi/core';

/**
 * The four cleanup metrics — Phase 5 §5.10.
 *
 * Three of them score quality and the fourth checks a contract, and the fourth is the
 * strongest of the set. A cleanup pass that changes punctuation, case and whitespace and
 * nothing else leaves `content_delta` at exactly 0.000; any other value is a rewrite, by
 * definition, with no argument available about whether the rewrite was an improvement.
 *
 * Every metric is computed per segment and aggregated as a **ratio of sums**, never as a mean
 * of per-segment rates. Same reason as the ASR corpus CER: a long segment and a short one do
 * not carry equal weight in the underlying quantity, and averaging rates silently says they
 * do.
 */

/** Per-segment counts, kept rather than rates so a runlog can be replayed into the same numbers. */
export interface CleanupStats {
  /** CER with punctuation and case retained — the headline. */
  cerPunct: EditStats;
  /**
   * The contract check: input and hypothesis with punctuation, case and whitespace removed.
   * `edits` must be 0.
   */
  content: EditStats;
  /** Codepoints in and out, for `length_delta`. */
  lengthIn: number;
  lengthOut: number;
  /** Entity multiset symmetric difference, and the input's token count. */
  entityDiff: number;
  entityTotal: number;
  /** The tokens that left the input's multiset — what the report prints. */
  entitiesLost: string[];
}

/**
 * ALL-CAPS runs, digit strings, and — for a non-Latin language — Latin-script tokens.
 *
 * This is the metric that names `UN tún ní ìrètí… → Wọ́n tún ní ìrètí…`: "UN" leaves the
 * multiset, drift jumps, and the report can print the token that vanished. Raw CER moves by
 * two characters for that edit and under-weights it relative to how badly it damages a quote.
 *
 * The Latin-token branch is conditional because in a Latin-script language every word would
 * match and the metric would become a second, worse word-error rate.
 */
export function entityPattern(isLatinScript: boolean): RegExp {
  const alts = [
    // Two or more uppercase letters: acronyms. UN, NGO, ASEAN.
    '\\p{Lu}{2,}',
    // A digit run with the separators that occur inside numbers, dates and times, including
    // the Arabic decimal and thousands separators.
    '\\d[\\d.,:/\\u066B\\u066C]*',
  ];
  if (!isLatinScript) {
    alts.push("(?<=^|\\s)\\p{Script=Latin}[\\p{Script=Latin}\\p{M}'’-]*(?=$|\\s)");
  }
  return new RegExp(alts.join('|'), 'gu');
}

function multiset(text: string, re: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(re)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  return counts;
}

export interface ScoreCleanupInput {
  /** The provider's unpunctuated, lowercased transcript — what the pass was given. */
  input: string;
  /** What the model returned. For the `control` arm this is `input` unchanged. */
  hypothesis: string;
  /** FLEURS column 2 `raw_transcription` — punctuated and cased. */
  reference: string;
  profile: ScoreProfile;
  /** Supplied whenever `profile.zawgyiApplies`; see `normalizeForScoring`. */
  convertZawgyi?: (text: string) => string;
  isLatinScript: boolean;
}

export function scoreCleanup(i: ScoreCleanupInput): CleanupStats {
  // Punctuation is the thing being measured, so it is kept; case likewise. This is the one
  // place in the harness where `keepPunctuation` is true, and it is why `ScoreOptions` takes
  // it as an explicit flag rather than deriving it from the script.
  const punct = {
    keepPunctuation: true,
    caseFold: false,
    ...(i.convertZawgyi ? { convertZawgyi: i.convertZawgyi } : {}),
  } as const;
  const hypPunct = normalizeForScoring(i.hypothesis, i.profile, punct);
  const refPunct = normalizeForScoring(i.reference, i.profile, punct);

  /**
   * The contract check. Whitespace is forced off on both sides regardless of the profile,
   * because a cleanup pass is *permitted* to change spacing — so leaving it in would report
   * every legitimate space insertion as a content change and the metric would stop meaning
   * "the model rewrote a word".
   */
  const bare = {
    keepPunctuation: false,
    caseFold: true,
    ...(i.convertZawgyi ? { convertZawgyi: i.convertZawgyi } : {}),
  } as const;
  const strip = (s: string) =>
    normalizeForScoring(s, i.profile, bare).replace(/\s+/gu, '');
  const contentIn = strip(i.input);
  const contentOut = strip(i.hypothesis);

  const re = entityPattern(i.isLatinScript);
  const inTokens = multiset(i.input, re);
  const outTokens = multiset(i.hypothesis, re);
  let entityDiff = 0;
  let entityTotal = 0;
  const entitiesLost: string[] = [];
  for (const [token, count] of inTokens) {
    entityTotal += count;
    const got = outTokens.get(token) ?? 0;
    if (got < count) entitiesLost.push(token);
    entityDiff += Math.abs(count - got);
  }
  for (const [token, count] of outTokens) {
    if (!inTokens.has(token)) entityDiff += count;
  }

  return {
    cerPunct: editStats(hypPunct, refPunct, 'codepoint'),
    content: editStats(contentOut, contentIn, 'codepoint'),
    lengthIn: [...i.input].length,
    lengthOut: [...i.hypothesis].length,
    entityDiff,
    // `max(1, …)` so a segment with no entities contributes 0/1 rather than 0/0.
    entityTotal: Math.max(1, entityTotal),
    entitiesLost,
  };
}

export interface CleanupAggregate {
  n: number;
  cerPunct: number | null;
  contentDelta: number | null;
  entityDrift: number | null;
  lengthDelta: number | null;
  /** Segments whose `content_delta` is above zero — the ones a reviewer has to look at. */
  rewritten: number;
}

export function aggregateCleanup(stats: readonly CleanupStats[]): CleanupAggregate {
  const sum = (f: (s: CleanupStats) => number) => stats.reduce((acc, s) => acc + f(s), 0);
  const ratio = (num: number, den: number) => (den === 0 ? null : num / den);
  return {
    n: stats.length,
    cerPunct: ratio(sum((s) => s.cerPunct.edits), sum((s) => s.cerPunct.refLen)),
    contentDelta: ratio(sum((s) => s.content.edits), sum((s) => s.content.refLen)),
    entityDrift: ratio(sum((s) => s.entityDiff), sum((s) => s.entityTotal)),
    // Signed: a cleanup pass should be slightly positive because it adds punctuation.
    // Strongly negative is deletion; strongly positive is the model having written something.
    lengthDelta: ratio(sum((s) => s.lengthOut - s.lengthIn), sum((s) => s.lengthIn)),
    rewritten: stats.filter((s) => s.content.edits > 0).length,
  };
}
