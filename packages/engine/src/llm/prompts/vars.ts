import { LANGUAGES, SCRIPTS } from '@thibi/languages';

/**
 * The slots a prompt is rendered from — Phase 6 §6.4.
 *
 * **No prompt in this directory names a language.** The only literals in a prompt are the
 * JSON envelope and the constraints; everything language-specific arrives through this type,
 * filled from the registry. That is not tidiness: the old app's cleanup prompt began "You
 * clean up Burmese (Myanmar) speech-to-text transcripts", and a prompt with a language in it
 * is a prompt that has to be forked 107 times or quietly applied to the wrong language.
 *
 * Every field is a projection of a registry field with no translation step, for the same
 * reason `ScoreProfile` is: the prompt and the scorer must not be able to disagree about what
 * this language's punctuation, digits or spacing are.
 */
export interface PromptLanguageVars {
  /** Registry key, e.g. `my-MM`. */
  code: string;
  nameEn: string;
  /** The endonym, falling back to `nameEn` where the registry has none. Never guessed. */
  endonym: string;
  /** ISO 15924, e.g. `Mymr`. */
  scriptCode: string;
  direction: 'ltr' | 'rtl';
  /**
   * Sentence-final marks only.
   *
   * The registry's `text.punctuation.sentenceEnders` is a single flat list and several
   * languages carry a clause mark in it — Burmese lists `၊` beside `။`, Amharic lists `፣`
   * beside `።`. A prompt that offered that flat list as "sentence-ending punctuation" would be
   * telling a model that the Burmese comma ends sentences. Subtracting `clausePunct` is what
   * splits them, and it happens here rather than in 116 language rows.
   */
  sentenceEnd: readonly string[];
  /** Clause-internal marks, from the script. Empty means *not recorded* — see below. */
  clausePunct: readonly string[];
  quote: readonly [string, string];
  hasCase: boolean;
  /**
   * What a typesetter may do to whitespace.
   *
   * - `inter-word` — spaces separate every word. Collapse and trim, nothing else.
   * - `phrase-level` — Mymr, Khmr, Laoo, Thai: no space between every word, but spaces do
   *   appear at phrase boundaries and are a real editorial decision. The prompt permits
   *   inserting or removing one *there* and nowhere else. This is the same set
   *   `normalizeForScoring` strips whitespace from before scoring, which is not a
   *   coincidence: spacing is arbitrary on both sides, so the metric ignores it and the
   *   prompt is allowed to touch it.
   * - `none` — CJK, which does not space at all.
   */
  spacing: 'inter-word' | 'phrase-level' | 'none';
  /** `'၀၁၂၃ or 0123'`. The shapes in use, so "do not change the digit system" is concrete. */
  digitsExample: string;
}

/**
 * Scripts that space at phrase boundaries but not between words.
 *
 * Named as a set rather than derived from `wordSegmentation: 'none'`, because that value
 * covers CJK too and Japanese does not space at all — telling a model it may insert a space
 * "at a phrase boundary" in Japanese invites it to invent a convention the language has no
 * use for.
 */
const PHRASE_LEVEL_SCRIPTS = new Set(['Mymr', 'Khmr', 'Laoo', 'Thai']);

export class UnknownLanguageError extends Error {
  constructor(readonly code: string) {
    super(`no registry entry for language '${code}'`);
    this.name = 'UnknownLanguageError';
  }
}

/**
 * Project a registry entry into prompt slots.
 *
 * Throws rather than returning a partial set for an unknown code. A prompt rendered from
 * defaults is a prompt that instructs a model in the punctuation of no language in
 * particular, and it would look entirely normal in the output.
 */
export function promptVars(code: string): PromptLanguageVars {
  const entry = LANGUAGES[code];
  if (!entry) throw new UnknownLanguageError(code);
  const script = SCRIPTS[entry.script];
  if (!script) throw new UnknownLanguageError(code);

  const clausePunct = script.clausePunct;
  const clauseSet = new Set(clausePunct);
  const native = script.digits.native[0];

  return {
    code: entry.code,
    nameEn: entry.nameEn,
    // The registry stores `null` where no trustworthy endonym exists rather than guessing
    // one, so the fallback is the English name and not a transliteration invented here.
    endonym: entry.endonym ?? entry.nameEn,
    scriptCode: entry.script,
    direction: script.direction,
    sentenceEnd: entry.text.punctuation.sentenceEnders.filter((m) => !clauseSet.has(m)),
    clausePunct,
    quote: entry.text.punctuation.quotes,
    hasCase: script.hasCase,
    spacing:
      entry.text.wordSegmentation === 'spaces'
        ? 'inter-word'
        : PHRASE_LEVEL_SCRIPTS.has(entry.script)
          ? 'phrase-level'
          : 'none',
    digitsExample: native === undefined ? '0123' : `${[...native].slice(0, 4).join('')} or 0123`,
  };
}

/**
 * The capitalisation permission.
 *
 * The cased branch is deliberately narrow on proper nouns: "already capitalised in the input"
 * and an explicit refusal to capitalise a word into looking like a name. A model that decides
 * a word is a name is a model that has decided what the word *is*, which is the class of edit
 * that produced `UN → Wọ́n`.
 */
export const casingRule = (v: PromptLanguageVars): string =>
  v.hasCase
    ? 'Capitalisation: sentence-initial capitals, and proper nouns that are ALREADY ' +
      'capitalised in the input. Do not change the case of any other word, and never ' +
      'capitalise a word to make it look like a name.'
    : 'This script has no letter case. Do not change the case or form of any character.';

export const spacingRule = (v: PromptLanguageVars): string =>
  ({
    'inter-word':
      'Whitespace: collapse repeated spaces and remove leading and trailing space. Do not ' +
      'otherwise change spacing.',
    'phrase-level':
      'Whitespace: this language does not space between every word. You may insert or remove ' +
      'a space at a PHRASE boundary only. Never insert a space inside a word or inside a ' +
      'syllable cluster, and never remove a space that separates two phrases.',
    none: 'Whitespace: do not change spacing at all.',
  })[v.spacing];

/**
 * Render a set of marks for a prompt line, or `null` when the set is empty.
 *
 * `null` means the caller omits the whole line, and that is the safe direction: the prompt is
 * a list of what may be changed, so a mark that is not listed is a mark the model may not
 * insert. An empty `clausePunct` is "nobody has recorded this script's commas", and printing
 * "Clause-internal punctuation: (none)" would assert something stronger and less true.
 */
export function marksLine(marks: readonly string[]): string | null {
  return marks.length === 0 ? null : marks.join(' ');
}
