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
  NonRetryableError,
  NotConfiguredError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  StagingRefusedError,
  UnsupportedLanguageError,
  UnsupportedMediaError,
  USER_FACING,
  isReplannable,
  isRetryable,
  isUserFacing,
  type UserFacing,
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
  normalizedKeyFor,
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

// ---- LLM prompts: the text the eval harness measures and Phase 6 will send ---------------
export {
  buildCleanupPrompt,
  buildTranslatePrompt,
  casingRule,
  marksLine,
  promptVars,
  renderSegments,
  spacingRule,
  UnknownLanguageError,
  CLEANUP_CURRENT,
  CLEANUP_RESTRAINT,
  CLEANUP_VERSIONS,
  TRANSLATE_DEFAULT,
  TRANSLATE_VERSION,
  type BuildCleanupInput,
  type BuildTranslateInput,
  type CleanupVariant,
  type LlmPrompt,
  type PromptLanguageVars,
  type PromptSegment,
} from './llm/index.js';

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

// ---- the Whisper HTTP providers: one transport, two configuration modules ---------------
export {
  paramsHash,
  transcribeWhisperHttp,
  REQUEST_TIMEOUT_MS as WHISPER_REQUEST_TIMEOUT_MS,
  type WhisperCall,
  type WhisperHttpConfig,
  type WhisperTransport,
} from './providers/whisper-http.js';
export {
  createOpenAiProvider,
  openAiCapabilities,
  resolveModelWithReason,
  DEFAULT_MODEL as OPENAI_DEFAULT_MODEL,
  GPT4O_ONLY_CODES,
  OPENAI_TRANSPORT,
  SYNC_MAX_SECONDS as WHISPER_SYNC_MAX_SECONDS,
  TIMESTAMPED_MODEL as OPENAI_TIMESTAMPED_MODEL,
  USD_PER_MINUTE as OPENAI_USD_PER_MINUTE,
  type OpenAiConfig,
  type ResolvedModel,
} from './providers/openai.js';
export {
  createGroqProvider,
  groqCapabilities,
  DEFAULT_MODEL as GROQ_DEFAULT_MODEL,
  GROQ_TRANSPORT,
  MODELS as GROQ_MODELS,
  RPM_MEASURED as GROQ_RPM_MEASURED,
  SYNC_MAX_BYTES_DEV as GROQ_SYNC_MAX_BYTES_DEV,
  SYNC_MAX_BYTES_FREE as GROQ_SYNC_MAX_BYTES_FREE,
  USD_PER_MINUTE as GROQ_USD_PER_MINUTE,
  type GroqConfig,
} from './providers/groq.js';
export {
  createFasterWhisperProvider,
  fasterWhisperCapabilities,
  resolveFasterWhisperModel,
  SidecarBusyError,
  DEFAULT_MODEL as FASTER_WHISPER_DEFAULT_MODEL,
  DEFAULT_ENGLISH_MODEL as FASTER_WHISPER_ENGLISH_MODEL,
  PREFER_SPEED_MODEL as FASTER_WHISPER_SPEED_MODEL,
  MODELS as FASTER_WHISPER_MODELS,
  type FasterWhisperConfig,
  type StagedAudio,
} from './providers/faster-whisper.js';
export {
  attachWords,
  DEFAULT_EPS_MS,
  type AttachResult,
  type TimedSegment,
  type TimedWord,
} from './providers/whisper/attach-words.js';
export {
  buildWhisperPrompt,
  stripPromptEcho,
  MAX_EST_TOKENS,
  MIN_ECHO_CHARS,
  type BuiltPrompt,
  type PromptTerm,
} from './providers/whisper/prompt.js';
export {
  parseWhisperResponse,
  parseWhisperResults,
  segmentConfidence,
  HALLUCINATION_WARN_FRACTION,
  NO_SPEECH_THRESHOLD,
  type WhisperVerboseJson,
} from './providers/whisper/parse.js';
export {
  readRateLimitHeaders,
  toWhisperError,
  type RateLimitSnapshot,
} from './providers/whisper/errors.js';
export {
  lacksIso639_1,
  whisperLanguageCode,
  NO_ISO_639_1,
} from './providers/whisper/language.js';

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
  insertChunks,
  JobAssetMismatchError,
  JobNotFoundError,
  persistChunks,
  persistResult,
  writeTranscript,
  type CreateRunInput,
  type CreateRunResult,
  type PersistResultInput,
  type WriteTranscriptInput,
} from './pipeline/persist.js';
export {
  readChunkResult,
  toChunkResult,
  writeChunkResult,
  type ChunkResult,
} from './pipeline/chunk-result.js';
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
  providerCodeFor,
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
export {
  estimateBatch,
  ingestBatch,
  type BatchDefaults,
  type BatchEstimate,
  type BatchEstimateItem,
  type BatchItem,
  type IngestBatchInput,
  type IngestBatchResult,
} from './ingest/batch.js';
export {
  assertUrlAllowed,
  DEFAULT_URL_POLICY,
  downloadUrl,
  HARDENING,
  matchFilter,
  resolveUrl,
  Semaphore,
  signResolveToken,
  verifyResolveToken,
  type DownloadUrlInput,
  type ResolveClaim,
  type ResolvedMedia,
  type UrlDownloadDeps,
  type UrlPolicy,
  type YtDlpPort,
} from './ingest/url/index.js';

