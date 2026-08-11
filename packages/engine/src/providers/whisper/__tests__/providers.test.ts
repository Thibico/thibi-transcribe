import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chooseProvider, PROVIDER_MATRIX } from '@thibi/languages';
import {
  ChunkTooLargeError,
  NotConfiguredError,
  ProviderError,
  RateLimitedError,
  UnsupportedLanguageError,
} from '../../../errors.js';
import { createGroqProvider, groqCapabilities } from '../../groq.js';
import { createOpenAiProvider, openAiCapabilities, resolveModelWithReason } from '../../openai.js';
import { paramsHash, transcribeWhisperHttp } from '../../whisper-http.js';
import { GROQ_TRANSPORT } from '../../groq.js';
import { buildWhisperPrompt, stripPromptEcho } from '../prompt.js';
import { parseRetryAfter, readRateLimitHeaders, toWhisperError } from '../errors.js';
import { whisperLanguageCode } from '../language.js';

const logger = {
  child: () => logger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('resolveModelWithReason — the gpt-4o timestamp trap', () => {
  it('returns whisper-1 for a language it accepts', () => {
    expect(resolveModelWithReason('en-US', { requireWordTimestamps: true }).model).toBe('whisper-1');
  });

  /**
   * The DoD item. A bare null here is how "Bengali is gpt-4o-only and that model returns no
   * timestamps" gets misdiagnosed as "OpenAI doesn't do Bengali", so the reason is asserted
   * as hard as the null.
   */
  it('returns null for a gpt-4o-only language when timestamps are required — with a reason', () => {
    const resolved = resolveModelWithReason('bn-IN', { requireWordTimestamps: true });
    expect(resolved.model).toBeNull();
    expect(resolved.reason).toContain('gpt-4o-transcribe');
    expect(resolved.reason).toContain('no timestamps');
    expect(resolved.reason).toContain('--no-word-timestamps');
  });

  it('returns gpt-4o-transcribe for that same language when timestamps are not required', () => {
    const resolved = resolveModelWithReason('bn-IN', { requireWordTimestamps: false });
    expect(resolved.model).toBe('gpt-4o-transcribe');
    expect(resolved.reason).toContain('no timestamps');
  });

  it('explains a rejected code with the provider’s own words', () => {
    const resolved = resolveModelWithReason('my-MM', { requireWordTimestamps: true });
    expect(resolved.model).toBeNull();
    expect(resolved.reason).toContain("Language 'my' is not supported.");
  });

  it('never returns an empty reason', () => {
    for (const code of Object.keys(PROVIDER_MATRIX)) {
      for (const requireWordTimestamps of [true, false]) {
        expect(resolveModelWithReason(code, { requireWordTimestamps }).reason.length).toBeGreaterThan(10);
      }
    }
  });
});

describe('capabilities are facts, and the important one is a false', () => {
  it('neither HTTP provider claims per-word confidence', () => {
    expect(openAiCapabilities('whisper-1').wordConfidence).toBe(false);
    expect(groqCapabilities('whisper-large-v3').wordConfidence).toBe(false);
  });

  it('openai declares segment confidence and timestamps only on whisper-1', () => {
    expect(openAiCapabilities('whisper-1').wordTimestamps).toBe(true);
    expect(openAiCapabilities('gpt-4o-transcribe').wordTimestamps).toBe(false);
    expect(openAiCapabilities('gpt-4o-transcribe').segmentConfidence).toBe(false);
  });

  it('neither declares a batch mode it does not have', () => {
    expect(openAiCapabilities().modes).not.toContain('batch');
    expect(groqCapabilities().modes).not.toContain('batch');
    expect(openAiCapabilities().staging).toBe('none');
  });

  it('groq defaults to the pessimistic free-tier byte cap and raises it on request', () => {
    expect(groqCapabilities().limits.syncMaxBytes).toBe(25 * 1024 * 1024);
    expect(groqCapabilities('whisper-large-v3', { syncMaxBytes: 100 * 1024 * 1024 }).limits.syncMaxBytes).toBe(
      100 * 1024 * 1024,
    );
  });
});

describe('the matrix itself', () => {
  /**
   * **An assertion on the data file, not on code.**
   *
   * `thibi probe languages` re-runs against the live API and a 200 sets `supported: true`.
   * Without this test, a re-probe would quietly flip Burmese back to supported on Groq and
   * erase the measurement the entire product thesis rests on. `matrix-overrides.json` is the
   * mechanism that prevents it; this is the test that proves the mechanism works.
   */
  it('keeps Groq’s Burmese failure recorded, whoever re-runs the probe', () => {
    const overrides = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../../languages/data/matrix-overrides.json', import.meta.url)),
        'utf8',
      ),
    ) as { groq: Record<string, { supported?: boolean; verdict?: string }> };

    expect(overrides.groq['my-MM']).toMatchObject({
      supported: false,
      verdict: 'measured-failure',
    });

    // And that the override actually reached the compiled registry.
    const capability = PROVIDER_MATRIX['my-MM']!.groq!;
    expect(capability.status).toBe('accepted');
    expect(capability.supported).toBe(false);
    expect(capability.verdict).toBe('measured-failure');
    expect(capability.reason).toMatch(/non-words/);
  });

  it('makes the provider refuse the language the API would happily accept', () => {
    const groq = createGroqProvider();
    expect(groq.resolveModel('my-MM')).toBeNull();
    expect(groq.supportsLanguage('my-MM')!.supported).toBe(false);
    // The distinction the matrix exists to carry: rejected is not the same as mangled.
    expect(groq.supportsLanguage('my-MM')!.status).toBe('accepted');
    expect(createOpenAiProvider().supportsLanguage('my-MM')!.status).toBe('rejected');
  });
});

