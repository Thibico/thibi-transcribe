import type { WordTimingQuality } from '@thibi/core';
import type { TranscribeResult } from '../types.js';
import { attachWords, type TimedSegment, type TimedWord } from './attach-words.js';
import { stripPromptEcho } from './prompt.js';

/**
 * Parse an OpenAI / Groq `verbose_json` transcription response.
 *
 * The response shape:
 *
 * ```json
 * { "task": "transcribe", "language": "burmese", "duration": 58.6, "text": "…",
 *   "segments": [ { "id": 0, "start": 0.0, "end": 4.2, "text": " …",
 *                   "avg_logprob": -0.31, "no_speech_prob": 0.02 } ],
 *   "words":    [ { "word": "…", "start": 0.0, "end": 0.34 } ] }
 * ```
 *
 * Two things about it drive every decision in this file. `words` is a **flat top-level
 * array** rather than nested inside segments, which `attach-words.ts` exists to undo. And
 * `avg_logprob` is the only confidence on offer — see `segmentConfidence` below for why it
 * never reaches a word.
 */

export interface WhisperSegmentJson {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  /** faster-whisper and some proxies nest words here instead. Handled, not assumed absent. */
  words?: WhisperWordJson[];
}

export interface WhisperWordJson {
  word?: string;
  start?: number;
  end?: number;
  /** Not sent by OpenAI or Groq. faster-whisper's genuine per-word probability lands here. */
  probability?: number;
}

export interface WhisperVerboseJson {
  task?: string;
  language?: string;
  duration?: number;
  text?: string;
  segments?: WhisperSegmentJson[];
  words?: WhisperWordJson[];
}

export interface ParseWhisperOptions {
  /** Absolute position of this chunk in the source file. Added to every timestamp. */
  offsetMs: number;
  /** Extracted length of the chunk, used for `usage.audioMs`. */
  durationMs: number;
  /** The prompt that was sent, if any — needed to detect an echo of it. */
  prompt?: string;
  /** True for a provider whose per-word numbers are real. False for OpenAI and Groq. */
  wordConfidence?: boolean;
}

/**
 * The silence-hallucination guard, and a **correction to the Phase 4 plan**.
 *
 * The plan says: drop segments where `no_speech_prob > 0.6 && text.trim().length < 3` — "the
 * 'Thank you.' that Whisper emits over trailing silence". Those two halves contradict each
 * other in the same sentence. `"Thank you."` is ten characters, `"Thanks."` is seven, and
 * `"Thanks for watching!"` is twenty; a three-character cap cannot drop any of them. As
 * written the guard would only ever remove one- and two-character segments, which is not the
 * failure it was designed for. Writing the test is what surfaced it.
 *
 * The signal that actually carries the information is `no_speech_prob`: above 0.6 the model
 * is saying it thinks this is more likely *not speech* than speech. The length cap is not the
 * detector, it is the safety rail — it keeps the guard from deleting a long passage on the
 * strength of one uncertain number. So the cap moves to 30 characters, wide enough for the
 * known hallucination phrases and still far too narrow to lose a paragraph.
 *
 * Both conditions remain required. A genuine short utterance — "Yes." in an interview —
 * scores a *low* `no_speech_prob` and survives, and there is a test for exactly that, because
 * silently deleting one-word answers from an interview transcript would be a worse bug than
 * the one this guard fixes.
 */
export const NO_SPEECH_THRESHOLD = 0.6;
export const HALLUCINATION_MAX_CHARS = 30;

/**
 * Dropping a tenth of a transcript deserves to be said out loud rather than logged at debug.
 * Above this fraction the guard is more likely to be misfiring than the provider is to be
 * hallucinating that much.
 */
export const HALLUCINATION_WARN_FRACTION = 0.1;

function toMs(seconds: number | undefined): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  // Rounding to integer milliseconds happens exactly here, once, as it does in the Google
  // parser. Any float seconds surviving past this function is a bug.
  return Math.round(seconds * 1000);
}

