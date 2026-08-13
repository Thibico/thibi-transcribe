import type { ScoreProfile, ScriptRanges } from '@thibi/core';
import { LANGUAGES, SCRIPTS } from '@thibi/languages';

/**
 * Project a registry entry into the shape the metrics take.
 *
 * A projection with no translation step, deliberately: the scoring profile and the runtime
 * pipeline must not be able to disagree about what a word is or which digits are native.
 * Where a field the metrics want does not exist in the registry it is left empty here and
 * the gap is recorded, rather than being guessed at — `letterlikePunct` is the standing
 * example (amendment 61).
 */
export function scoreProfileFor(languageCode: string): ScoreProfile | null {
  const entry = LANGUAGES[languageCode];
  if (!entry) return null;
  const script = SCRIPTS[entry.script];
  if (!script) return null;

  return {
    script: entry.script,
    wordSegmentation: entry.text.wordSegmentation,
    zawgyiApplies: entry.text.zawgyiApplies,
    zeroWidth: script.zeroWidth,
    nativeDigits: script.digits.native,
    stripWhitespace: entry.text.cerStripsWhitespace,
    // The registry has no field for this yet, so it is empty for every language and Somali,
    // Hausa and Uzbek WER stays overstated. Empty because it is unknown, not because it is
    // none — see amendment 61 before "fixing" this with a guess.
    letterlikePunct: [],
  };
}

/**
 * The script plus its alternates, for `scriptIntegrity`.
 *
 * `altScripts` is what stops a correct Cyrillic Serbian transcript scoring 0 and being
 * reported as a provider failure that did not happen — `sr-RS` runs 93% Latin / 7% Cyrillic
 * across the FLEURS dev set, and either is correct.
 */
export function scriptRangesFor(languageCode: string): ScriptRanges[] {
  const entry = LANGUAGES[languageCode];
  if (!entry) return [];
  const codes = [entry.script, ...(entry.altScripts ?? [])];
  const out: ScriptRanges[] = [];
  for (const code of codes) {
    const s = SCRIPTS[code];
    if (s) out.push({ code, unicodeRanges: s.unicodeRanges });
  }
  return out;
}
