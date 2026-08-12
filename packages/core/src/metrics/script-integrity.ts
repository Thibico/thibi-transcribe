/**
 * Script integrity — the fraction of a transcript's letters that are written in the script
 * the language is actually written in.
 *
 * This exists because of one measurement. On a 12-second Burmese clip Groq's
 * `whisper-large-v3` returned, with HTTP 200 both times:
 *
 * - `language=my` → `လာက္းကေက် ရိုရ်းသဲ့ထါတ်…` — Myanmar script, but not Burmese words.
 * - autodetect    → `ASEAN YAK SOMPHA CHHA KOO…` — the same audio, romanized.
 *
 * Be precise about which of those this metric catches, because assuming it catches both is
 * the way to trust a number that is not measuring what you think. **It catches the second
 * one and not the first.** Romanized output scores ~0; Myanmar-script non-words score ~1,
 * exactly like a correct transcript. Script integrity is a cheap, reference-free screen for
 * "the provider answered in the wrong alphabet"; CER against a reference is what catches
 * "the provider answered in the right alphabet with the wrong words". Phase 5 runs both.
 *
 * It shipped here in Phase 4, ahead of the harness that will use it in anger, so the Groq
 * romanization case is a number in CI from the day the adapter exists rather than a
 * paragraph in a research note.
 *
 * Lives in `@thibi/core` and takes ranges structurally rather than importing
 * `ScriptEntry` — core depends on nothing, and the eval harness and the running app have to
 * score identically.
 *
 * ---
 *
 * **This file was `metrics/script.ts` until Phase 5.** Phase 5's deliverables table names
 * `metrics/script-integrity.ts`, so this is a rename and not a second module: two
 * overlapping implementations of the metric that decides `tier: unsupported` is precisely
 * the drift the eval harness cannot afford, and Phase 5's own §5.9 sketch is the weaker of
 * the two. It returns a bare `number`, scores an empty transcript 0 as though that were a
 * measurement, takes one block list rather than a script plus its `altScripts` — which
 * would fail a correct Cyrillic Serbian transcript — and reports no stray characters, so a
 * failure prints as `0.02` rather than `0.02 (stray: A S E N Y K)`. The Phase 4a
 * implementation and its measured cases survive unchanged; only the filename moved.
 * Recorded as amendment 56 in `plans/00-overview.md`.
 */

export interface ScriptRanges {
  /** ISO 15924, e.g. 'Mymr'. Carried through to the result for reporting. */
  code: string;
  /** Inclusive codepoint ranges, as `SCRIPTS[code].unicodeRanges` in @thibi/languages. */
  unicodeRanges: ReadonlyArray<readonly [number, number]>;
}

export interface ScriptIntegrity {
  /**
   * `inScript / counted`, or **null when nothing was countable**.
   *
   * Null rather than 1: an empty transcript, or one made entirely of digits and
   * punctuation, is not a script-perfect transcript. A provider that returns "" would
   * otherwise score a clean pass on the metric built to catch it.
   */
  fraction: number | null;
  /** Letters and combining marks considered. Digits, punctuation and spaces are excluded. */
  counted: number;
  inScript: number;
  /** Accepted script codes, in the order given — the primary script first. */
  scripts: string[];
  /**
   * Up to eight distinct out-of-script characters, for a message a human can act on.
   * "0.02 (stray: A S E N Y K)" says romanization; "0.02" alone says nothing.
   */
  strays: string[];
}

/**
 * Only letters and combining marks are counted.
 *
 * Digits are excluded deliberately: Latin digits are used in running text in almost every
 * script here, and Burmese output containing `2026` is not 4 characters less Burmese.
 * Punctuation, whitespace and symbols are excluded for the same reason — a full stop is
 * not evidence either way, and counting them would dilute the fraction by an amount that
 * varies with how chatty the punctuation is.
 */
const COUNTABLE = /\p{L}|\p{M}/u;

function inAnyRange(cp: number, scripts: readonly ScriptRanges[]): boolean {
  for (const script of scripts) {
    for (const [lo, hi] of script.unicodeRanges) {
      if (cp >= lo && cp <= hi) return true;
    }
  }
  return false;
}

/**
 * Score `text` against one or more accepted scripts.
 *
 * Pass **every** script the language is genuinely written in, not just the primary one:
 * `sr-RS` is 93% Latin / 7% Cyrillic across the FLEURS dev set, and scoring a correct
 * Cyrillic Serbian transcript as a failure is precisely the false positive that would get
 * this metric switched off. `ResolvedLanguage.script` plus `.altScripts` is the caller's
 * source for that list.
 */
export function scriptIntegrity(text: string, scripts: readonly ScriptRanges[]): ScriptIntegrity {
  let counted = 0;
  let inScript = 0;
  const strays = new Set<string>();

  // Iterating the string yields whole code points, so astral-plane characters are one
  // character and not two lone surrogates scored separately.
  for (const char of text) {
    if (!COUNTABLE.test(char)) continue;
    counted++;
    if (inAnyRange(char.codePointAt(0)!, scripts)) inScript++;
    else if (strays.size < 8) strays.add(char);
  }

  return {
    fraction: counted === 0 ? null : inScript / counted,
    counted,
    inScript,
    scripts: scripts.map((s) => s.code),
    strays: [...strays],
  };
}

/** `0.98` / `— (nothing countable)`. Formatting lives here so CLI and web agree. */
export function formatScriptIntegrity(result: ScriptIntegrity): string {
  if (result.fraction === null) return '— (nothing countable)';
  const value = result.fraction.toFixed(2);
  return result.strays.length > 0 ? `${value} (stray: ${result.strays.join(' ')})` : value;
}
