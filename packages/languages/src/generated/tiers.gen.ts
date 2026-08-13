// GENERATED — DO NOT EDIT.
//
// Produced by scripts/gen-tiers.ts from results/tiers.json, which `thibi eval asr` writes.
// Regenerate with `pnpm --filter @thibi/languages gen`. CI asserts this file matches its
// input, so hand-editing it fails the build rather than taking effect — which matters more
// here than anywhere else in the package: every row is a quality claim about a language,
// and the only thing that may write one is a measurement.
//
// An empty table is the correct state for a checkout where no eval has been run.

import type { MeasuredTier } from '../tiers.js';

/** The run these rows came from, or null if no eval has been published. */
export const TIERS_RUN_ID: string | null = null;
export const TIERS_GENERATED_AT: string | null = null;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const MEASURED_TIERS: Readonly<Record<string, MeasuredTier>> = deepFreeze(
  {} as Record<string, MeasuredTier>,
);
