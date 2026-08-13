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
export const TIERS_RUN_ID: string | null = "2026-08-13T07-12-20-473Z-google";
export const TIERS_GENERATED_AT: string | null = "2026-08-13T07:21:37.448Z";

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
  {
    "my-MM": {
      "tier": "beta",
      "reason": "measured",
      "provider": "google",
      "model": "chirp_2",
      "n": 30,
      "cer": 0.06431302001349225,
      "cerNospace": 0.06431302001349225,
      "cerCi95": [
        0.04712279111916629,
        0.07957405614714425
      ],
      "ratio": 1,
      "scriptIntegrity": 1,
      "wer": null,
      "evalRunId": "2026-08-13T07-12-20-473Z-google",
      "evalDate": "2026-08-13",
      "humanReviewed": false,
      "notes": "Every clip in this sample is FEMALE; the split cannot show speaker concentration. 1 fetched clip(s) had no reference text and were dropped."
    },
    "ha-NG": {
      "tier": "beta",
      "reason": "measured",
      "provider": "google",
      "model": "chirp_2",
      "n": 30,
      "cer": 0.056946354883081154,
      "cerNospace": 0.058666666666666666,
      "cerCi95": [
        0.04311893639956881,
        0.07562189054726368
      ],
      "ratio": 0.9122051282051281,
      "scriptIntegrity": 1,
      "wer": 0.19097744360902255,
      "evalRunId": "2026-08-13T07-12-20-473Z-google",
      "evalDate": "2026-08-13",
      "humanReviewed": false,
      "notes": "Every clip in this sample is FEMALE; the split cannot show speaker concentration. 30 clips cover 28 distinct sentences."
    },
    "yo-NG": {
      "tier": "experimental",
      "reason": "measured",
      "provider": "google",
      "model": "chirp_2",
      "n": 30,
      "cer": 0.26123427201917315,
      "cerNospace": 0.3054003724394786,
      "cerCi95": [
        0.2491961414790997,
        0.36191626409017713
      ],
      "ratio": 4.748655441392871,
      "scriptIntegrity": 0.984860248447205,
      "wer": 0.6998535871156661,
      "evalRunId": "2026-08-13T07-12-20-473Z-google",
      "evalDate": "2026-08-13",
      "humanReviewed": false,
      "notes": "Every clip in this sample is MALE; the split cannot show speaker concentration."
    },
    "jv-ID": {
      "tier": "beta",
      "reason": "measured",
      "provider": "google",
      "model": "chirp_2",
      "n": 30,
      "cer": 0.04,
      "cerNospace": 0.042973651191969886,
      "cerCi95": [
        0.029759891782211702,
        0.05748233782915864
      ],
      "ratio": 0.6681951987786366,
      "scriptIntegrity": 1,
      "wer": 0.14638447971781304,
      "evalRunId": "2026-08-13T07-12-20-473Z-google",
      "evalDate": "2026-08-13",
      "humanReviewed": false,
      "notes": "Every clip in this sample is MALE; the split cannot show speaker concentration. 30 clips cover 27 distinct sentences."
    },
    "si-LK": {
      "tier": "experimental",
      "reason": "no-eval-set",
      "provider": null,
      "model": null,
      "n": 0,
      "cer": null,
      "cerNospace": null,
      "cerCi95": null,
      "ratio": null,
      "scriptIntegrity": null,
      "wer": null,
      "evalRunId": "2026-08-13T07-12-20-473Z-google",
      "evalDate": "2026-08-13",
      "humanReviewed": false,
      "notes": "No FLEURS config for this language. Not measured, which is not the same as measured and poor — supply --manifest to measure it."
    }
  } as Record<string, MeasuredTier>,
);
