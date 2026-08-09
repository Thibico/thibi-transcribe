// @thibi/core — zero runtime dependencies, browser-safe.
//
// Types, timecode, subtitle reflow, bidi, export writers, metrics (CER/WER/chrF) and
// pricing format. This package is importable from a React client component, which is why
// subtitle re-flow and the CER metrics live here rather than in the engine: the editor
// previews CPS live, and the eval harness and the running app must score identically.
//
// It may depend on nothing. The ESLint layer rule enforces that.

export {
  parseDelimited,
  parseTsv,
  parseFleursTsv,
  type ParseDelimitedOptions,
  type FleursRow,
} from './text/tsv.js';
