/**
 * The metrics layer's public surface.
 *
 * Everything the eval harness and the editor score with is exported here and re-exported by
 * `@thibi/core`'s root barrel; nothing outside this directory deep-imports `./cer.js` or
 * `./chrf.js`. That is the mechanism behind Phase 5 §5.5's second reason for writing these
 * in TypeScript at all — the harness and the running app have to produce the same number for
 * the same text, and they can only do that if there is one implementation with one entry
 * point.
 *
 * The import path is `@thibi/core`, not `@thibi/core/metrics`: every consumer in the tree
 * already imports from the root barrel, and `packages/core`'s `exports` map has no working
 * nested subpath. Phase 5's deliverables table calls this file "the only import path for the
 * app and the harness", which is the intent; the root barrel is where the repo puts it.
 *
 * Three things deliberately do **not** live here:
 *
 * - **Tier assignment.** Thresholds and the `verified` rule are `packages/eval/src/tier.ts`.
 *   `@thibi/core` measures; deciding what a measurement entitles a language to is policy.
 * - **`ScoreProfile` construction.** `toScoreProfile(resolveLanguage(code))` is in
 *   `@thibi/languages`, because core may not import the registry. One function, two callers,
 *   no drift.
 * - **The Zawgyi detector and converter.** Two npm packages, injected through
 *   `ScoreOptions.convertZawgyi`; core has zero runtime dependencies and ships into a React
 *   client bundle.
 */

export { levenshtein } from './levenshtein.js';

export { cer, corpusCer, editStats, units, type EditStats, type Units } from './cer.js';

export {
  corpusWer,
  wer,
  werStats,
  type WerKind,
  type WerResult,
} from './wer.js';

export {
  chrf2,
  chrfScore,
  chrfStats,
  corpusChrf2,
  type ChrfOptions,
  type ChrfStats,
} from './chrf.js';

export {
  normalizeForScoring,
  type ScoreOptions,
  type ScoreProfile,
} from './normalize.js';

export {
  formatScriptIntegrity,
  scriptIntegrity,
  type ScriptIntegrity,
  type ScriptRanges,
} from './script-integrity.js';

export { bootstrapCi, mulberry32 } from './bootstrap.js';
