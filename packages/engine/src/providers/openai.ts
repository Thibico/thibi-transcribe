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
 * OpenAI audio transcription.
 *
 * A model table, a set of limits and a capability block over `whisper-http.ts`. There is no
 * HTTP in this file, by design: OpenAI and Groq speak an identical request shape, and the one
 * place that shape is written down is the transport.
 *
 * This provider exists to be **measured, not recommended**. The product thesis is that for
 * the 44-language set Whisper either refuses the code or mangles it, and Phase 5 cannot
 * demonstrate that without a code path to run.
 */

export interface OpenAiConfig extends WhisperHttpConfig {
  apiKey: string;
  model?: string;
  organization?: string;
}

export const OPENAI_TRANSPORT: WhisperTransport = {
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  envVar: 'OPENAI_API_KEY',
  // Confirmed on the speech-to-text guide, 2026-08-11: "The timestamp_granularities[]
  // parameter is only supported for whisper-1." The gpt-4o transcribe models return no
  // timestamps at all, which is a measured capability and not an omission.
  jsonOnlyModels: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
  allowAutodetect: true,
};

export const DEFAULT_MODEL = 'whisper-1';
export const TIMESTAMPED_MODEL = 'whisper-1';

/**
 * 25 MB, from the speech-to-text guide, read 2026-08-11: "Files can be up to 25 MB."
 */
export const SYNC_MAX_BYTES = 25 * 1024 * 1024;

/**
 * **600 s, and this number is a decision rather than an inheritance.**
 *
 * The Phase 4 plan asserted 25 MB at ~110 KB/s ≈ 230 s, so "the byte budget binds long
 * before the duration". That constant was measured wrong by about 6× on 2026-08-10 — the
 * `norm_16k_mono_flac` recipe had been emitting 192 kHz because `loudnorm` resamples
 * internally and the `aresample=16000` in front of it was silently discarded. The real
 * figure for 16 kHz mono FLAC is **18.9 KB/s**, at which 25 MB is about 1320 s. So the byte
 * cap does *not* bind first, the duration is now free to be chosen, and it is chosen here:
 *
 * - **A lost chunk costs 10 minutes of re-work, not 22.** One 300 s timeout on a 1320 s
 *   chunk throws away the most expensive unit of work in the pipeline.
 * - **Parallelism is only real if there are chunks to run in parallel.** At 600 s, an hour
 *   of audio is 6 chunks across 4 concurrent requests. At 1320 s it is 3, and the slowest
 *   one sets the wall clock.
 * - **Seams are cheap but not free** — 2–3 words at each hard cut before the LCS de-dup
 *   recovers them — so 6 seams an hour is a cost worth paying and 60 would not be.
 * - **The byte cap stays a backstop.** 600 s at twice the measured density is 22.7 MB, still
 *   inside 25 MB, and `durationBudgetMs` derives the real budget from the actual file anyway.
 *   That mechanism is why the wrong constant never produced a wrong request.
 *
 * Re-measure the 18.9 KB/s across the Phase 5 eval corpus before treating it as settled: it
 * is one clip of Burmese news speech, and FLAC is content-dependent.
 */
export const SYNC_MAX_SECONDS = 600;

/**
 * Language coverage, from the 116-code probe on 2026-08-09 — **the probe's numbers, not the
 * documentation's**. 72 of 116 registry codes are accepted by at least one OpenAI model: 65
 * on `whisper-1` and 7 more only on `gpt-4o-transcribe`.
 *
 * Those 7 are the trap this provider is most likely to be blamed for:
 * `bn-BD bn-IN gu-IN ka-GE ml-IN te-IN yue-Hant-HK` are supported by OpenAI and cannot
 * return a timestamp, because the only model that accepts them is the one with no
 * `verbose_json`. `resolveModel` returns null for them under `requireWordTimestamps`, and
 * `resolveModelWithReason` exists so the CLI never prints that null as
 * "OpenAI doesn't do Bengali".
 */
export const GPT4O_ONLY_CODES: readonly string[] = [
  'bn-BD',
  'bn-IN',
  'gu-IN',
  'ka-GE',
  'ml-IN',
  'te-IN',
  'yue-Hant-HK',
];

/**
 * $0.006 per minute for `whisper-1` and `gpt-4o-transcribe`; $0.003 for
 * `gpt-4o-mini-transcribe`. Read from the OpenAI API pricing page, 2026-08-11.
 *
 * Provenance, not the operative number: costing reads the `rates` table so an admin can
 * correct a price without a deploy. These same figures seed it.
 */
export const USD_PER_MINUTE: Record<string, number> = {
  'whisper-1': 0.006,
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
};

