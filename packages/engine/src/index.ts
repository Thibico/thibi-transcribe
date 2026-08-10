// @thibi/engine — providers, audio, pipeline, text normalization.
//
// Every stage is `(ctx, input) => Promise<output>`. No stage constructs a client, opens a
// file by convention, or reads ambient configuration: everything arrives through the
// EngineContext its caller built. An ESLint rule and a CI grep enforce that, and the
// concrete payoff is that `google/auth.ts` cannot read GOOGLE_APPLICATION_CREDENTIALS —
// which is what makes the provider testable without a filesystem and configurable from a
// browser in Phase 10.

export {
  assertContext,
  MissingCapabilityError,
  type Clock,
  type ConcurrencyLimits,
  type EngineContext,
  type EventSink,
  type FfmpegPort,
  type Logger,
  type RunEvent,
  type SettingsPort,
  type StagingStore,
  type TempDirPort,
} from './context.js';

export {
  AbortedError,
  ChunkTooLargeError,
  EngineError,
  FfmpegError,
  NotConfiguredError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  StagingRefusedError,
  UnsupportedLanguageError,
  UnsupportedMediaError,
  isReplannable,
  isRetryable,
} from './errors.js';

// ---- staging: the bucket batchRecognize reads from -------------------------------------
export {
  DEFAULT_MAX_JSON_BYTES,
  STAGING_ROOT,
  parseGsUri,
  stagingPrefixFor,
  type BucketInfo,
  type LifecycleCheck,
  type StagingBody,
  type StagingLocation,
  type StagingObject,
} from './staging/types.js';
export {
  BucketMetadataDenied,
  createGcsStaging,
  STAGING_SCOPES,
  type GcsStagingOptions,
} from './staging/gcs.js';
export { FakeStagingStore, type FakeStagingOptions } from './staging/memory.js';
export {
  assertLifecycle,
  fixCommand,
  iamFixCommand,
  MAX_AGE_DAYS,
  PREFERRED_AGE_DAYS,
  type RawLifecycle,
} from './staging/lifecycle.js';
export {
  ensureStageable,
  validateStagingBucket,
  type CheckId,
  type CheckResult,
  type ValidateOptions,
  type ValidationReport,
} from './staging/validate.js';

export {
  fullJitterDelay,
  systemClock,
  withRetry,
  RETRY_POLICIES,
  type RetryKind,
  type RetryOptions,
  type RetryPolicy,
} from './retry.js';

export { createFfmpegPort, type FfmpegPaths } from './audio/ffmpeg.js';
export { probe, type ProbeResult, type ProbeStream } from './audio/probe.js';
export { detectSilences } from './audio/silences.js';
export {
  durationBudgetMs,
  planBoundaries,
  planChunks,
  type ChunkPlan,
  type PlanOptions,
} from './audio/plan.js';
export { cutChunk, cutChunks } from './audio/cut.js';
export {
  ensureNormalized,
  normalizeUncached,
  type NormalizedDerivative,
} from './audio/derivative.js';
export {
  NORMALIZE,
  PEAK_BUCKETS_PER_SECOND,
  RECIPE_VERSION,
  reducePeaks,
  runNormalize,
  type NormalizeOutput,
} from './audio/normalize.js';

export {
  applySeam,
  mergeSeam,
  mergeSeamNoWords,
  DEFAULT_MIN_SCORE,
  DEFAULT_SLACK_MS,
  GREY_ZONE_MAX,
  type SeamInput,
  type SeamMethod,
  type SeamResult,
} from './audio/merge/seam.js';
export { diceScore, lcsPairs, type AlignedPair } from './audio/merge/lcs.js';
export { normalizeToken, tokenize, tokenizeText } from './audio/merge/tokenize.js';

export {
  detectZawgyi,
  joinWords,
  normalizeSegment,
  normalizeSegments,
  zawgyiToUnicode,
} from './text/normalize.js';

export {
  createMemorySettings,
  createSettings,
  isMasked,
  MASK,
  SETTING_KEYS,
  type CreateSettingsOptions,
} from './settings.js';

export type {
  BatchOp,
  BatchRequest,
  BatchState,
  BatchStatus,
  CostModel,
  FetchBatchArgs,
  ProviderCapabilities,
  ProviderConfig,
  ProviderSegment,
  ProviderWord,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from './providers/types.js';

export { createGoogleProvider, speechEndpoint, type GoogleConfig } from './providers/google/index.js';
export {
  createTokenCache,
  projectIdFrom,
  type TokenCache,
} from './providers/google/auth.js';
export {
  googleCapabilities,
  DEFAULT_MODEL,
  S1_ADAPTATION,
  S2_WORD_CONFIDENCE,
} from './providers/google/capabilities.js';
export {
  parseOffsetMs,
  parseRecognizeResponse,
  parseRecognizeResults,
  type BatchRecognizeResults,
  type RecognizeResponse,
} from './providers/google/parse.js';
export { toProviderError } from './providers/google/errors.js';
export {
  batchRecognizeUrl,
  cancelOperationUrl,
  listOperationsUrl,
  operationUrl,
  recognizeUrl,
  regionOfOperation,
} from './providers/google/endpoints.js';
export {
  buildBatchBody,
  cancelBatch,
  classifyOperation,
  fetchBatchResult,
  findOrphanOperation,
  pollBatch,
  submitBatch,
  type BatchDeps,
} from './providers/google/batch.js';

export {
  runAsr,
  stitch,
  type AsrInput,
  type AsrOutput,
  type ChunkOutcome,
  type SeamRecord,
} from './pipeline/asr.js';
export {
  createRun,
  persistChunks,
  persistResult,
  type CreateRunInput,
  type CreateRunResult,
  type PersistResultInput,
} from './pipeline/persist.js';
export {
  transcribe,
  storeNormalized,
  DEFAULT_OVERLAP_MS,
  type TranscribeInput,
  type TranscribeOutput,
} from './pipeline/transcribe.js';
export {
  ModeUnavailableError,
  planMode,
  type PlanDecision,
  type PlanInput,
  type PlanWarning,
} from './pipeline/plan.js';
export {
  BatchFailedError,
  POLL_MAX_MS,
  POLL_START_MS,
  pollToCompletion,
  runBatch,
  type BatchRunInput,
  type BatchRunOutput,
} from './pipeline/batch-run.js';
export {
  claimStagingPrefix,
  clearStagingPrefix,
  isCancelRequested,
  loadOperation,
  parseBilledSeconds,
  persistOperation,
  recordBatchProgress,
  recordUsage,
  requestCancel,
  type BatchPipelineRecord,
  type UsageInput,
  type UsageWritten,
} from './pipeline/batch-persist.js';
export {
  DEFAULT_LOOKBACK_MS,
  resumeBatchRun,
  type ResumeOptions,
  type ResumeOutcome,
} from './pipeline/operation-reconcile.js';
export {
  ALLOWED_EXTENSIONS,
  allowedExtension,
  createOrReuseAsset,
  findAssetBySha,
  IngestError,
  ingestStream,
  validateFilename,
  type CreateOrReuseResult,
  type IngestedAsset,
  type IngestErrorCode,
  type IngestStreamInput,
  type NewAsset,
  type StoredAsset,
} from './ingest/index.js';
