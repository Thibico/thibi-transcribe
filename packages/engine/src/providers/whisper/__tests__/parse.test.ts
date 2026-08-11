import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scriptIntegrity } from '@thibi/core';
import { SCRIPTS } from '@thibi/languages';
import { attachWords } from '../attach-words.js';
import { parseWhisperResponse, segmentConfidence, type WhisperVerboseJson } from '../parse.js';
/**
 * Fixtures are read at runtime rather than `import`ed.
 *
 * `resolveJsonModule` is off across this repo, so a JSON import type-checks under vitest's
 * esbuild and then fails `tsc -b` — which is a build break discovered at the end of a run
 * rather than in the editor. Reading them is also closer to what they are: recorded evidence
 * files, not modules.
 */
const FIXTURES = new URL('../__fixtures__/', import.meta.url);
const load = (name: string): { status: number; body: unknown; headers: Record<string, string> } =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));

const openaiEn = load('openai-verbose-json-en');
const openaiPromptEcho = load('openai-prompt-echo-en');
const groqEn = load('groq-en-verbose');
const groqMangled = load('groq-my-mangled');
const groqAutodetect = load('groq-my-autodetect');
const gpt4oJson = load('openai-gpt4o-json-en');
const gpt4oRefused = load('openai-gpt4o-verbose-refused');
const openaiMyRejected = load('openai-my-rejected');
const groqRepetitionLoop = load('groq-my-repetition-loop');

/**
 * Every fixture here is a recorded response, captured 2026-08-11. See the README beside them.
 */

const body = (fixture: { body: unknown }): WhisperVerboseJson => fixture.body as WhisperVerboseJson;

describe('the recorded response shape', () => {
  /**
   * The premise the whole adapter rests on. If this ever fails, `attach-words.ts` has become
   * unnecessary work rather than the thing holding word timings together.
   */
  it('returns words as a flat top-level array, not nested in segments', () => {
    for (const fixture of [openaiEn, groqEn]) {
      const parsed = body(fixture);
      expect(parsed.words!.length).toBeGreaterThan(parsed.segments!.length);
      for (const segment of parsed.segments!) {
        expect(segment.words).toBeUndefined();
      }
    }
  });

  /**
   * The measurement behind `wordConfidence: false`. Not a design preference — there is simply
   * no per-word number in the response to carry.
   */
  it('carries no per-word probability on either provider', () => {
    for (const fixture of [openaiEn, groqEn]) {
      for (const word of body(fixture).words!) {
        expect(Object.keys(word).sort()).toEqual(['end', 'start', 'word']);
      }
    }
  });

  it('carries avg_logprob and no_speech_prob per segment', () => {
    for (const segment of body(openaiEn).segments!) {
      expect(typeof segment.avg_logprob).toBe('number');
      expect(typeof segment.no_speech_prob).toBe('number');
    }
  });
});

describe('parseWhisperResponse', () => {
  it('attaches every word and loses none', () => {
    const raw = body(openaiEn);
    const result = parseWhisperResponse(raw, { offsetMs: 0, durationMs: 10_355 });

    const attached = result.segments.reduce((n, s) => n + s.words.length, 0);
    expect(attached).toBe(raw.words!.length);
    expect(result.usage.wordsUnattached).toBeUndefined();
    expect(result.wordTimingQuality).toBe('full');
    expect(result.segments).toHaveLength(4);
  });

  it('offsets every timestamp by the chunk position, and rounds to integer ms exactly once', () => {
    const result = parseWhisperResponse(body(openaiEn), { offsetMs: 600_000, durationMs: 10_355 });
    expect(result.segments[0]!.startMs).toBe(600_000);
    for (const segment of result.segments) {
      expect(Number.isInteger(segment.startMs)).toBe(true);
      expect(Number.isInteger(segment.endMs)).toBe(true);
      for (const word of segment.words) {
        expect(Number.isInteger(word.startMs)).toBe(true);
        expect(word.startMs).toBeGreaterThanOrEqual(600_000);
      }
    }
    // 0.18000000715255737 s -> 180 ms, and never 180.00000715255737.
    expect(result.segments[0]!.words[0]!.endMs).toBe(600_180);
  });

  it('never puts a confidence on a word, however tempting avg_logprob is', () => {
    const result = parseWhisperResponse(body(openaiEn), { offsetMs: 0, durationMs: 10_355 });
    for (const segment of result.segments) {
      expect(segment.confidence).not.toBeNull();
      for (const word of segment.words) expect(word.confidence).toBeNull();
    }
  });

  it('leaves a non-echoing prompt alone', () => {
    // The recorded prompt run came back byte-identical to the un-prompted one, so the guard
    // must not fire. A strip on the normal case would silently eat the first sentence.
    const prompt = 'Naypyidaw, ASEAN, Tatmadaw, Irrawaddy, Rakhine, Kachin, Shan State, Mandalay';
    const result = parseWhisperResponse(body(openaiPromptEcho), {
      offsetMs: 0,
      durationMs: 10_355,
      prompt,
    });
    expect(result.warnings.map((w) => w.code)).not.toContain('prompt_echo');
    expect(result.segments[0]!.text).toBe('The ASEAN summit concluded on Tuesday.');
  });
});