/**
 * `exp(avg_logprob)`, clamped, and **only ever at segment level**.
 *
 * This is a length-normalised model likelihood: roughly monotone with quality, entirely
 * uncalibrated. It is good for sorting segments by suspicion and useless as a probability,
 * so it is never divided down onto words and `wordConfidence` stays false for these
 * providers. Implying precision that is not there is worse than showing nothing.
 *
 * A missing field is `null`, never 1 — an absent measurement must not read as certainty.
 */
export function segmentConfidence(avgLogprob: number | undefined): number | null {
  if (typeof avgLogprob !== 'number' || !Number.isFinite(avgLogprob)) return null;
  return Math.min(1, Math.max(0, Math.exp(avgLogprob)));
}

export function parseWhisperResponse(
  body: WhisperVerboseJson,
  options: ParseWhisperOptions,
): TranscribeResult {
  return { ...parseWhisperResults(body, options), raw: body };
}

/** Everything except `raw`, which only the caller knows the envelope of. */
export function parseWhisperResults(
  body: WhisperVerboseJson,
  options: ParseWhisperOptions,
): Omit<TranscribeResult, 'raw'> {
  const { offsetMs, durationMs } = options;
  const warnings: Array<{ code: string; message: string }> = [];

  const rawSegments = body.segments ?? [];
  let cursorMs = offsetMs;

  const kept: TimedSegment[] = [];
  let hallucinated = 0;
  let withoutTiming = 0;

  for (const segment of rawSegments) {
    const text = (segment.text ?? '').trim();
    if (text.length === 0) continue;

    const noSpeech = segment.no_speech_prob;
    if (
      typeof noSpeech === 'number' &&
      noSpeech > NO_SPEECH_THRESHOLD &&
      text.length < HALLUCINATION_MAX_CHARS
    ) {
      hallucinated++;
      continue;
    }

    const start = toMs(segment.start);
    const end = toMs(segment.end);
    if (start === null && end === null) withoutTiming++;

    const startMs = start === null ? cursorMs : offsetMs + start;
    const endMs = end === null ? Math.max(startMs, cursorMs) : offsetMs + end;
    kept.push({
      startMs,
      endMs: Math.max(startMs, endMs),
      text,
      confidence: segmentConfidence(segment.avg_logprob),
    });
    cursorMs = Math.max(cursorMs, endMs);
  }

  // Strip a prompt echoed into the first segment, after the hallucination filter so that a
  // dropped leading segment does not hide the echo in the one behind it.
  if (options.prompt && kept.length > 0) {
    const echo = stripPromptEcho(kept[0]!.text, options.prompt);
    if (echo.strippedChars > 0) {
      warnings.push({
        code: 'prompt_echo',
        message:
          `The provider echoed ${echo.strippedChars} characters of the glossary prompt into ` +
          `the transcript; they were removed. Whisper does this occasionally — it is a ` +
          `property of prompt conditioning, not of this recording.`,
      });
      if (echo.text.length === 0) kept.shift();
      else kept[0]!.text = echo.text;
    }
  }

  // Words come from the flat top-level array. Some responses (and faster-whisper) nest them
  // per segment instead; concatenating both is safe because a response uses one or the other,
  // and `attachWords` would put a duplicated word in one bucket, not two.
  const nested = rawSegments.flatMap((s) => s.words ?? []);
  const flat = [...(body.words ?? []), ...nested];
  const words: TimedWord[] = flat
    .map((w) => {
      const start = toMs(w.start);
      const end = toMs(w.end);
      return {
        startMs: offsetMs + (start ?? 0),
        endMs: offsetMs + (end ?? start ?? 0),
        text: (w.word ?? '').trim(),
        // Only when the provider genuinely measures one. For OpenAI and Groq this is always
        // null: there is no per-word number in the response to carry.
        confidence:
          options.wordConfidence && typeof w.probability === 'number' ? w.probability : null,
        hasTiming: start !== null || end !== null,
      };
    })
    .filter((w) => w.text.length > 0 && w.hasTiming)
    .map(({ hasTiming: _drop, ...w }) => w);

  const attached = attachWords(kept, words);

  /**
   * Words timed past the end of the audio are **impossible**, and they are the signature of a
   * Whisper repetition loop.
   *
   * Measured 2026-08-11, and it is why this check exists rather than being a hypothetical: the
   * 2 s Burmese probe clip through Groq `whisper-large-v3` with `language=my` returned 96 words
   * spanning **30.4 s** — fifteen times the audio — while the body's own `duration` said 2 and
   * its single segment ended at 2 s. The model got stuck repeating a syllable and kept
   * emitting timestamps for it.
   *
   * They are already unattached, because no segment reaches that far, so no bad timing enters
   * the transcript. What this adds is the *diagnosis*: "63 words could not be matched" invites
   * someone to go looking for a bug in the matcher, and "the provider timed words past the end
   * of the audio" points at the provider, which is where the problem is.
   */
  const impossible = attached.unattached.filter((w) => w.startMs > offsetMs + durationMs);
  if (impossible.length > 0) {
    const furthest = Math.max(...impossible.map((w) => w.endMs)) - offsetMs;
    warnings.push({
      code: 'timings_beyond_audio',
      message:
        `${impossible.length} words were timed past the end of the ${Math.round(durationMs / 1000)}s ` +
        `chunk, the furthest ending at ${(furthest / 1000).toFixed(1)}s. That is a Whisper ` +
        `repetition loop, not a timing offset — treat the text of this chunk as suspect.`,
    });
  }

  if (hallucinated > 0) {
    const total = hallucinated + kept.length;
    const message =
      `Dropped ${hallucinated} of ${total} segments as silence hallucinations ` +
      `(no_speech_prob > ${NO_SPEECH_THRESHOLD} with under ${HALLUCINATION_MAX_CHARS} ` +
      `characters of text).`;
    warnings.push(
      hallucinated / total > HALLUCINATION_WARN_FRACTION
        ? {
            code: 'hallucination_rate_high',
            message: `${message} That is over ${HALLUCINATION_WARN_FRACTION * 100}% of this chunk — check the audio and the response before trusting the transcript.`,
          }
        : { code: 'hallucination_dropped', message },
    );
  }

  if (attached.unattached.length > impossible.length) {
    // Only the ones the specific diagnosis above does not already explain.
    const unexplained = attached.unattached.length - impossible.length;
    warnings.push({
      code: 'words_unattached',
      message:
        `${unexplained} word${unexplained === 1 ? '' : 's'} could not be matched to any segment ` +
        `and ${unexplained === 1 ? 'is' : 'are'} absent from the word timings. The segment text ` +
        `is unaffected.`,
    });
  }

  const withWords = attached.segments.filter((s) => s.words.length > 0).length;
  const wordTimingQuality: WordTimingQuality =
    attached.segments.length === 0 || withWords === 0
      ? 'none'
      : withWords === attached.segments.length
        ? 'full'
        : 'partial';

  if (wordTimingQuality !== 'full' && attached.segments.length > 0) {
    warnings.push({
      code: 'no_word_timings',
      message:
        wordTimingQuality === 'none'
          ? 'The provider returned no word offsets for this chunk; word timings will be interpolated.'
          : `${attached.segments.length - withWords} of ${attached.segments.length} segments came back without word offsets.`,
    });
  }

  if (withoutTiming > 0) {
    warnings.push({
      code: 'segment_without_timing',
      message: `${withoutTiming} segment(s) carried no start or end at all; their intervals continue from the previous segment.`,
    });
  }

  return {
    segments: attached.segments,
    wordTimingQuality,
    usage: {
      audioMs: durationMs,
      requests: 1,
      ...(attached.unattached.length > 0 ? { wordsUnattached: attached.unattached.length } : {}),
    },
    warnings,
  };
}
