import type { Word } from '@thibi/core';

/**
 * Turning two word sequences into comparable token streams.
 *
 * Two paths, because "word" means different things on either side of the
 * scriptio-continua line:
 *
 *  - **Spaced scripts** compare word to word. Normalisation is NFC, locale-aware
 *    lowercasing and punctuation stripping, so `"Sannu,"` and `"sannu"` align.
 *  - **Unspaced scripts** compare *grapheme to grapheme*. Provider "words" in Burmese,
 *    Thai, Khmer and Lao are unreliable syllable fragments — the same audio tokenised
 *    twice does not produce the same splits — so aligning them would fail on correct
 *    transcriptions. Graphemes rather than code points, because a code-point LCS would
 *    happily match a stray vowel sign detached from its consonant.
 */

export interface TokenStream {
  a: string[];
  b: string[];
  /** For each token in `a`, the index of the word it came from. */
  aOwner: number[];
  /** For each token in `b`, the index of the word it came from. */
  bOwner: number[];
}

export interface TokenizeRules {
  code: string;
  wordSegmentation: 'spaces' | 'none' | 'icu';
}

/** Strip punctuation and symbols; keep letters, marks, numbers. */
const PUNCTUATION = /[\p{P}\p{S}]/gu;

export function normalizeToken(text: string, code: string): string {
  return text.normalize('NFC').replace(PUNCTUATION, '').toLocaleLowerCase(code).trim();
}

function graphemesOf(text: string, code: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    try {
      return [...new Intl.Segmenter(code, { granularity: 'grapheme' }).segment(text)].map(
        (s) => s.segment,
      );
    } catch {
      // Fall through.
    }
  }
  return [...text];
}

export function tokenize(
  prev: readonly Word[],
  next: readonly Word[],
  rules: TokenizeRules,
): TokenStream {
  const build = (words: readonly Word[]): { tokens: string[]; owners: number[] } => {
    const tokens: string[] = [];
    const owners: number[] = [];

    for (let w = 0; w < words.length; w++) {
      const normalized = normalizeToken(words[w]!.text, rules.code);
      if (normalized.length === 0) continue;

      if (rules.wordSegmentation === 'spaces') {
        tokens.push(normalized);
        owners.push(w);
      } else {
        for (const grapheme of graphemesOf(normalized, rules.code)) {
          if (grapheme.trim().length === 0) continue;
          tokens.push(grapheme);
          owners.push(w);
        }
      }
    }
    return { tokens, owners };
  };

  const left = build(prev);
  const right = build(next);
  return { a: left.tokens, b: right.tokens, aOwner: left.owners, bOwner: right.owners };
}

/** Character-level tokens for the no-words fallback, where only segment text exists. */
export function tokenizeText(text: string, code: string): string[] {
  return graphemesOf(normalizeToken(text, code), code).filter((g) => g.trim().length > 0);
}
