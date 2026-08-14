import type { PromptLanguageVars } from './vars.js';
import { renderSegments, type LlmPrompt, type PromptSegment } from './types.js';

/**
 * The translation prompt — Phase 6 §6.3.
 *
 * **The target is a parameter, never a literal**, which is the whole reason this is one
 * prompt rather than one per language pair: `layer = 'translated'` with `target_lang = <bcp47>`
 * means N targets are N rows and never N columns. The handoff note called this prompt
 * `translate.to-en`; the id is `translate.default`, because a prompt id naming its target
 * would be the same mistake in a different place.
 *
 * The segment-boundary constraints and the "may begin or end mid-sentence" guidance come
 * across from `lib/postprocess/translate.ts:16-17` and `:23-26` nearly verbatim. They are
 * correct and hard-won: they are what stops a model tidying a transcript into sentences and
 * desynchronising it from the audio. The Burmese/English literals and the fixed direction do
 * not travel.
 */

export const TRANSLATE_DEFAULT = 'translate.default';
export const TRANSLATE_VERSION = 2;

export interface BuildTranslateInput {
  source: PromptLanguageVars;
  target: PromptLanguageVars;
  segments: readonly PromptSegment[];
  /**
   * Fixed terminology for this batch, already selected against the batch's own text.
   *
   * Absent in the eval harness, which measures translation quality with no newsroom glossary
   * in play, and built per batch in Phase 6 — a glossary can hold thousands of terms and
   * injecting all of them costs more than the translation and buries the ten that matter.
   * Rendered verbatim where supplied, so the selection logic stays outside the prompt.
   */
  glossaryBlock?: string;
}

export function buildTranslatePrompt(input: BuildTranslateInput): LlmPrompt {
  const { source: s, target: t } = input;
  const out: string[] = [];
  out.push(
    `You translate ${s.endonym} (${s.nameEn}) transcript segments into`,
    `${t.endonym} (${t.nameEn}).`,
    '',
    'Input is JSON: {"segments":[{"idx":<integer>,"text":"<text>"}]}',
    'Return JSON of the same shape, where "text" is the translation of that segment.',
  );
  const glossary = input.glossaryBlock?.trim();
  if (glossary) out.push('', glossary);
  out.push(
    '',
    'Guidance:',
    `- Translate for meaning, in natural ${t.nameEn} — not word for word.`,
    '- These are segments of continuous speech. A segment may begin or end mid-sentence.',
    '  Translate what is there; do not invent words to make it a complete sentence.',
    `- Render personal and place names using their conventional ${t.nameEn} spelling where`,
    '  one exists, and otherwise transliterate consistently across the whole batch.',
    '- Keep register: if the speaker is informal, hesitant or blunt, the translation is too.',
    '  This is a transcript of a person speaking, not a document.',
    '- If a segment is unintelligible or empty, return an empty string rather than guessing.',
    '',
    'Hard constraints:',
    '- Exactly one object per input segment, echoing its "idx" unchanged.',
    '- Never merge, split, reorder or drop segments. Each is pinned to an audio timestamp, so',
    '  the mapping must stay one to one.',
    '- Output the translation only — no notes, no transliteration alongside, no commentary.',
  );
  return {
    promptId: TRANSLATE_DEFAULT,
    promptVersion: TRANSLATE_VERSION,
    system: out.join('\n'),
    user: renderSegments(input.segments),
  };
}