describe('segmentConfidence', () => {
  it('is exp(avg_logprob), clamped, and null when absent', () => {
    expect(segmentConfidence(-0.27546337246894836)).toBeCloseTo(Math.exp(-0.27546337246894836), 12);
    expect(segmentConfidence(0)).toBe(1);
    expect(segmentConfidence(-0)).toBe(1);
    expect(segmentConfidence(5)).toBe(1);
    // The one that matters: a missing field is unknown, not certain.
    expect(segmentConfidence(undefined)).toBeNull();
    expect(segmentConfidence(Number.NaN)).toBeNull();
  });
});

describe('the hallucination guard', () => {
  const withSegment = (text: string, noSpeech: number): WhisperVerboseJson => ({
    segments: [
      { start: 0, end: 2, text: ' Real speech here.', avg_logprob: -0.2, no_speech_prob: 0.01 },
      { start: 2, end: 4, text, avg_logprob: -0.9, no_speech_prob: noSpeech },
    ],
    words: [],
  });

  it('drops the trailing "Thank you." over silence, and only that', () => {
    const result = parseWhisperResponse(withSegment(' Thanks.', 0.91), {
      offsetMs: 0,
      durationMs: 4000,
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.text).toBe('Real speech here.');
    expect(result.warnings.map((w) => w.code)).toContain('hallucination_rate_high');
  });

  it('keeps a short segment the model was confident about', () => {
    // "Yes." over real speech scores a low no_speech_prob. Both conditions are required, and
    // this is the test that stops the guard from deleting genuine one-word answers.
    const result = parseWhisperResponse(withSegment(' Yes.', 0.02), {
      offsetMs: 0,
      durationMs: 4000,
    });
    expect(result.segments).toHaveLength(2);
  });

  it('keeps a long segment even at a high no_speech_prob', () => {
    const long = ' A whole sentence the model was unsure was speech at all.';
    const result = parseWhisperResponse(withSegment(long, 0.95), { offsetMs: 0, durationMs: 4000 });
    expect(result.segments).toHaveLength(2);
  });
});

describe('unattached words', () => {
  it('counts an orphan rather than dropping it', () => {
    const parsed: WhisperVerboseJson = {
      segments: [{ start: 1, end: 2, text: ' hello world', avg_logprob: -0.3 }],
      words: [
        // Inside.
        { word: 'hello', start: 1.0, end: 1.4 },
        { word: 'world', start: 1.5, end: 1.9 },
        // Well before the only segment: an orphan.
        { word: 'stray', start: 0.1, end: 0.2 },
      ],
    };
    const result = parseWhisperResponse(parsed, { offsetMs: 0, durationMs: 3000 });
    expect(result.segments[0]!.words).toHaveLength(2);
    expect(result.usage.wordsUnattached).toBe(1);
    expect(result.warnings.map((w) => w.code)).toContain('words_unattached');
  });

  it('puts a word straddling a boundary in exactly one segment', () => {
    const segments = [
      { startMs: 0, endMs: 2000, text: 'a', confidence: null },
      { startMs: 2000, endMs: 4000, text: 'b', confidence: null },
    ];
    // 1990 ms is within 20 ms of the second segment's start *and* inside the first. First
    // match wins, so the word count is conserved.
    const { segments: out, unattached } = attachWords(segments, [
      { startMs: 1990, endMs: 2100, text: 'straddle', confidence: null },
    ]);
    expect(unattached).toHaveLength(0);
    expect(out[0]!.words.length + out[1]!.words.length).toBe(1);
    expect(out[0]!.words).toHaveLength(1);
  });

  it('rescues a word starting just before its segment', () => {
    const segments = [{ startMs: 1000, endMs: 2000, text: 'a', confidence: null }];
    const { unattached } = attachWords(segments, [
      { startMs: 985, endMs: 1200, text: 'early', confidence: null },
    ]);
    expect(unattached).toHaveLength(0);
  });
});

describe('the Groq failure, as a number in CI', () => {
  const mymr = SCRIPTS['Mymr']!;
  const ranges = [{ code: mymr.code, unicodeRanges: mymr.unicodeRanges }];

  /**
   * Recorded 2026-08-11. The API returned HTTP 200 and a healthy-looking `avg_logprob` for
   * Burmese audio transcribed into **Khmer**. Nothing in the envelope says so; the number
   * below is what says so.
   */
  it('scores the language=my response as wrong-script', () => {
    const text = body(groqMangled).text!;
    const result = scriptIntegrity(text, ranges);
    expect(result.fraction).toBe(0);
    expect(result.counted).toBeGreaterThan(0);
  });

  it('scores the autodetect response as wrong-script, and it is Vietnamese', () => {
    const parsed = body(groqAutodetect);
    expect(parsed.language).toBe('Vietnamese');
    expect(scriptIntegrity(parsed.text!, ranges).fraction).toBe(0);
  });

  /**
   * The control, and the reason the two above are dangerous rather than merely wrong: on
   * English the same model and the same request shape are correct and confident.
   */
  it('scores the English control as right-script', () => {
    const latn = SCRIPTS['Latn']!;
    const result = scriptIntegrity(body(groqEn).text!, [
      { code: latn.code, unicodeRanges: latn.unicodeRanges },
    ]);
    expect(result.fraction).toBe(1);
  });

  it('cannot be told apart from a good response by any field in the envelope', () => {
    const bad = body(groqMangled).segments![0]!;
    const good = body(groqEn).segments![0]!;
    // Both look healthy. This assertion exists to be read, not to catch a regression.
    expect(bad.no_speech_prob).toBeLessThan(0.1);
    expect(segmentConfidence(bad.avg_logprob)).toBeGreaterThan(0.5);
    expect(segmentConfidence(good.avg_logprob)).toBeGreaterThan(0.5);
  });
});

describe('the repetition loop, as recorded', () => {
  /**
   * 2 s of audio in, 96 words out, the last of them ending at 30.4 s. Captured live on
   * 2026-08-11 through `thibi transcribe --raw-dir`, which is the only reason we know this
   * failure mode exists at all — it does not appear in the 2 s fixture recorded minutes
   * earlier from the same clip and the same model.
   */
  it('is words timed far past the end of the audio', () => {
    const parsed = body(groqRepetitionLoop);
    expect(parsed.duration).toBe(2);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments![0]!.end).toBe(2);
    expect(parsed.words!.length).toBe(96);
    expect(Math.max(...parsed.words!.map((w) => w.end!))).toBeCloseTo(30.4, 5);
  });

  it('diagnoses it as the provider’s fault, not the matcher’s', () => {
    const result = parseWhisperResponse(body(groqRepetitionLoop), {
      offsetMs: 0,
      durationMs: 2000,
    });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('timings_beyond_audio');
    const warning = result.warnings.find((w) => w.code === 'timings_beyond_audio')!;
    expect(warning.message).toContain('repetition loop');
    expect(warning.message).toContain('30.4s');
  });

  it('lets no impossible timing into the transcript', () => {
    const result = parseWhisperResponse(body(groqRepetitionLoop), {
      offsetMs: 0,
      durationMs: 2000,
    });
    for (const segment of result.segments) {
      for (const word of segment.words) {
        expect(word.startMs).toBeLessThanOrEqual(2000);
      }
    }
    // The text still comes through — a suspect transcript is still the provider's answer,
    // and deleting it would hide the finding rather than report it.
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.text.length).toBeGreaterThan(0);
  });

  it('does not double-count them as merely unattached', () => {
    const result = parseWhisperResponse(body(groqRepetitionLoop), {
      offsetMs: 0,
      durationMs: 2000,
    });
    const unattached = result.warnings.find((w) => w.code === 'words_unattached');
    // Every unattached word here is explained by the impossible-timing warning, so the vaguer
    // one must not also fire and send someone hunting for a matcher bug.
    expect(unattached).toBeUndefined();
  });
});

describe('the gpt-4o timestamp trap, as recorded', () => {
  it('refuses verbose_json with a message naming the format', () => {
    expect(gpt4oRefused.status).toBe(400);
    const message = (gpt4oRefused.body as { error?: { message?: string } }).error!.message!;
    expect(message).toContain('verbose_json');
    expect(message).toContain('not compatible');
  });

  it('returns text and nothing else under response_format=json', () => {
    expect(gpt4oJson.status).toBe(200);
    const parsed = gpt4oJson.body as Record<string, unknown>;
    expect(parsed['text']).toBeTypeOf('string');
    expect(parsed['segments']).toBeUndefined();
    expect(parsed['words']).toBeUndefined();
  });
});

describe('the 44-language finding, as recorded', () => {
  it('is a 400 naming the language, which is what the error mapper keys on', () => {
    expect(openaiMyRejected.status).toBe(400);
    const error = (openaiMyRejected.body as { error: { message: string; code: string } }).error;
    expect(error.message).toBe("Language 'my' is not supported.");
    expect(error.code).toBe('unsupported_language');
  });
});
