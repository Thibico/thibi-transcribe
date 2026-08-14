import { describe, expect, it } from 'vitest';
import { aggregateCleanup, entityPattern, scoreCleanup } from '../llm/metrics.js';
import { scoreProfileFor } from '../profile.js';

/**
 * The four cleanup metrics.
 *
 * The edit distance underneath them is proved by `@thibi/core`'s 213 tests, so nothing here
 * asserts a Levenshtein result. What is asserted is the part that is specific to this eval:
 * which differences each metric can *see*.
 */

const HAUSA = scoreProfileFor('ha-NG')!;
const YORUBA = scoreProfileFor('yo-NG')!;
const BURMESE = scoreProfileFor('my-MM')!;
const noZawgyi = (t: string) => t;

const score = (
  profile = HAUSA,
  input: string,
  hypothesis: string,
  reference: string,
  isLatinScript = true,
) =>
  scoreCleanup({
    input,
    hypothesis,
    reference,
    profile,
    isLatinScript,
    convertZawgyi: noZawgyi,
  });

describe('content_delta — the contract check', () => {
  it('is exactly zero for a punctuation, case and spacing change', () => {
    // This is the whole property: a compliant cleanup pass is a typesetter, so removing what
    // it added leaves the input character for character.
    const s = score(HAUSA, 'ga wannan sanarwa', 'Ga wannan sanarwa.', 'Ga wannan sanarwa.');
    expect(s.content.edits).toBe(0);
    expect(aggregateCleanup([s]).contentDelta).toBe(0);
  });

  it('is non-zero the moment a word is substituted', () => {
    // Somali's `ay … saameeyay → uu … saameeyay`: grammatical agreement "corrected", and the
    // sentence changed. `entity_drift` cannot see this — both tokens are in-script, lowercase
    // and not numbers — which is exactly why this metric exists.
    const s = score(HAUSA, 'ay saameeyay caalamka', 'Uu saameeyay caalamka.', 'Ay saameeyay caalamka.');
    expect(s.content.edits).toBeGreaterThan(0);
    expect(aggregateCleanup([s]).contentDelta).toBeGreaterThan(0);
  });

  it('ignores spacing even where the profile would not', () => {
    // Burmese spacing is arbitrary on both sides, and the prompt is *permitted* to change it.
    // Leaving whitespace in the contract check would report every legitimate space insertion
    // as a rewrite.
    const s = score(BURMESE, 'မြန်မာစာ', 'မြန် မာ စာ။', 'မြန်မာစာ။', false);
    expect(s.content.edits).toBe(0);
  });
});

describe('entity_drift', () => {
  it('names an acronym replaced by a pronoun', () => {
    // The Yoruba failure, verbatim: `UN tún ní ìrètí…` → `Wọ́n tún ní ìrètí…`. Raw CER moves by
    // two characters for that edit and under-weights how badly it damages a quote.
    const s = score(YORUBA, 'UN tún ní ìrètí', 'Wọ́n tún ní ìrètí.', 'UN tún ní ìrètí.');
    expect(s.entitiesLost).toContain('UN');
    expect(aggregateCleanup([s]).entityDrift).toBeGreaterThan(0);
  });

  it('does not fire on every word of a Latin-script language', () => {
    // The Latin-token branch is conditional. In a Latin-script language it would match every
    // word and the metric would become a second, worse word error rate.
    const latin = entityPattern(true);
    expect('ga wannan sanarwa'.match(latin)).toBeNull();
    const nonLatin = entityPattern(false);
    expect('မြန်မာ ASEAN စာ'.match(nonLatin)).toContain('ASEAN');
  });

  it('counts digits, and a digit system change as drift', () => {
    const s = score(BURMESE, 'ခုနှစ် ၁၉၉၅ တွင်', 'ခုနှစ် 1995 တွင်။', 'ခုနှစ် ၁၉၉၅ တွင်။', false);
    expect(s.entityDiff).toBeGreaterThan(0);
  });
});

describe('length_delta', () => {
  it('is slightly positive when punctuation is added and negative when text is dropped', () => {
    const added = score(HAUSA, 'ga wannan', 'Ga wannan.', 'Ga wannan.');
    expect(aggregateCleanup([added]).lengthDelta).toBeGreaterThan(0);
    const dropped = score(HAUSA, 'ga wannan sanarwa', 'Ga wannan.', 'Ga wannan sanarwa.');
    expect(aggregateCleanup([dropped]).lengthDelta).toBeLessThan(0);
  });
});

describe('aggregation', () => {
  it('is a ratio of sums, not a mean of rates', () => {
    // A long segment and a short one do not carry equal weight in the underlying quantity;
    // averaging rates silently says they do. Deliberately skewed lengths.
    const short = score(HAUSA, 'a', 'A.', 'B.');
    const long = score(HAUSA, 'a'.repeat(50), `${'a'.repeat(50)}.`, `${'a'.repeat(50)}.`);
    const agg = aggregateCleanup([short, long]);
    const meanOfRates =
      (short.cerPunct.edits / short.cerPunct.refLen + long.cerPunct.edits / long.cerPunct.refLen) / 2;
    expect(agg.cerPunct).not.toBeCloseTo(meanOfRates, 6);
    expect(agg.cerPunct).toBeCloseTo(
      (short.cerPunct.edits + long.cerPunct.edits) / (short.cerPunct.refLen + long.cerPunct.refLen),
      12,
    );
  });

  it('counts rewritten segments rather than averaging them away', () => {
    const clean = score(HAUSA, 'ga wannan', 'Ga wannan.', 'Ga wannan.');
    const rewritten = score(HAUSA, 'ga wannan', 'Ga wancan.', 'Ga wannan.');
    expect(aggregateCleanup([clean, rewritten]).rewritten).toBe(1);
  });
});
