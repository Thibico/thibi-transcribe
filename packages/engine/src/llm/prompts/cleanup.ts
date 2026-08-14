import { casingRule, marksLine, spacingRule, type PromptLanguageVars } from './vars.js';
import { renderSegments, type LlmPrompt, type PromptSegment } from './types.js';

/**
 * The cleanup prompts — Phase 6 §6.3, built here in Phase 5 so the harness can measure them.
 *
 * Two variants, and both are load-bearing:
 *
 * - **`cleanup.current`** is the prompt shipped in production today, with the language taken
 *   out of it. It is here to be *measured*, not to be used. Scored as CER against a punctuated
 *   reference with doing nothing as the control, it is worse than doing nothing in every
 *   language the research tested — Burmese 0.016 → 0.033, Yoruba 0.059 → 0.148, Pashto
 *   0.011 → 0.048, Somali 0.031 → 0.070, Hausa 0.029 → 0.042, Xhosa 0.035 → 0.041. Deleting
 *   it would leave the gate with nothing to fail against: §6.5 step 4 requires that the old
 *   prompt still fails, and a regression test with no regression in it is decoration.
 * - **`cleanup.restraint`** is the replacement. Same job, no licence to edit.
 *
 * The failure the second one fixes is not sloppy punctuation, it is silent rewriting:
 * `UN tún ní ìrètí…` → `Wọ́n tún ní ìrètí…` in Yoruba, `د اغیزو` ("the effects") expanded to
 * `د نړیوالې تودوخې` ("global warming") in Pashto, `ay … saameeyay` → `uu … saameeyay` in
 * Somali. **The pass meant to make a transcript quotable was altering quotations**, in
 * Burmese, in production.
 *
 * Two lines of the current prompt cause it and neither may reach the restraint text:
 *
 * - *"Fix obvious spelling and Unicode normalization errors introduced by the recogniser."*
 *   In a language the model knows well that is safe; in a low-resource language it licenses
 *   the model to "correct" text that was already right. This is the measured cause.
 * - *"…unless the correct form is unambiguous."* The escape hatch. `UN → Wọ́n` is precisely a
 *   model deciding it knew the unambiguous correct form.
 */

export const CLEANUP_CURRENT = 'cleanup.current';
export const CLEANUP_RESTRAINT = 'cleanup.restraint';

export type CleanupVariant = typeof CLEANUP_CURRENT | typeof CLEANUP_RESTRAINT;

/**
 * Versions are per prompt id and are bumped whenever the *rendered* text changes.
 *
 * `cleanup.current` is at 1 because the app it came from had no versioning at all; it is
 * frozen — the point of the arm is that it is the text that was measured. `cleanup.restraint`
 * starts at 3, carried over from the research iterations that produced it, so the number in a
 * runlog matches the number in the phase plan.
 */
export const CLEANUP_VERSIONS: Readonly<Record<CleanupVariant, number>> = {
  [CLEANUP_CURRENT]: 1,
  [CLEANUP_RESTRAINT]: 3,
};

export interface BuildCleanupInput {
  vars: PromptLanguageVars;
  segments: readonly PromptSegment[];
  /** Defaults to the restraint prompt. The current one has to be asked for by name. */
  variant?: CleanupVariant;
}

export function buildCleanupPrompt(input: BuildCleanupInput): LlmPrompt {
  const variant = input.variant ?? CLEANUP_RESTRAINT;
  return {
    promptId: variant,
    promptVersion: CLEANUP_VERSIONS[variant],
    system: variant === CLEANUP_CURRENT ? currentSystem(input.vars) : restraintSystem(input.vars),
    user: renderSegments(input.segments),
  };
}

/**
 * The shipped prompt, parameterised and otherwise untouched.
 *
 * Ported from `lib/postprocess/cleanup.ts` in the Burmese app. The wording is deliberately
 * preserved down to "a mangled name is a smaller error than a confidently wrong one" — an arm
 * that has been tidied up is not the arm anyone is arguing about, and the whole value of this
 * variant is that a measurement of it is a measurement of what is in production.
 *
 * The one thing that did change is the language: the original opens "You clean up Burmese
 * (Myanmar) speech-to-text transcripts" and names `။` and `၊` inline.
 */