describe('the unmeasured Groq codes', () => {
  const risky = Object.keys(PROVIDER_MATRIX).filter(
    (code) => PROVIDER_MATRIX[code]!.groq?.status === 'accepted' && !PROVIDER_MATRIX[code]!.openai?.supported,
  );

  it('is the 24 codes Groq accepts and no OpenAI model does', () => {
    expect(risky).toHaveLength(24);
  });

  /**
   * **A deliberate departure from the Phase 4 plan.**
   *
   * The plan's Definition of done asked for these to be `supported: false, evidence:
   * "assumed"`. They are `verdict: 'suspected'` with `supported` left alone, because Phase 0
   * doctrine — written into `matrix-overrides.json` — says marking a whole family unsupported
   * on a hunch is the same error as marking it supported on a status code, in the other
   * direction. What is not in doubt is that this is the set the risk lives in: the one
   * measured failure came out of it.
   */
  it('is every one of them flagged, not one of them fabricated as a failure', () => {
    for (const code of risky) {
      const capability = PROVIDER_MATRIX[code]!.groq!;
      expect(
        capability.verdict === 'suspected' || capability.verdict === 'measured-failure',
      ).toBe(true);
      expect(capability.reason).toBeTruthy();
    }
    // Exactly one is a measured failure. The rest are flagged as unverified, not as broken.
    const measured = risky.filter((c) => PROVIDER_MATRIX[c]!.groq!.verdict === 'measured-failure');
    expect(measured).toEqual(['my-MM']);
  });

  it('never lets a suspected Groq row outrank a settled Google one', () => {
    for (const code of risky) {
      const choice = chooseProvider(code, { requireWordTimestamps: true });
      if (choice) expect(choice.providerId).not.toBe('groq');
    }
  });
});

