import { LANGUAGES } from '@thibi/languages';
import type { ProviderId } from '@thibi/languages';
import { ProbeAbort, parseRetryAfter, type ProbeOutcome, type ProbeProvider } from './types.js';

/**
 * Shared base for the OpenAI and Groq transcription endpoints, which take an identical
 * multipart request shape.
 *
 * Note what this measures and what it does not: whether the endpoint *accepts* a language
 * code. Groq accepts `my` and returns non-words — the finding this whole product's
 * "accepting a language code proves nothing" rule is built on — and no status code will
 * ever reveal that. Quality lives in data/matrix-overrides.json and, from Phase 5, in the
 * eval harness.
 */

/**
 * Registry code -> Whisper language code. The default is the ISO 639-1 tag, or the primary
 * subtag when there is no two-letter code. These are the ones where that is wrong.
 */
const CODE_EXCEPTIONS: Record<string, string> = {
  // Whisper has one Chinese, not a Simplified/Traditional split.
  'cmn-Hans-CN': 'zh',
  'cmn-Hant-TW': 'zh',
  'yue-Hant-HK': 'yue',
  // Whisper's tokenizer predates the rename to Filipino.
  'fil-PH': 'tl',
  'nb-NO': 'no',
};

export function whisperCode(code: string): string {
  const exception = CODE_EXCEPTIONS[code];
  if (exception) return exception;
  const entry = LANGUAGES[code];
  return entry?.iso639_1 ?? code.split('-')[0]!;
}

interface WhisperVerboseJson {
  text?: string;
  words?: unknown[];
  segments?: Array<{ words?: unknown[] }>;
  error?: { message?: string };
}

export interface WhisperProbeConfig {
  id: ProviderId;
  label: string;
  endpoint: string;
  apiKey: string | undefined;
  envVar: string;
  models: string[];
  defaultConcurrency: number;
  minIntervalMs?: number;
  /**
   * Models that cannot return `verbose_json`. `gpt-4o-transcribe` is one: it returns no
   * timestamps at all, which is why its capability is `wordTimestamps: false` rather than
   * an omission.
   */
  jsonOnlyModels?: string[];
}

export function createWhisperProbe(config: WhisperProbeConfig): ProbeProvider {
  const jsonOnly = new Set(config.jsonOnlyModels ?? []);

  return {
    id: config.id,
    models: config.models,
    defaultConcurrency: config.defaultConcurrency,
    ...(config.minIntervalMs ? { minIntervalMs: config.minIntervalMs } : {}),
    providerCode: whisperCode,

    async configure() {
      if (!config.apiKey) {
        throw new ProbeAbort(`${config.envVar} is not set — cannot probe ${config.label}.`);
      }
    },

    async probe({ code, model, clip }): Promise<ProbeOutcome> {
      const verbose = !jsonOnly.has(model);
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(clip)], { type: 'audio/flac' }), 'probe-2s.flac');
      form.set('model', model);
      form.set('language', whisperCode(code));
      form.set('response_format', verbose ? 'verbose_json' : 'json');
      if (verbose) {
        form.append('timestamp_granularities[]', 'word');
        form.append('timestamp_granularities[]', 'segment');
      }

      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
      });

      const body = (await response.json().catch(() => ({}))) as WhisperVerboseJson;
      const transcript = (body.text ?? '').trim();
      const words = [
        ...(body.words ?? []),
        ...(body.segments ?? []).flatMap((s) => s.words ?? []),
      ];

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      return {
        httpStatus: response.status,
        transcript,
        // A model that cannot return timestamps is a measured false, not an unknown.
        hasWords: !verbose ? false : transcript.length === 0 ? null : words.length > 0,
        ...(body.error?.message ? { errorMessage: body.error.message } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    },
  };
}

export function createOpenAiProbe(apiKey: string | undefined): ProbeProvider {
  return createWhisperProbe({
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    apiKey,
    envVar: 'OPENAI_API_KEY',
    // Both, because the "44 languages no OpenAI model will accept" figure is the union of
    // the two lists. whisper-1 accepts 57 codes and gpt-4o-transcribe 67; probing only one
    // would inflate the exclusive-to-Google count and the test would pass for the wrong
    // reason.
    models: ['whisper-1', 'gpt-4o-transcribe'],
    jsonOnlyModels: ['gpt-4o-transcribe'],
    defaultConcurrency: 2,
  });
}

export function createGroqProbe(apiKey: string | undefined): ProbeProvider {
  return createWhisperProbe({
    id: 'groq',
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    apiKey,
    envVar: 'GROQ_API_KEY',
    models: ['whisper-large-v3'],
    // Groq's on-demand tier allows 20 requests per minute for whisper-large-v3. Probing
    // faster than that turned 55 of 116 languages into `unknown` on the first attempt —
    // no data, just holes. One request every 3.2 s is ~18.7 rpm, comfortably under.
    defaultConcurrency: 1,
    minIntervalMs: 3200,
  });
}
