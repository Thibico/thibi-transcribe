// The FLEURS eval harness. Phase 5.

export {
  configTree,
  loadTsv,
  parseTsv,
  NoEvalSetError,
  type FleursRow,
  type ParsedTsv,
  type Split,
  type TreeEntry,
} from './fleurs/tsv.js';

export { fetchClips, type Clip, type FetchClipsOptions } from './fleurs/audio.js';

export {
  dedupeById,
  describeSample,
  joinTarOrder,
  sampleSeeded,
  selectSeeded,
  type AsrSample,
  type Deduped,
  type SampleComposition,
} from './sample.js';

export {
  estimateAsr,
  formatDryRun,
  formatDuration,
  type AsrEstimate,
  type EstimateInput,
} from './estimate.js';

export {
  canonicalJson,
  clipHashOf,
  paramsHashOf,
  responseKey,
  ResponseCache,
  textHashOf,
  type CachedResponse,
  type ResponseKeyInput,
} from './cache.js';

export { assignTier, THRESHOLDS, type Tier, type TierInput, type TierReason, type TierResult } from './tier.js';

export { scoreProfileFor, scriptRangesFor } from './profile.js';

export { wavDuration, type WavDuration } from './wav.js';

export {
  isComplete,
  MalformedRunlogError,
  parseRunlog,
  readRunlog,
  reconstructRun,
  RunlogWriter,
  runlogPath,
  type RunFooter,
  type RunHeader,
  type RunlogLine,
} from './runlog.js';

export {
  baselineSuspect,
  buildTiersFile,
  diffTiers,
  loadHumanReviews,
  readTiersFile,
  tiersPath,
  writeTiersFile,
  BASELINE_DRIFT_LIMIT,
  TIERS_SCHEMA_VERSION,
  type BuildTiersInput,
  type HumanReview,
  type TierChange,
  type TiersFile,
  type TiersLanguage,
} from './results/tiers.js';

export { publishRun, type PublishResult } from './results/publish.js';

export { renderAsrReport, reportPath, writeAsrReport, type AsrReportInput } from './report/asr.js';

export {
  applyBaselineAndTiers,
  makeRunId,
  runAsrEval,
  BASELINE_CODE,
  type AsrRunResult,
  type AsrTranscribe,
  type FetchClipsFn,
  type LanguageResult,
  type LoadTsvFn,
  type RunAsrDeps,
  type RunAsrOptions,
  type RunEvent,
  type SampleStrategy,
} from './runner.js';
