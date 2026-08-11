/**
 * Glossary terms → Whisper's `prompt` / `initial_prompt`.
 *
 * One function for all three Whisper providers — OpenAI and Groq take it as `prompt` over
 * HTTP, faster-whisper as `initial_prompt` on the sidecar — so glossary behaviour cannot
 * drift between them and Phase 5 can attribute a difference in output to the model rather
 * than to how we built the string.
 *
 * What this is *not*: a constraint. Whisper treats the prompt as a style and vocabulary
 * hint, ignores it freely, and occasionally echoes it straight into the transcript — which
 * `stripPromptEcho` below exists to undo. Whether it improves accuracy at all is unmeasured
 * and is an eval arm in Phase 5, not an assumption this module is allowed to make.
 */

/** Matches `TranscribeRequest.adaptation.phrases`, so a caller passes that array straight in. */
export interface PromptTerm {
  value: string;
  boost?: number;
}

export interface BuiltPrompt {
  prompt: string;
  included: number;
  dropped: number;
  estTokens: number;
}

/**
 * Whisper conditions on **224 tokens of its own multilingual tokenizer**, and there is no
 * cheap exact implementation of that tokenizer in Node. We estimate, and we truncate at 200
 * rather than 224 so the estimate can be wrong by 10% in the expensive direction without
 * silently losing terms.
 *
 * Adding `tiktoken` is the real fix, and it is deliberately deferred: it is only worth the
 * dependency once Phase 5 has measured that the prompt helps at all.
 */
export const MAX_EST_TOKENS = 200;

const SEPARATOR = ', ';

/**
 * Anything past U+036F — Cyrillic, Greek, Burmese, Khmer, Arabic, CJK — tokenizes far worse
 * than Latin under Whisper's BPE, frequently at one token per code point. 2.5 chars/token is
 * the conservative side of that; over-estimating costs a few dropped low-boost terms, while
 * under-estimating means the API truncates for us, from the wrong end.
 */
function estimateTokens(text: string): number {
  const nonLatin = /[^\u0020-\u036F]/u.test(text);
  return Math.ceil(text.length / (nonLatin ? 2.5 : 4));
}

/**
 * Sort by boost descending, then by length descending, and fill the budget.
 *
 * **Truncation is from the back**, i.e. we drop the terms we ranked lowest. This is the
 * whole reason the function exists rather than a `join(', ')` at the call site: the API
 * silently truncates an over-budget prompt from the *front*, which would discard the
 * highest-boost terms — exactly backwards from what a glossary is for.
 */
export function buildWhisperPrompt(
  terms: readonly PromptTerm[],
  options: { maxTokens?: number } = {},
): BuiltPrompt {
  const maxTokens = options.maxTokens ?? MAX_EST_TOKENS;

  // Deduplicate on the term itself, keeping the highest boost it was given. A glossary
  // assembled from several sources repeats terms, and spending the budget twice on one word
  // is the same as dropping another word outright.
  const byValue = new Map<string, number>();
  for (const term of terms) {
    const value = term.value.trim();
    if (value.length === 0) continue;
    const boost = term.boost ?? 0;
    byValue.set(value, Math.max(byValue.get(value) ?? boost, boost));
  }

  const ranked = [...byValue]
    .map(([value, boost]) => ({ value, boost }))
    .sort((a, b) => b.boost - a.boost || b.value.length - a.value.length);

  const kept: string[] = [];
  let estTokens = 0;
  let dropped = 0;

  for (const term of ranked) {
    // The separator costs a token too, and forgetting it is how a 200-token budget becomes
    // a 250-token prompt at 50 terms.
    const cost = estimateTokens(term.value) + (kept.length > 0 ? 1 : 0);
    if (estTokens + cost > maxTokens) {
      dropped++;
      continue;
    }
    kept.push(term.value);
    estTokens += cost;
  }

  return { prompt: kept.join(SEPARATOR), included: kept.length, dropped, estTokens };
}

/**
 * The shortest echo we are willing to call an echo.
 *
 * Below this, a match is as likely to be the speaker genuinely saying a glossary term at the
 * top of the recording — which is common, because a glossary is built from what gets said —
 * and stripping that would delete real transcript.
 */
export const MIN_ECHO_CHARS = 12;

export interface EchoStrip {
  text: string;
  strippedChars: number;
}

/**
 * Strip a prompt echoed into the first segment.
 *
 * Whisper sometimes emits the conditioning prompt as if it were speech. It is always at the
 * very start and always a prefix of the prompt, so the test is a longest-common-prefix
 * against the prompt string, not a fuzzy search — a substring match anywhere would happily
 * delete a sentence that merely contained two glossary terms.
 */
export function stripPromptEcho(
  text: string,
  prompt: string,
  options: { minChars?: number } = {},
): EchoStrip {
  const minChars = options.minChars ?? MIN_ECHO_CHARS;
  if (prompt.length === 0) return { text, strippedChars: 0 };

  const leading = text.length - text.trimStart().length;
  const body = text.slice(leading);

  let common = 0;
  const limit = Math.min(body.length, prompt.length);
  while (common < limit && body[common] === prompt[common]) common++;
  if (common < minChars) return { text, strippedChars: 0 };

  // Take the punctuation and whitespace the echo left behind with it, or the segment starts
  // with a stray ", ".
  const remainder = body.slice(common).replace(/^[\s,.;:—–-]+/u, '');
  return { text: remainder, strippedChars: text.length - remainder.length };
}