describe('chooseProvider', () => {
  it('picks Google for Burmese, and says why', () => {
    const choice = chooseProvider('my-MM', { requireWordTimestamps: true })!;
    expect(choice.providerId).toBe('google');
    expect(choice.reason.length).toBeGreaterThan(20);
  });

  it('refuses an explicit unsupported provider rather than substituting one', () => {
    expect(chooseProvider('my-MM', { force: 'groq' })).toBeNull();
  });

  it('returns it with forcedUnsupported set when the caller insists', () => {
    const choice = chooseProvider('my-MM', { force: 'groq', allowUnsupported: true })!;
    expect(choice.providerId).toBe('groq');
    expect(choice.forcedUnsupported).toBe(true);
    expect(choice.reason).toMatch(/unsupported/);
  });

  it('never returns a choice without a reason', () => {
    for (const code of Object.keys(PROVIDER_MATRIX)) {
      const choice = chooseProvider(code, { requireWordTimestamps: true });
      if (choice) expect(choice.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('buildWhisperPrompt', () => {
  const burmeseTerms = Array.from({ length: 400 }, (_, i) => ({
    value: `မြန်မာ${i}`,
    boost: i < 5 ? 20 : 1,
  }));

  it('truncates 400 terms to the estimated-token budget', () => {
    const built = buildWhisperPrompt(burmeseTerms);
    expect(built.estTokens).toBeLessThanOrEqual(200);
    expect(built.dropped).toBeGreaterThan(300);
    expect(built.included + built.dropped).toBe(400);
  });

  /**
   * **From the back, and this is the whole reason the function exists.** The API silently
   * truncates an over-budget prompt from the *front*, which would discard exactly the
   * highest-boost terms a glossary is for.
   */
  it('keeps the highest-boost terms and drops the tail', () => {
    const built = buildWhisperPrompt(burmeseTerms);
    for (let i = 0; i < 5; i++) expect(built.prompt).toContain(`မြန်မာ${i}`);
    expect(built.prompt).not.toContain('မြန်မာ399');
  });

  it('costs non-Latin scripts more per character than Latin', () => {
    const latin = buildWhisperPrompt([{ value: 'Naypyidaw' }]);
    const burmese = buildWhisperPrompt([{ value: 'နေပြည်တော်' }]);
    expect(burmese.estTokens).toBeGreaterThan(latin.estTokens);
  });

  it('deduplicates, keeping the highest boost', () => {
    const built = buildWhisperPrompt([
      { value: 'ASEAN', boost: 1 },
      { value: 'ASEAN', boost: 20 },
      { value: 'Yangon', boost: 5 },
    ]);
    expect(built.included).toBe(2);
    expect(built.prompt).toBe('ASEAN, Yangon');
  });

  it('is empty and harmless with no terms', () => {
    expect(buildWhisperPrompt([]).prompt).toBe('');
    expect(buildWhisperPrompt([{ value: '   ' }]).included).toBe(0);
  });
});

describe('stripPromptEcho', () => {
  const prompt = 'Naypyidaw, ASEAN, Tatmadaw, Irrawaddy';

  it('strips an echo of at least 12 characters and counts it', () => {
    const result = stripPromptEcho(`${prompt}. The summit concluded.`, prompt);
    expect(result.text).toBe('The summit concluded.');
    expect(result.strippedChars).toBeGreaterThan(prompt.length);
  });

  it('leaves a short coincidental match alone', () => {
    // "Naypyidaw" is 9 characters — under the floor, and a speaker genuinely saying a glossary
    // term at the top of a recording is common, because glossaries are built from what gets said.
    const result = stripPromptEcho('Naypyidaw responded within hours.', prompt);
    expect(result.strippedChars).toBe(0);
    expect(result.text).toBe('Naypyidaw responded within hours.');
  });

  it('does not fire on a substring appearing later in the text', () => {
    const result = stripPromptEcho(`The summit met. ${prompt}`, prompt);
    expect(result.strippedChars).toBe(0);
  });

  it('is a no-op with no prompt', () => {
    expect(stripPromptEcho('anything', '').strippedChars).toBe(0);
  });
});

describe('paramsHash — the Phase 5 caching contract', () => {
  const base = {
    providerId: 'openai' as const,
    model: 'whisper-1',
    languageCode: 'my',
    temperature: 0,
    responseFormat: 'verbose_json',
    granularities: ['word', 'segment'],
  };

  it('is stable across two identical requests', () => {
    expect(paramsHash(base)).toBe(paramsHash({ ...base }));
  });

  it('is insensitive to the order granularities were appended in', () => {
    expect(paramsHash(base)).toBe(paramsHash({ ...base, granularities: ['segment', 'word'] }));
  });

  it('moves when the prompt changes', () => {
    expect(paramsHash({ ...base, prompt: 'ASEAN' })).not.toBe(paramsHash(base));
    expect(paramsHash({ ...base, prompt: 'ASEAN' })).not.toBe(
      paramsHash({ ...base, prompt: 'ASEAN, Yangon' }),
    );
  });

  it('moves when the model or the language changes', () => {
    expect(paramsHash({ ...base, model: 'gpt-4o-transcribe' })).not.toBe(paramsHash(base));
    expect(paramsHash({ ...base, languageCode: 'en' })).not.toBe(paramsHash(base));
  });
});

describe('the language code sent to the wire', () => {
  it('comes from the matrix, not from string surgery on the registry code', () => {
    expect(whisperLanguageCode('my-MM', 'groq')).toBe('my');
    expect(whisperLanguageCode('en-US', 'openai')).toBe('en');
    // The three the probe recorded as exceptions. Splitting on '-' gets all of these wrong.
    expect(whisperLanguageCode('fil-PH', 'openai')).toBe('tl');
    expect(whisperLanguageCode('cmn-Hans-CN', 'openai')).toBe('zh');
    expect(whisperLanguageCode('nb-NO', 'openai')).toBe('no');
  });

  it('never sends a BCP-47 locale to a Whisper endpoint', () => {
    for (const code of Object.keys(PROVIDER_MATRIX)) {
      for (const provider of ['openai', 'groq'] as const) {
        if (!PROVIDER_MATRIX[code]?.[provider]) continue;
        expect(whisperLanguageCode(code, provider)).not.toMatch(/-/);
      }
    }
  });
});

describe('Groq autodetect is disabled, not discouraged', () => {
  it('refuses to send a request with no language', async () => {
    await expect(
      transcribeWhisperHttp(
        GROQ_TRANSPORT,
        { apiKey: 'k' },
        {
          audio: { path: '/nonexistent' },
          languageCode: 'my-MM',
          offsetMs: 0,
          durationMs: 1000,
          logger,
        },
        { providerCode: null, model: 'whisper-large-v3' },
      ),
    ).rejects.toThrow(/autodetect is disabled/i);
  });
});

describe('error mapping', () => {
  const context = { label: 'OpenAI', envVar: 'OPENAI_API_KEY' };
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers });

  it('maps a rejected language to UnsupportedLanguageError, keeping the provider’s sentence', async () => {
    const error = await toWhisperError(
      respond(400, {
        error: { message: "Language 'my' is not supported.", code: 'unsupported_language' },
      }),
      context,
    );
    expect(error).toBeInstanceOf(UnsupportedLanguageError);
    expect(error.message).toContain("Language 'my' is not supported.");
  });

  it('maps the verbose_json refusal to a plain ProviderError, not a language error', async () => {
    // It mentions a model but not a language: misclassifying it as UnsupportedLanguageError
    // would send someone to re-probe their language list over a response_format mistake.
    const error = await toWhisperError(
      respond(400, {
        error: {
          message: "response_format 'verbose_json' is not compatible with model 'gpt-4o-transcribe-api-ev3'.",
          code: 'unsupported_value',
        },
      }),
      context,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(UnsupportedLanguageError);
  });

  it('maps 429 to a retryable error honouring Retry-After', async () => {
    const error = await toWhisperError(
      respond(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '7' }),
      context,
    );
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterMs).toBe(7000);
  });

  it('maps 401 to a configuration error naming the env var', async () => {
    const error = await toWhisperError(respond(401, { error: { message: 'Bad key' } }), context);
    expect(error).toBeInstanceOf(NotConfiguredError);
    expect((error as NotConfiguredError).hint).toContain('OPENAI_API_KEY');
  });

  it('maps an oversized upload to the re-plannable error', async () => {
    const error = await toWhisperError(
      respond(400, { error: { message: 'Maximum content size limit (26214400) exceeded' } }),
      context,
    );
    expect(error).toBeInstanceOf(ChunkTooLargeError);
  });
});

describe('parseRetryAfter', () => {
  it('reads bare seconds', () => {
    expect(parseRetryAfter('7')).toBe(7000);
  });

  /** Groq sends Go-style durations rather than the bare seconds the RFC describes. */
  it('reads Groq’s duration strings', () => {
    expect(parseRetryAfter('7.66s')).toBe(7660);
    expect(parseRetryAfter('2m59.56s')).toBe(179_560);
    expect(parseRetryAfter('43.2s')).toBe(43_200);
  });

  it('is undefined when absent or unparseable', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('rate-limit headers', () => {
  /** Recorded from a live Groq response, 2026-08-11. Phase 9 sizes its bucket on these. */
  it('captures both of Groq’s buckets', () => {
    const snapshot = readRateLimitHeaders(
      new Headers({
        'x-ratelimit-limit-requests': '2000',
        'x-ratelimit-remaining-requests': '1997',
        'x-ratelimit-reset-requests': '2m9.6s',
        'x-ratelimit-limit-audio-seconds': '7200',
        'x-ratelimit-remaining-audio-seconds': '7190',
        'x-ratelimit-reset-audio-seconds': '5s',
      }),
    );
    expect(snapshot).toEqual({
      limitRequests: '2000',
      remainingRequests: '1997',
      resetRequests: '2m9.6s',
      limitAudioSeconds: '7200',
      remainingAudioSeconds: '7190',
      resetAudioSeconds: '5s',
    });
  });

  it('is null when a provider sends none', () => {
    expect(readRateLimitHeaders(new Headers())).toBeNull();
  });
});
