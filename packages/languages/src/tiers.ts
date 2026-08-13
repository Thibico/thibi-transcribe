import { MEASURED_TIERS, TIERS_GENERATED_AT, TIERS_RUN_ID } from './generated/tiers.gen.js';
import type { Tier, TierSource } from './types.js';

/**
 * The measured layer — what the eval harness found, compiled in at build time.
 *
 * `results/tiers.json` is written by `thibi eval asr` and turned into
 * `generated/tiers.gen.ts` by `pnpm gen`. It is a generated module rather than a JSON
 * import for the same two reasons `registry.gen.ts` is: `resolveJsonModule` is off
 * repo-wide, so a JSON import type-checks under vitest's esbuild and then fails `tsc -b`;
 * and this package is imported by React client components, where a compiled object literal
 * is frozen, typed and tree-shakeable and a JSON blob is none of those.
 *
 * **The fallback, and the trap inside it.** With no `tiers.json` there are no measurements,
 * and `measuredTier` answers `experimental / not-run` for every language — the
 * all-experimental fallback §5 asks for. That is the honest answer to *"what has the harness
 * measured?"*, and it is **not** the language's tier: the registry falls back to the seeded
 * tier there instead. Letting the fallback into `resolveLanguage` would demote `my-MM` —
 * verified by operational use, never by the harness — to experimental on any checkout where
 * nobody had run an eval, which is every fresh clone.
 */

export type TierReason = 'measured' | 'no-eval-set' | 'code-rejected' | 'script-integrity' | 'not-run';

/** Where a resolved tier came from. Risk 9: the UI must be able to say. Defined in `types.ts`. */
export type { TierSource };

export interface MeasuredTier {
  tier: Tier;
  reason: TierReason;
  provider: string | null;
  model: string | null;
  n: number;
  cer: number | null;
  cerNospace: number | null;
  cerCi95: readonly [number, number] | null;
  ratio: number | null;
  scriptIntegrity: number | null;
  wer: number | null;
  evalRunId: string | null;
  evalDate: string | null;
  humanReviewed: boolean;
  notes: string;
}

const UNMEASURED: MeasuredTier = Object.freeze({
  tier: 'experimental' as Tier,
  reason: 'not-run' as TierReason,
  provider: null,
  model: null,
  n: 0,
  cer: null,
  cerNospace: null,
  cerCi95: null,
  ratio: null,
  scriptIntegrity: null,
  wer: null,
  evalRunId: null,
  evalDate: null,
  humanReviewed: false,
  notes: 'No eval run has measured this language.',
});

/** The harness's answer for a language, or the unmeasured fallback. Never null, never throws. */
export function measuredTier(code: string): MeasuredTier {
  return MEASURED_TIERS[code] ?? UNMEASURED;
}

/** Only what was actually measured. Empty on a checkout where no eval has been run. */
export function hasMeasurement(code: string): boolean {
  return MEASURED_TIERS[code] !== undefined;
}

export { MEASURED_TIERS, TIERS_GENERATED_AT, TIERS_RUN_ID };
