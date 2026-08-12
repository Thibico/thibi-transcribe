/**
 * `normalizeForScoring` — the eight rules that decide what "the same text" means.
 *
 * Get this wrong and every number in every eval report is garbage, in a way no test of the
 * metrics themselves would catch: the DP is correct, the parity fixture is green, and the
 * CER is still measuring the wrong thing. That is why the parity fixture deliberately holds
 * **raw** strings and this function is nowhere near it — a normalizer bug must not be able
 * to hide inside a metric assertion, or the reverse.
 *
 * One function, two callers. The eval harness scores a corpus with it and the editor scores
 * a run comparison with it, live in the browser. A second implementation of the *normalizer*
 * — not of the distance, which is easy — is how a report and a UI come to disagree about the
 * same run, so `@thibi/core` is where it lives and `toScoreProfile(resolveLanguage(code))`
 * in `@thibi/languages` is the only thing that builds a profile.
 *
 * | # | Rule | Where |
 * |---|---|---|
 * | 1 | NFC first, always | step 1 |
 * | 2 | Zawgyi detect + convert before scoring, then re-NFC | step 2 |
 * | 3 | Strip all whitespace for Mymr/Khmr/Laoo/Thai/Jpan | step 7, `stripWhitespace` |
 * | 4 | Punctuation stripped for ASR, kept for cleanup | step 6, `keepPunctuation` |
 * | 5 | Digit-shape normalization | step 4, `nativeDigits` |
 * | 6 | ZWSP always; ZWNJ/ZWJ per script | step 3, `zeroWidth` |
 * | 7 | Codepoint *and* grapheme CER reported | `cer.ts`, not here |
 * | 8 | WER null for non-word-delimited scripts | `wer.ts`, not here |
 */

/**
 * The registry fields that affect scoring, passed structurally.
 *
 * Deliberately not `ResolvedLanguage`: `@thibi/core` depends on nothing and is importable
 * from a React client component. Field names and value vocabularies mirror the registry
 * exactly — `wordSegmentation: 'spaces'` not `'space'`, `zeroWidth` as the three-way
 * per-character record and not a single enum — so `toScoreProfile` is a projection with no
 * translation step to get wrong.
 */
export interface ScoreProfile {
  /** ISO 15924, e.g. 'Mymr'. Carried for reporting; nothing here branches on it. */
  script: string;
  /** `ResolvedLanguage.text.wordSegmentation`. Read by `wer()`, not by this function. */
  wordSegmentation: 'spaces' | 'none' | 'icu';
  /** `ResolvedLanguage.text.zawgyiApplies`. */
  zawgyiApplies: boolean;
  /**
   * `scriptEntry.zeroWidth` merged with `text.zeroWidthPolicy`. ZWNJ and ZWJ are *semantic*
   * in Sinhala and Devanagari — stripping them changes what a word is — so they are policy
   * per script rather than swept up with ZWSP.
   */
  zeroWidth: { zwsp: 'strip' | 'keep'; zwnj: 'strip' | 'keep'; zwj: 'strip' | 'keep' };
  /**
   * `scriptEntry.digits.native`: ordered 10-character sets, ascending from zero.
   *
   * A list of *sets*, not the plan's single `nativeDigitBase` code point, because Arabic
   * script has two — Arabic-Indic U+0660 for Arabic and Extended Arabic-Indic U+06F0 for
   * Persian, Pashto and Urdu — and a provider may return either. One base folds one of them
   * and silently leaves the other as an error at every digit.
   */
  nativeDigits: readonly string[];
  /** `ResolvedLanguage.text.cerStripsWhitespace`. Mymr, Thai, Khmr, Laoo, Jpan. */
  stripWhitespace: boolean;
  /**
   * Characters this orthography uses as letters that Unicode classifies as punctuation:
   * Somali's glottal `'`, Hausa's compounding `-`, Uzbek's `ʼ`. Stripping them merges two
   * words into one and inflates that language's WER at every occurrence.
   *
   * **The registry has no field for this yet** — `text.punctuation` carries only
   * `sentenceEnders` and `quotes`. Until it does, this is `[]` for every language and
   * Somali, Hausa and Uzbek WER is overstated. Recorded as amendment 61.
   */
  letterlikePunct: readonly string[];
}

export interface ScoreOptions {
  /** `false` for the ASR metric; **`true`** for cleanup, where punctuation is the subject. */
  keepPunctuation: boolean;
  /**
   * `true` for the ASR metric, because FLEURS column 3 is lowercased; **`false`** for
   * cleanup, because capitalisation is the thing being scored. Explicit, never derived from
   * the script — deriving it is how the cleanup eval ends up unable to see its own metric.
   */
  caseFold: boolean;
  /**
   * Detect-and-convert Zawgyi, supplied by the caller. Returns the input unchanged when the
   * text is already Unicode.
   *
   * Injected rather than imported because `@thibi/core` has zero runtime dependencies and is
   * loaded into a React client bundle; the detector and the converter are two npm packages
   * that belong above this layer. `@thibi/languages` owns `text.zawgyiApplies` and the
   * `'zawgyi'` normalizer id already, so it is the natural place to wire them.
   *
   * Required whenever `profile.zawgyiApplies` is true — see the throw in step 2.
   */
  convertZawgyi?: (text: string) => string;
}

