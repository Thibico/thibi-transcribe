import type { RunMode } from '@thibi/core';
import { PROVIDER_MATRIX, type ProviderLanguageCapability } from '@thibi/languages';
import type {
  CostModel,
  ProviderCapabilities,
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from './types.js';
import {
  transcribeWhisperHttp,
  type WhisperHttpConfig,
  type WhisperTransport,
} from './whisper-http.js';
import { whisperLanguageCode } from './whisper/language.js';

/**
 * Groq Whisper.
 *
 * The same transport as OpenAI with a different base URL, and one behavioural difference
 * that is not a setting: **autodetect is disabled outright**.
 *
 * On a 12-second Burmese clip, 2026-07-30, all three of these returned HTTP 200:
 *
 * | call                | output                                              |
 * |---------------------|-----------------------------------------------------|
 * | Google `chirp_2`    | `အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက် ကို…` — correct              |
 * | Groq, `language=my` | `လာက္းကေက် ရိုရ်းသဲ့ထါတ်…` — Myanmar-script non-words |
 * | Groq, autodetect    | `ASEAN YAK SOMPHA CHHA KOO…` — romanised             |
 *
 * **Re-measured 2026-08-11 on the committed 2 s Burmese probe clip, and it is worse than the
 * original finding, not better:**
 *
 * | call                | output                                  | script |
 * |---------------------|-----------------------------------------|--------|
 * | Groq, `language=my` | `ប្យទៅទៅក្ម។ ផ្្ទៅក៏់។`                    | Khmer  |
 * | Groq, autodetect    | `Cô Nga dễ cô giáp cho khỏe mặt bê bồ.` | Latin, and it reports `language: Vietnamese` |
 *
 * HTTP 200, `avg_logprob` −0.55, `no_speech_prob` 0.05 — every number in the response says
 * this is a confident transcription. Two clips, two dates, three distinct failure modes
 * (Myanmar non-words, Khmer, Vietnamese), and not one of them detectable from the envelope.
 * The fixtures are recorded in `whisper/__fixtures__/`.
 *
 * That third row is what `allowAutodetect: false` is for. The second is why `my-MM` is
 * `supported: false, verdict: measured-failure` in `matrix-overrides.json` — **accepting a
 * language code is not support**, and no status code will ever reveal the difference.
 */

export interface GroqConfig extends WhisperHttpConfig {
  apiKey: string;
  model?: string;
}

export const GROQ_TRANSPORT: WhisperTransport = {
  id: 'groq',
  label: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  envVar: 'GROQ_API_KEY',
  // Every Groq speech model returns verbose_json.
  jsonOnlyModels: [],
  allowAutodetect: false,
};

export const DEFAULT_MODEL = 'whisper-large-v3';

/**
 * The model list, from the GroqCloud model docs read 2026-08-11.
 *
 * `distil-whisper-large-v3-en` is no longer listed there and is deliberately not carried
 * forward from the Phase 4 plan's table — an English-only distillation is of no use to a
 * product built for 44 non-English languages, and listing a model we cannot confirm exists
 * would be exactly the documentation-over-measurement habit this project is built against.
 */
export const MODELS: readonly string[] = ['whisper-large-v3', 'whisper-large-v3-turbo'];

/**
 * $0.111/hour for `whisper-large-v3`, $0.04/hour for the turbo variant — GroqCloud model
 * docs, read 2026-08-11. Divided to per-minute here rather than stored rounded, because
 * $0.111/60 is not a two-decimal number and rounding it makes a two-hour bill wrong.
 */
export const USD_PER_MINUTE: Record<string, number> = {
  'whisper-large-v3': 0.111 / 60,
  'whisper-large-v3-turbo': 0.04 / 60,
};

/**
 * 25 MB on the free tier, 100 MB on the dev tier — GroqCloud speech-to-text docs, 2026-08-11.
 *
 * The Phase 4 plan recorded the same split, and it is a **setting rather than a constant**
 * because getting it wrong in the generous direction means every request over 25 MB fails.
 * Default to the pessimistic one: a free-tier key that assumed 100 MB fails on every chunk,
 * while a dev-tier key that assumed 25 MB merely sends more chunks than it needed to.
 */
export const SYNC_MAX_BYTES_FREE = 25 * 1024 * 1024;
export const SYNC_MAX_BYTES_DEV = 100 * 1024 * 1024;

/** Same reasoning as OpenAI's — see the long note on `SYNC_MAX_SECONDS` in `openai.ts`. */
export const SYNC_MAX_SECONDS = 600;

/**
 * Groq's real limits are **a daily request bucket and an hourly audio-seconds bucket**, and
 * neither of them is an rpm.
 *
 * Read off live response headers on 2026-08-11, on the key this project uses:
 *
 * ```
 * x-ratelimit-limit-requests: 2000        x-ratelimit-reset-requests: 43.2s
 * x-ratelimit-limit-audio-seconds: 7200   x-ratelimit-reset-audio-seconds: 1s
 * ```
 *
 * 43.2 s of reset per request is 86400/2000 — a leaky bucket refilling to **2000 requests a
 * day**, not per minute. The audio budget is **7200 seconds an hour**: two hours of audio per
 * hour of wall clock, which is the constraint that will actually bite a Phase 5 sweep. At
 * 600 s chunks the daily request cap is 333 hours of audio, so requests never bind first.
 *
 * All three numbers contradict something. GroqCloud's model docs list 300 RPM and 200,000
 * audio-seconds/hour (read the same day) — a different tier. The 2026-08-09 probe measured
 * that going faster than ~20 rpm turned 55 of 116 languages into `unknown`, which is neither
 * of the header limits and is probably concurrency or a burst rule.
 *
 * `rpm` keeps the probe's 20, because it is the only one of the four figures measured *safe
 * in practice* rather than merely stated. The other two are recorded below so Phase 9's token
 * bucket is designed against the shape Groq actually rate-limits on, which `rpm` cannot
 * express.
 */
export const RPM_MEASURED = 20;
export const REQUESTS_PER_DAY_MEASURED = 2000;
export const AUDIO_SECONDS_PER_HOUR_MEASURED = 7200;

export interface GroqCapabilityOptions {
  /** Dev-tier keys raise the request cap to 100 MB. */
  syncMaxBytes?: number;
}

export function groqCapabilities(
  _model: string = DEFAULT_MODEL,
  options: GroqCapabilityOptions = {},
): ProviderCapabilities {
  return {
    modes: ['sync', 'sync_chunked'],
    wordTimestamps: true,
    // Same as OpenAI, for the same reason: `avg_logprob` is a segment-level likelihood and
    // there is no per-word number in the response to carry. See `openai.ts`.
    wordConfidence: false,
    segmentConfidence: true,
    diarization: 'none',
    adaptation: 'prompt',
    // The API will happily detect a language. We will not ask it to — see the file header.
    languageDetection: false,
    limits: {
      syncMaxBytes: options.syncMaxBytes ?? SYNC_MAX_BYTES_FREE,
      syncMaxSeconds: SYNC_MAX_SECONDS,
      maxConcurrentRequests: 2,
      rpm: RPM_MEASURED,
    },
    staging: 'none',
  };
}

export interface GroqProviderOptions {
  fetchImpl?: typeof fetch;
  prompt?: string;
  /** Dev-tier keys raise the request cap to 100 MB. */
  syncMaxBytes?: number;
}

export function createGroqProvider(options: GroqProviderOptions = {}): TranscriptionProvider {
  return {
    id: 'groq',
    label: 'Groq Whisper',

    capabilities: (model) =>
      groqCapabilities(
        model,
        options.syncMaxBytes !== undefined ? { syncMaxBytes: options.syncMaxBytes } : {},
      ),

    supportsLanguage(code: string): ProviderLanguageCapability | null {
      return PROVIDER_MATRIX[code]?.groq ?? null;
    },

    /**
     * `null` for a language the matrix marks unsupported — **including `my-MM`, which the API
     * accepts.** That gap between `status: 'accepted'` and `supported: false` is the whole
     * point of the matrix carrying both, and `--force-unsupported` is how a user reproduces
     * the failure on purpose.
     */
    resolveModel(code: string): string | null {
      const capability = PROVIDER_MATRIX[code]?.groq;
      if (!capability?.supported) return null;
      return DEFAULT_MODEL;
    },

    isConfigured(cfg: ProviderConfig): boolean {
      return Boolean((cfg as GroqConfig).apiKey);
    },

    costModel(_mode: RunMode): CostModel {
      return {
        usdPerMinute: USD_PER_MINUTE[DEFAULT_MODEL]!,
        source: 'GroqCloud model docs, $0.111 per hour of audio, read 2026-08-11',
      };
    },

    async transcribe(cfg: ProviderConfig, req: TranscribeRequest): Promise<TranscribeResult> {
      const config = cfg as GroqConfig;
      const model = req.model ?? config.model ?? DEFAULT_MODEL;
      return transcribeWhisperHttp(GROQ_TRANSPORT, config, req, {
        providerCode: whisperLanguageCode(req.languageCode, 'groq'),
        model,
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    },
  };
}