export function openAiCapabilities(model: string = DEFAULT_MODEL): ProviderCapabilities {
  const timestamped = model === TIMESTAMPED_MODEL;
  return {
    // No batch surface. OpenAI has no long-running transcription operation to submit to, so
    // declaring one would make `planMode` offer a mode that cannot exist.
    modes: ['sync', 'sync_chunked'],
    wordTimestamps: timestamped,
    /**
     * **Deliberate, and the most important false in this file.**
     *
     * The only confidence in the response is `avg_logprob`, a length-normalised model
     * likelihood at segment level: roughly monotone with quality, entirely uncalibrated. It
     * is fine for sorting segments by suspicion and useless as a probability, so it is never
     * divided down onto words. The consequence has to be visible in the product and not just
     * in this type — the low-confidence dotted underline reads `words.confidence`, so for an
     * OpenAI run it simply does not appear, and the toolbar says "per-word confidence is not
     * available from this provider" rather than showing a count of zero.
     */
    wordConfidence: false,
    segmentConfidence: timestamped,
    diarization: 'none',
    adaptation: 'prompt',
    languageDetection: true,
    limits: {
      syncMaxBytes: SYNC_MAX_BYTES,
      syncMaxSeconds: SYNC_MAX_SECONDS,
      // Four, not eight. Google's 8 was measured safe by spike S3 against Google's quota;
      // nothing has measured OpenAI's, and the shared outbound token bucket that would make
      // a higher number safe across processes is Phase 9.
      maxConcurrentRequests: 4,
      // 5000/minute, **read off a live response** on 2026-08-11 rather than guessed:
      // `x-ratelimit-limit-requests: 5000` with `x-ratelimit-reset-requests: 12ms`, and
      // 60000/5000 = 12 ms is what makes it per-minute rather than per-day. Tier-dependent,
      // so it is this account's number and not a universal one — which is exactly why the
      // adapter records the headers on every response instead of trusting this constant.
      rpm: 5000,
    },
    staging: 'none',
  };
}

export interface ResolvedModel {
  model: string | null;
  /** Always populated, always printable. A silent provider choice is a support ticket. */
  reason: string;
}

/**
 * Which model to use, and why — the `why` is the point.
 *
 * A bare `null` from a model resolver is how "Bengali is `gpt-4o-transcribe`-only and that
 * model returns no timestamps" gets misdiagnosed as "OpenAI doesn't do Bengali".
 */
export function resolveModelWithReason(
  code: string,
  opts: { requireWordTimestamps?: boolean } = {},
): ResolvedModel {
  const capability = PROVIDER_MATRIX[code]?.openai;
  if (!capability?.supported) {
    return {
      model: null,
      reason:
        capability?.status === 'rejected'
          ? `OpenAI rejects ${code}: ${capability.errorMessage ?? 'the code is not accepted'} (probed ${capability.probedAt}).`
          : `OpenAI is not recorded as supporting ${code}.`,
    };
  }

  const models = capability.models ?? [];
  const hasTimestamped = models.includes(TIMESTAMPED_MODEL);

  if (opts.requireWordTimestamps) {
    if (hasTimestamped) {
      return { model: TIMESTAMPED_MODEL, reason: `whisper-1 is OpenAI's only timestamped model.` };
    }
    return {
      model: null,
      reason:
        `OpenAI supports ${code} only on ${models[0] ?? 'gpt-4o-transcribe'}, which returns ` +
        `no timestamps. Use --no-word-timestamps, or pick another provider.`,
    };
  }

  if (hasTimestamped) {
    return { model: TIMESTAMPED_MODEL, reason: `whisper-1 accepts ${code} and returns timestamps.` };
  }
  return {
    model: models[0] ?? 'gpt-4o-transcribe',
    reason: `${models[0] ?? 'gpt-4o-transcribe'} is the only OpenAI model that accepts ${code}; it returns no timestamps.`,
  };
}

export interface OpenAiProviderOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Glossary conditioning, already built by `buildWhisperPrompt`. */
  prompt?: string;
}

export function createOpenAiProvider(options: OpenAiProviderOptions = {}): TranscriptionProvider {
  return {
    id: 'openai',
    label: 'OpenAI Whisper',

    capabilities: openAiCapabilities,

    supportsLanguage(code: string): ProviderLanguageCapability | null {
      return PROVIDER_MATRIX[code]?.openai ?? null;
    },

    resolveModel(code: string, opts): string | null {
      return resolveModelWithReason(code, opts ?? {}).model;
    },

    isConfigured(cfg: ProviderConfig): boolean {
      return Boolean((cfg as OpenAiConfig).apiKey);
    },

    costModel(_mode: RunMode): CostModel {
      return {
        usdPerMinute: USD_PER_MINUTE[DEFAULT_MODEL]!,
        source: 'OpenAI API pricing, transcription models, read 2026-08-11',
      };
    },

    async transcribe(cfg: ProviderConfig, req: TranscribeRequest): Promise<TranscribeResult> {
      const config = cfg as OpenAiConfig;
      const model = req.model ?? config.model ?? DEFAULT_MODEL;
      return transcribeWhisperHttp(OPENAI_TRANSPORT, config, req, {
        providerCode: whisperLanguageCode(req.languageCode, 'openai'),
        model,
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    },
  };
}
