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

/**
 * A submitted long-running operation, as **plain JSON**.
 *
 * No clients, no closures, no timers, no `AbortController`. This is the single constraint
 * that lets Phase 9 replace Phase 2's in-process poll loop with a self-rescheduling
 * `run_steps` row without touching a provider: a worker that never saw the submit rehydrates
 * this from the database and polls. `region` and `inputUri` are stored fields rather than
 * values recomputed from config for exactly that reason. A test round-trips it through
 * `JSON.parse(JSON.stringify(op))` and polls with the result.
 */
export interface BatchOp {
  provider: ProviderId;
  /** The provider's regional host, needed to rebuild the poll URL after a restart. */
  region: string;
  /** The operation's resource name — the thing that must not be lost. */
  name: string;
  /** Identifies our file in the operation's result map. */
  inputUri: string;
  outputPrefix: string;
  submittedAtMs: number;
  /** False when the cheaper processing strategy was rejected and we submitted without it. */
  dynamicBatching: boolean;
}

export interface BatchRequest {
  runId: string;
  /** A staged URI. The engine put it there; the provider never touches the bucket. */
  audioUri: string;
  outputUri: string;
  /** Already mapped through the matrix by the caller. */
  languageCode: string;
  model: string;
  durationMs: number;
  /** Only sent when `capabilities().adaptation === 'phrase-set'`. Never for Google (S1). */
  phraseSet?: { phrases: Array<{ value: string; boost?: number }>; boost?: number };
}

export type BatchState = 'running' | 'succeeded' | 'failed';

export interface BatchStatus {
  state: BatchState;
  /** Only when the provider actually sent one. Never fabricated. */
  progressPercent?: number;
  outputUri?: string;
  totalBilledDuration?: string;
  /**
   * `scope` matters: an operation-level failure and a per-file failure inside a *successful*
   * operation are different events, and spike S3 measured the second one at 1 run in 5.
   */
  error?: { code?: number; message: string; scope: 'operation' | 'file' };
  retryable?: boolean;
  doneAtMs?: number;
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

  // The submit/poll/fetch split is the load-bearing change from a single `transcribeChunk`:
  // a long async operation must never hold a worker slot. Optional because a provider
  // without a batch surface is a normal provider, not a broken one.
  submitBatch?(cfg: ProviderConfig, req: BatchRequest): Promise<BatchOp>;
  pollBatch?(cfg: ProviderConfig, op: BatchOp): Promise<BatchStatus>;
  fetchBatchResult?(
    cfg: ProviderConfig,
    op: BatchOp,
    args: FetchBatchArgs,
  ): Promise<TranscribeResult>;
  cancelBatch?(cfg: ProviderConfig, op: BatchOp): Promise<void>;
}

/**
 * What `fetchBatchResult` needs beyond the operation.
 *
 * `read` and `list` are the staging port's methods, handed in rather than imported. That is
 * what stops a provider from ever learning what GCS is, and it is why the fetch path is
 * testable against a recorded fixture with no network at all.
 */
export interface FetchBatchArgs {
  status: BatchStatus;
  durationMs: number;
  read: <T = unknown>(uri: string, opts?: { maxBytes?: number }) => Promise<T>;
  list: (prefix: string) => Promise<Array<{ key: string; uri: string; bytes: number }>>;
}
