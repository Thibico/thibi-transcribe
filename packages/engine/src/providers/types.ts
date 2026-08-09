import type { RunMode, WordTimingQuality } from '@thibi/core';
import type { ProviderId, ProviderLanguageCapability } from '@thibi/languages';
import type { Logger } from '../context.js';

/**
 * The provider interface.
 *
 * Replaces `lib/providers/types.ts` wholesale. Four changes of substance: seconds become
 * integer milliseconds, words are first-class output rather than a source of segment
 * bounds, the single `transcribe` grows a submit/poll/fetch sibling for Phase 2, and every
 * capability is a *probed fact* rather than an assertion.
 */

export interface ProviderCapabilities {
  modes: RunMode[];
  wordTimestamps: boolean;
  wordConfidence: boolean;
  segmentConfidence: boolean;
  diarization: 'none' | 'native';
  adaptation: 'none' | 'phrase-set' | 'prompt';
  languageDetection: boolean;
  limits: {
    syncMaxBytes: number;
    syncMaxSeconds: number;
    maxConcurrentRequests: number;
    rpm: number;
  };
  staging: 'none' | 'gcs' | 's3';
}

export interface ProviderWord {
  startMs: number;
  endMs: number;
  text: string;
  /** null, never 0 — an unknown confidence must not sort as maximally uncertain. */
  confidence: number | null;
  speakerTag?: string | null;
  isEstimated?: boolean;
}

export interface ProviderSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  words: ProviderWord[];
}

export interface TranscribeResult {
  segments: ProviderSegment[];
  /** Computed from the response, never assumed. */
  wordTimingQuality: WordTimingQuality;
  usage: { audioMs: number; requests: number };
  /** The untouched provider response, archived to `runs/{id}/raw/{idx}.json`. */
  raw: unknown;
  /** Non-fatal oddities worth surfacing, e.g. a segment with no timing at all. */
  warnings: Array<{ code: string; message: string }>;
}

export interface TranscribeRequest {
  audio: { path: string };
  /** A registry code. The provider maps it through the matrix's `providerCode`. */
  languageCode: string;
  offsetMs: number;
  durationMs: number;
  model?: string;
  /**
   * Only sent when `capabilities().adaptation === 'phrase-set'`.
   *
   * For Google that is never: spike S1 measured that chirp_2 ignores phrase sets and that
   * an irrelevant one actively degrades output. Phase 6's glossary is what would populate
   * this for a provider where it works.
   */
  adaptation?: { phrases: Array<{ value: string; boost?: number }>; boost?: number };
  signal?: AbortSignal;
  logger: Logger;
}

/** Built by the pipeline from `ctx.settings` and handed in. Providers never read settings. */
export interface ProviderConfig {
  [key: string]: unknown;
}

export interface CostModel {
  usdPerMinute: number;
  /** Where the number came from, so an operator can check it. */
  source: string;
}

export interface TranscriptionProvider {
  readonly id: ProviderId;
  readonly label: string;
  capabilities(model?: string): ProviderCapabilities;
  supportsLanguage(code: string, model?: string): ProviderLanguageCapability | null;
  resolveModel(code: string, opts?: { requireWordTimestamps?: boolean }): string | null;
  isConfigured(cfg: ProviderConfig): boolean;
  costModel(mode: RunMode): CostModel;
  transcribe(cfg: ProviderConfig, req: TranscribeRequest): Promise<TranscribeResult>;

  // Phase 2. The submit/poll/fetch split is the load-bearing change from a single
  // `transcribeChunk`: a long async operation must never hold a worker slot.
  submitBatch?(cfg: ProviderConfig, req: unknown): Promise<unknown>;
  pollBatch?(cfg: ProviderConfig, op: unknown): Promise<unknown>;
  fetchBatchResult?(cfg: ProviderConfig, op: unknown, req: unknown): Promise<TranscribeResult>;
  cancelBatch?(cfg: ProviderConfig, op: unknown): Promise<void>;
}