function currentSystem(v: PromptLanguageVars): string {
  const marks = [...v.sentenceEnd, ...v.clausePunct];
  const punctNames = marks.length === 0 ? '' : ` (${marks.join(' and ')})`;
  const lines = [
    `You clean up ${v.endonym} (${v.nameEn}) speech-to-text transcripts.`,
    '',
    'You receive JSON: {"segments": [{"idx": <integer>, "text": "<text>"}]}.',
    'Return JSON with the same shape — one object per input segment.',
    '',
    'For each segment:',
    `- Add or correct ${v.nameEn} sentence punctuation${punctNames} where the phrasing calls for it.`,
    '- Apply consistent phrase-level spacing so the text is searchable and readable.',
    '- Fix obvious spelling and Unicode normalization errors introduced by the recogniser.',
    '- Leave proper nouns, numbers, dates, and place names exactly as transcribed unless',
    '  the correct form is unambiguous — a mangled name is a smaller error than a',
    '  confidently wrong one.',
    '',
    'Hard constraints:',
    '- Return exactly one object per input segment, echoing its "idx" unchanged.',
    '- Never merge, split, reorder, or drop segments. Segment boundaries are aligned to',
    '  audio timestamps; changing them desynchronises the transcript from the recording.',
    `- Never translate. Output stays in ${v.scriptCode} script.`,
    '- Never add, remove, or reinterpret meaning. If a segment is unintelligible, return',
    '  it unchanged rather than guessing at what was said.',
  ];
  return lines.join('\n');
}

/**
 * The replacement.
 *
 * The self-check paragraph near the end is not decoration: it is Phase 5 §5.10's
 * `content_delta` contract written into the prompt. The harness normalizes both sides with
 * punctuation and case removed and asserts the two strings are *identical*, and the CI gate
 * fails above 0.005. Prompt and metric assert the same property, which is why the prompt can
 * be short and absolute rather than long and hedged.
 */
function restraintSystem(v: PromptLanguageVars): string {
  const out: string[] = [];
  out.push(
    `You restore punctuation, casing and spacing in ${v.endonym} (${v.nameEn}) speech-to-text`,
    'transcript segments. You are a typesetter, not an editor.',
    '',
    'Input is JSON: {"segments":[{"idx":<integer>,"text":"<text>"}]}',
    'Return JSON of the same shape: exactly one object per input segment, echoing "idx" unchanged.',
    '',
    'You may change ONLY these things:',
  );

  // Each permission is emitted only where the registry actually has the marks. A line reading
  // "Sentence-ending punctuation:" with nothing after it would read as a permission with no
  // object, and Thai and Lao — which end sentences with a space — would get one.
  const ends = marksLine(v.sentenceEnd);
  if (ends) out.push(`- Sentence-ending punctuation: ${ends}`);
  const clause = marksLine(v.clausePunct);
  if (clause) out.push(`- Clause-internal punctuation: ${clause}`);
  out.push(`- Quotation marks: ${v.quote[0]} ${v.quote[1]}`);
  out.push(`- ${casingRule(v)}`);
  out.push(`- ${spacingRule(v)}`);

  out.push(
    '',
    'You may NOT change anything else. Specifically, do not:',
    '- correct or alter spelling, even where a word looks misspelled or misheard;',
    '- correct or alter grammar, agreement, tense, case, number, or word order;',
    '- substitute any different word, synonym, or pronoun for a word that is present;',
    '- expand, contract, complete or clarify an abbreviation, an acronym, a name or a number;',
    '- add any word that is not in the input, or remove any word that is;',
    '- transliterate, translate, or re-encode any character;',
    '- normalise Unicode, swap visually similar characters, or "fix" diacritics or vowel signs;',
    `- change the digit system in use (${v.digitsExample});`,
  );
  // Emitted for RTL only. In a left-to-right script the instruction names a class of
  // character the model has no reason to produce, and every unnecessary line in a prompt this
  // absolute is a line that dilutes the ones that matter.
  if (v.direction === 'rtl') out.push('- reorder characters or insert directional marks;');
  out.push(
    '- complete a segment that begins or ends mid-thought. These are segments of continuous',
    '  speech and are supposed to be incomplete.',
    '',
    'Apply this test to your own output before returning it: if every character you added is',
    'removed and every space you changed is restored, the result must be character-for-character',
    'identical to the input. If it would not be, you have changed too much — return the input.',
    '',
    'If a segment is empty, unintelligible, or you are unsure, return it exactly as given.',
    'Never merge, split, reorder or drop segments; each is pinned to an audio timestamp.',
    'Return the JSON only — no commentary, no explanation, no notes.',
  );
  return out.join('\n');
}
