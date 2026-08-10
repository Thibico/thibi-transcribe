import type { ProviderLanguageCapability } from '@thibi/languages';
import type { ProbeOutcome } from './types.js';

/**
 * Turning HTTP responses into capability rows.
 *
 * The single most likely way to corrupt `provider-matrix.json` is recording a rate limit
 * as a rejection: a 429 would erase a measured acceptance and the language would silently
 * disappear from the picker. Every rule below exists to make that impossible, so this is a
 * pure function with recorded fixtures rather than something buried in the request loop.
 */

/**
 * Every phrasing below is a message a provider actually returned during the 2026-08-09
 * probe, not a guess. The four endpoints word "I do not have that language" four different
 * ways and none of them uses a distinguishing status code:
 *
 *   Google  400  "Bad language code"
 *   OpenAI  400  "Language code 'ha' is not recognized. Try adding the language name…"
 *   Groq    400  "unsupported language: xx\nLanguage must be one of: [...]"
 *
 * A phrasing this misses degrades to `error`, which preserves the previous row and flags
 * the code for human review — the safe direction. A phrasing that matched too eagerly
 * would write `supported: false` over a working language, so the patterns stay narrow.
 */
const UNSUPPORTED =
  /not supported|unsupported language|invalid.*language|language.*invalid|language code .*(not recognized|not recognised)|bad language code/i;

export type Classification = 'accepted' | 'rejected' | 'error' | 'unknown';

export function classifyOutcome(outcome: ProbeOutcome): Classification {
  if (outcome.httpStatus >= 200 && outcome.httpStatus < 300) return 'accepted';
  if (outcome.httpStatus === 400) {
    return UNSUPPORTED.test(outcome.errorMessage ?? '') ? 'rejected' : 'error';
  }
  // 401/403 abort the run before this point; anything else is transient.
  return 'unknown';
}

export interface ClassifyInput {
  providerCode: string;
  probedAt: string;
  /** From a spike, not from this request. `chirp_2` is 'none' — see spike S1. */
  adaptation: ProviderLanguageCapability['adaptation'];
  attempts: ReadonlyArray<{ model: string; outcome: ProbeOutcome }>;
  /** The row already in the committed matrix, if any. */
  previous?: ProviderLanguageCapability | undefined;
}

/**
 * Combine one language's attempts across a provider's models into a single row.
 *
 * A code counts as accepted if *any* model accepts it — the "44 languages no OpenAI model
 * will accept" figure is the union of whisper-1's 57 and gpt-4o-transcribe's 67, so a
 * per-model view would double-count.
 */
export function classifyLanguage(input: ClassifyInput): ProviderLanguageCapability {
  const { previous } = input;
  const classified = input.attempts.map((a) => ({ ...a, kind: classifyOutcome(a.outcome) }));
  const accepted = classified.filter((a) => a.kind === 'accepted');

  const carryOver = {
    ...(previous?.reason !== undefined ? { reason: previous.reason } : {}),
    ...(previous?.evidence !== undefined ? { evidence: previous.evidence } : {}),
  };

  if (accepted.length > 0) {
    const hasWordsValues = accepted.map((a) => a.outcome.hasWords);
    return {
      status: 'accepted',
      // A 200 can only ever set this true. Only matrix-overrides.json or the eval harness
      // can set it false, which is what stops a re-run erasing the Groq Burmese finding.
      supported: true,
      verdict: 'probe-only',
      providerCode: input.providerCode,
      models: accepted.map((a) => a.model),
      wordTimestamps: hasWordsValues.some((v) => v === true)
        ? true
        : hasWordsValues.some((v) => v === false)
          ? false
          : null,
      adaptation: input.adaptation,
      httpStatus: accepted[0]!.outcome.httpStatus,
      probedAt: input.probedAt,
      ...carryOver,
    };
  }

  const rejected = classified.filter((a) => a.kind === 'rejected');
  const errored = classified.filter((a) => a.kind === 'error');
  const unknown = classified.filter((a) => a.kind === 'unknown');

  // Every model said "I do not support this language", and nothing was ambiguous.
  if (rejected.length === classified.length && classified.length > 0) {
    return {
      status: 'rejected',
      supported: false,
      verdict: 'measured-failure',
      providerCode: input.providerCode,
      wordTimestamps: null,
      adaptation: input.adaptation,
      httpStatus: 400,
      probedAt: input.probedAt,
      ...(rejected[0]!.outcome.errorMessage
        ? { errorMessage: rejected[0]!.outcome.errorMessage }
        : {}),
      ...carryOver,
    };
  }

  // A 400 we do not recognise, or a rate limit that outlasted its retries. Neither is
  // evidence about support, so `supported` and `probedAt` keep whatever was already known
  // and the row is listed for human review in the run summary.
  const sample = (errored[0] ?? unknown[0])!;
  return {
    status: errored.length > 0 ? 'error' : 'unknown',
    supported: previous?.supported ?? false,
    verdict: previous?.verdict ?? 'probe-only',
    providerCode: input.providerCode,
    ...(previous?.models ? { models: previous.models } : {}),
    wordTimestamps: previous?.wordTimestamps ?? null,
    adaptation: input.adaptation,
    ...(sample ? { httpStatus: sample.outcome.httpStatus } : {}),
    ...(sample?.outcome.errorMessage ? { errorMessage: sample.outcome.errorMessage } : {}),
    // Not `input.probedAt`: we learned nothing today, so the date of what we do know
    // must not be refreshed to look current.
    probedAt: previous?.probedAt ?? 'never',
    ...carryOver,
  };
}
