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
import {
  cancelBatch,
  fetchBatchResult,
  findOrphanOperation,
  pollBatch,
  submitBatch,
  type BatchDeps,
  type BatchOp,
  type BatchRequest,
  type BatchStatus,
} from './batch.js';
import { DEFAULT_MODEL, googleCapabilities } from './capabilities.js';
import { recognizeUrl } from './endpoints.js';
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
 *
 * Phase 2 moved the URL construction into `endpoints.ts`, which grew the batch and operation
 * URLs it never needed. This stays as a thin wrapper: it is part of the package's published
 * API and its call sites are fine.
 */
export function speechEndpoint(config: GoogleConfig, verb: string): string {
  if (verb === 'recognize') return recognizeUrl(config.region, config.projectId);
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
  /** Cancellation for the batch surface, whose calls outlive a single request. */
  signal?: AbortSignal;
}

export function createGoogleProvider(options: GoogleProviderOptions): TranscriptionProvider {
  const tokens = options.tokenCache ?? createTokenCache({ clock: options.clock });
  const doFetch = options.fetchImpl ?? fetch;

  /**
   * The batch functions take their dependencies explicitly rather than closing over the
   * provider, so they stay callable from a test with a fake clock and a recorded fetch —
   * and, in Phase 9, from a worker that rebuilt the config out of the database.
   */
  const batchDeps = (cfg: ProviderConfig, opts: { cancellable?: boolean } = {}): BatchDeps => {
    const config = cfg as GoogleConfig;
    const cancellable = opts.cancellable ?? true;
    return {
      region: config.region,
      projectId: config.projectId,
      getToken: () => tokens.get(config.serviceAccountJson),
      fetchImpl: doFetch,
      clock: options.clock,
      ...(cancellable && options.signal ? { signal: options.signal } : {}),
    };
  };

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

    // ---- batch ------------------------------------------------------------------------
    // Thin by design. Everything of substance is in `batch.ts` as free functions taking
    // explicit dependencies, because Phase 9 calls them from a worker that has a `BatchOp`
    // and a config and no provider instance in scope.

    submitBatch(cfg, req) {
      return submitBatch(batchDeps(cfg), req);
    },

    pollBatch(cfg, op) {
      return pollBatch(batchDeps(cfg), op);
    },

    fetchBatchResult(cfg, op, args) {
      return fetchBatchResult(batchDeps(cfg), op, args);
    },

    cancelBatch(cfg, op) {
      // Deliberately not cancellable: a cancel triggered by SIGINT must not itself be
      // aborted by the same signal it is responding to, or the operation stays running and
      // keeps billing.
      return cancelBatch(batchDeps(cfg, { cancellable: false }), op);
    },
  };
}

export { findOrphanOperation };
export type { BatchDeps, BatchOp, BatchRequest, BatchStatus };