// ---- diarization: turns in, speaker attribution out ------------------------------------
export type {
  DiarizationCapabilities,
  DiarizationResult,
  DiarizeHandle,
  DiarizeRequest,
  DiarizeStatus,
  Turn,
} from './diarize/types.js';
export {
  DEFAULTS as RECONCILE_DEFAULTS,
  assignWords,
  medianSmooth,
  reconcile,
  voteSegments,
  type RSegment,
  type RWord,
  type ReconcileOptions,
  type ReconcileResult,
  type ReconcileStats,
  type SegmentAssignment,
  type WordAssignment,
} from './diarize/reconcile.js';
export {
  intervalOverlapMs,
  matchSpeakers,
  totalMs,
  type FreshSpeaker,
  type Intervals,
  type PriorSpeaker,
} from './diarize/identity.js';
export { DiarizerBusyError, PyannoteSource, type SidecarConfig } from './diarize/pyannote.js';
export {
  loadDiarizeHandle,
  persistDiarizeHandle,
  readDiarizationResult,
  recordDiarizeProgress,
  writeDiarizationResult,
  type DiarizePipelineRecord,
} from './diarize/queue-persist.js';
export {
  allocateSpeakerKeys,
  freshSpeakersFromTurns,
  loadReconcileInput,
  persistDiarization,
  persistDiarizationFailure,
  type PersistDiarizationInput,
  type PersistDiarizationOutput,
  type PersistedSpeaker,
} from './diarize/persist.js';
export {
  DIARIZE_POLL_INTERVAL_MS,
  deadlineForDuration,
  diarizeAudioForRun,
  diarizeStepKey,
  runDiarization,
  type DiarizationSource,
  type RunDiarizationInput,
  type RunDiarizationOutcome,
} from './diarize/run.js';
export {
  SpeakerNotFoundError,
  listSpeakers,
  mergeSpeakers,
  renameSpeaker,
  type MergeResult,
  type SpeakerSummary,
} from './diarize/speakers.js';
export { parseRttm, scoreDiarization, type DerScore, type RttmTurn } from './diarize/score.js';

// ---- queue: the run DAG, its planner, and its reconciler (Phase 9) ---------------------
//
// `run_steps` is the source of truth and pg-boss is a doorbell. Deleting the pg-boss tables
// and restarting must lose nothing but latency, which is why every retry count, dependency
// and dead letter in this surface lives in our own columns — all of it is something a
// newsroom admin has to be able to *see* next to the step that failed.
export {
  ALL_QUEUES,
  HEAVY_QUEUES,
  LIGHT_QUEUES,
  ROUTE,
  STEP_KINDS,
  SUBSCRIPTIONS,
  WEIGHT,
  isQueueName,
  isStepKind,
  routeOf,
  type Doorbell,
  type PendingSend,
  type QueueName,
  type QueueSubscription,
  type StepJob,
  type StepKind,
} from './queue/queues.js';
export {
  MAX_RETRY_AFTER_MS,
  POLICY,
  backoffMs,
  parseRetryAfter,
  type RetrySpec,
} from './queue/retry.js';
export {
  materialisePlan,
  planRun,
  type DependencyRef,
  type PipelineSpec,
  type StepSpec,
} from './queue/plan.js';
export {
  JobNotStartableError,
  startRun,
  type StartRunInput,
  type StartRunResult,
} from './queue/start.js';
export {
  loadRunChunks,
  loadRunContext,
  mergePipeline,
  readPipelineSpec,
  RunNotLoadableError,
  type RunAsset,
  type RunChunkRow,
  type RunContext,
} from './queue/run-context.js';
// `reconcileRun`, not `reconcile`: this package already exports a `reconcile`, which is the
// word↔turn diarization algorithm from Phase 3. Two functions with the same name and nothing
// in common is a collision worth renaming out of even where the compiler tolerates it —
// `reconcileRun` and `reconcile.speakers` say which one they are.
export { reconcile as reconcileRun, stepFraction } from './queue/reconcile.js';
export { PgBossDoorbell, type CreateDoorbellOptions } from './queue/boss.js';
export {
  HEARTBEAT_INTERVAL_MS,
  STALE_AFTER_SECONDS,
  abortReason,
  withHeartbeat,
  type HeartbeatOptions,
} from './queue/lease.js';
export {
  NoHandlerError,
  runStep,
  serialiseError,
  type HandlerRegistry,
  type StepHandler,
  type StepResult,
} from './queue/run-step.js';
export {
  CANCEL_CHANNEL,
  isRunCancelling,
  requestCancel,
  type RequestCancelResult,
} from './queue/cancel.js';
export {
  liveRunIds,
  nudgeExternalWork,
  reclaimStaleLeases,
  reconcileAllLive,
  recoverTick,
  reportOverduePolls,
  unstrandExternalWork,
  OVERDUE_AFTER_SECONDS,
  type OverduePoll,
  type RecoverOptions,
  type RecoveryReport,
} from './queue/recover.js';
export {
  CoalescingEventSink,
  insertAndNotify,
  type CoalescingEventSinkOptions,
  type RunEventDraft,
} from './events/emit.js';
