import { readFile } from 'node:fs/promises';
import type { RunMode } from '@thibi/core';
import { PROVIDER_MATRIX, type ProviderLanguageCapability } from '@thibi/languages';
import type { Clock } from '../../context.js';
import { AbortedError } from '../../errors.js';
import type {
  CostModel,
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from '../types.js';
import { createTokenCache, type TokenCache } from './auth.js';
import { DEFAULT_MODEL, googleCapabilities } from './capabilities.js';
import { toProviderError } from './errors.js';
import { parseRecognizeResponse, type RecognizeResponse } from './parse.js';

export interface GoogleConfig extends ProviderConfig {
  serviceAccountJson: string;
  projectId: string;
  /**
   * Any region works — this is a latency and data-residency choice, nothing more. The old
   * app's claim that Chirp 2 and Burmese only overlap in two regions is measured false.
   */
  region: string;
  model?: string;
}

/**
 * Endpoint helper, ported verbatim from `lib/providers/google.ts:89-94`.
 */
export function speechEndpoint(config: GoogleConfig, verb: string): string {
  return (
    `https://${config.region}-speech.googleapis.com/v2/projects/${config.projectId}` +
    `/locations/${config.region}/recognizers/_:${verb}`
  );
}

const REQUEST_TIMEOUT_MS = 120_000;

export interface GoogleProviderOptions {
  clock: Clock;
  tokenCache?: TokenCache;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createGoogleProvider(options: GoogleProviderOptions): TranscriptionProvider {
  const tokens = options.tokenCache ?? createTokenCache({ clock: options.clock });
  const doFetch = options.fetchImpl ?? fetch;

  return {
    id: 'google',
    label: 'Google Speech-to-Text v2',

    capabilities: googleCapabilities,

    supportsLanguage(code: string): ProviderLanguageCapability | null {
      // Data, not code. Adding a language is a probe run; adding a provider is one file
      // plus a column. This never becomes a switch statement over 117 codes.
      return PROVIDER_MATRIX[code]?.google ?? null;
    },

    resolveModel(code: string): string | null {
      const capability = PROVIDER_MATRIX[code]?.google;
      if (!capability?.supported) return null;
      // The `long`/`short` models are a documented Phase 6 hook for the
      // adaptation-if-S1-fails case, not built here.
      return DEFAULT_MODEL;
    },

    isConfigured(cfg: ProviderConfig): boolean {
      const config = cfg as GoogleConfig;
      return Boolean(config.serviceAccountJson && config.projectId && config.region);
    },

    costModel(_mode: RunMode): CostModel {
      return {
        usdPerMinute: 0.016,
        source: 'Google Cloud Speech-to-Text v2 list price, recorded 2026-08-09',
      };
    },

    async transcribe(cfg: ProviderConfig, req: TranscribeRequest): Promise<TranscribeResult> {
      const config = cfg as GoogleConfig;
      const capability = PROVIDER_MATRIX[req.languageCode]?.google;
      const providerCode = capability?.providerCode ?? req.languageCode;
      const model = req.model ?? config.model ?? DEFAULT_MODEL;

      const token = await tokens.get(config.serviceAccountJson);

      // An async read, not readFileSync (google.ts:175). A synchronous 10 MB read inside an
      // async function with eight chunks in flight blocks the event loop for all of them.
      const content = (await readFile(req.audio.path)).toString('base64');

      const capabilities = googleCapabilities(model);
      const body = {
        config: {
          autoDecodingConfig: {},
          // From the matrix, never a literal. `lib/queue.ts:118` hardcoded "my-MM".
          languageCodes: [providerCode],
          model,
          features: {
            enableWordTimeOffsets: true,
            enableWordConfidence: true,
            enableAutomaticPunctuation: true,
          },
          // Gated on the S1 verdict, not on optimism. For chirp_2 this is never sent:
          // adaptation is measured inert, and an irrelevant phrase set actively degrades
          // output. Phase 6's glossary would populate it for a provider where it works.
          ...(capabilities.adaptation === 'phrase-set' && req.adaptation
            ? {
                adaptation: {
                  phraseSets: [
                    {
                      inlinePhraseSet: {
                        phrases: req.adaptation.phrases,
                        ...(req.adaptation.boost !== undefined
                          ? { boost: req.adaptation.boost }
                          : {}),
                      },
                    },
                  ],
                },
              }
            : {}),
        },
        content,
      };

      // The old code had no timeout at all; a hung socket stalled the entire promise chain.
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await doFetch(speechEndpoint(config, 'recognize'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw new AbortedError();
        throw err;
      }

      if (!response.ok) throw await toProviderError(response);

      const parsed = (await response.json()) as RecognizeResponse;
      return parseRecognizeResponse(parsed, {
        offsetMs: req.offsetMs,
        durationMs: req.durationMs,
      });
    },
  };
}
