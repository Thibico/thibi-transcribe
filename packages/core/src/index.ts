// @thibi/core — zero runtime dependencies, browser-safe.
//
// Types, timecode, subtitle reflow, bidi, export writers, metrics (CER/WER/chrF) and
// pricing format. This package is importable from a React client component, which is why
// subtitle re-flow and the CER metrics live here rather than in the engine: the editor
// previews CPS live, and the eval harness and the running app must score identically.
//
// It may depend on nothing. The ESLint layer rule enforces that — which is also why the
// functions here take minimal structural shapes (see `SegmentationRules`) rather than
// importing `ResolvedLanguage` from @thibi/languages.

export {
  parseDelimited,
  parseTsv,
  parseFleursTsv,
  type ParseDelimitedOptions,
  type FleursRow,
} from './text/tsv.js';

export {
  WORD_TIMING_RANK,
  minWordTimingQuality,
  type Layer,
  type RunMode,
  type Segment,
  type SegmentText,
  type TextOrigin,
  type Warning,
  type Word,
  type WordTimingQuality,
} from './types.js';

export {
  durationMs,
  formatClock,
  formatTimestamp,
  overlapMs,
  parseClock,
  type FormatClockOptions,
} from './timecode.js';

export {
  hasIcuSegmentation,
  interpolateWords,
  segmentUnits,
  type SegmentationRules,
} from './timing/interpolate.js';

export {
  indexTexts,
  resolveLayer,
  type LayerRequest,
  type ResolvedText,
} from './layers/resolve.js';

export {
  formatScriptIntegrity,
  scriptIntegrity,
  type ScriptIntegrity,
  type ScriptRanges,
} from './metrics/script.js';