// Escapes rather than the literal characters throughout: these are invisible, so a literal
// in a character class is unreviewable in a diff and unsearchable in the file. ESLint's
// no-irregular-whitespace refuses them anyway.

/**
 * ZWSP (U+200B) and the byte-order mark / ZWNBSP (U+FEFF). Never semantic in any script the
 * registry covers, and a provider that emits them against a reference that does not has not
 * made a transcription error. Removed for every profile, which is rule 6's "ZWSP always".
 */
const ZWSP_BOM = /[\u200B\uFEFF]/gu;
const ZWNJ = /\u200C/gu;
const ZWJ = /\u200D/gu;

/**
 * Bidi formatting: LRM (U+200E), RLM (U+200F), ALM (U+061C), the embedding/override block
 * (U+202A–U+202E) and the isolates (U+2066–U+2069).
 *
 * Always removed, for every script, with no policy switch. An RTL provider that brackets a
 * Latin acronym in RLM and a reference that does not are not different transcripts — they
 * are the same logical text with different presentation hints, and every one of these
 * characters would otherwise count as an insertion.
 */
const BIDI_FMT = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/gu;

const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u;

const LATIN_DIGITS = '0123456789';

export function normalizeForScoring(
  input: string,
  profile: ScoreProfile,
  options: ScoreOptions,
): string {
  // 1. NFC first, always. Every comparison below — and every edit distance above — assumes a
  //    single normal form; ်ေ and ေ် are the same syllable and two different strings.
  let t = input.normalize('NFC');

  // 2. Zawgyi before anything inspects code points. Zawgyi and Unicode Myanmar share a code
  //    block and differ in how they use it, so a Zawgyi-emitting provider scores near 100%
  //    error against a Unicode reference for what is a font problem, not a transcription
  //    one. Conversion is neither length-preserving nor NFC-stable, hence the second NFC.
  //
  //    Scoring may convert the whole string because nothing here is aligned and whitespace
  //    is stripped anyway; the *runtime* pipeline must convert per word, or word timings
  //    desynchronise. `applyNormalizers` in @thibi/languages throws for exactly that reason.
  if (profile.zawgyiApplies) {
    if (!options.convertZawgyi) {
      // Loud, not lenient. Silently skipping conversion produces a CER near 1.0 for a
      // correct transcript, which reads as a provider failure and is the single most
      // expensive wrong number this layer could produce.
      throw new Error(
        `normalizeForScoring: profile for script '${profile.script}' has zawgyiApplies: true ` +
          'but no options.convertZawgyi was supplied. Scoring Zawgyi text as Unicode reports ' +
          'a correct transcript as ~100% error. Pass the converter from @thibi/languages.',
      );
    }
    if (t.length > 0) t = options.convertZawgyi(t).normalize('NFC');
  }

  // 3. Zero-width and bidi formatting.
  t = t.replace(ZWSP_BOM, '').replace(BIDI_FMT, '');
  if (profile.zeroWidth.zwnj === 'strip') t = t.replace(ZWNJ, '');
  if (profile.zeroWidth.zwj === 'strip') t = t.replace(ZWJ, '');

  // 4. Digit shapes to ASCII, so ၁၉၉၅ and 1995 are the same number.
  //
  //    Always, for every script that has native digits — this ignores the registry's
  //    `digits.foldToLatin`, which is a *rendering* policy about what the user should see
  //    and is `false` for every script in the tree. Scoring is symmetric: folding both sides
  //    to one shape cannot lose a distinction that matters, and not folding makes a provider
  //    that writes Latin digits against a reference that writes native ones wrong at every
  //    digit for a difference nobody would call an error.
  for (const set of profile.nativeDigits) {
    if ([...set].length === 10) t = foldDigits(t, set);
  }

  // 5. Case.
  if (options.caseFold) t = t.toLowerCase();

  // 6. Punctuation.
  if (!options.keepPunctuation) t = stripPunct(t, profile.letterlikePunct);

  // 7. Whitespace, last — so a removed punctuation mark cannot leave a double space behind.
  return profile.stripWhitespace ? t.replace(/\s+/gu, '') : t.replace(/\s+/gu, ' ').trim();
}

/** Map one 10-character native digit set onto ASCII by index. */
function foldDigits(t: string, set: string): string {
  const native = [...set];
  let out = '';
  for (const ch of t) {
    const i = native.indexOf(ch);
    out += i === -1 ? ch : LATIN_DIGITS[i]!;
  }
  return out;
}

/**
 * `\p{P}` and `\p{S}`, minus the characters a given orthography uses as letters.
 *
 * `\p{S}` is included because currency and maths symbols carry no transcription signal, and
 * a provider that writes `%` where the reference writes `percent` is a lexical difference
 * the words already capture.
 */
function stripPunct(t: string, keep: readonly string[]): string {
  const keepSet = new Set(keep);
  let out = '';
  for (const ch of t) {
    if (keepSet.has(ch)) {
      out += ch;
      continue;
    }
    if (PUNCT_OR_SYMBOL.test(ch)) continue;
    out += ch;
  }
  return out;
}
