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

export {
  runAsrEval,
  BASELINE_CODE,
  type AsrRunResult,
  type AsrTranscribe,
  type LanguageResult,
  type RunAsrDeps,
  type RunAsrOptions,
} from './runner.js';
