/**
 * Compiles `results/tiers.json` into `src/generated/tiers.gen.ts`.
 *
 * Why a compile step, again: `resolveJsonModule` is off repo-wide, so a JSON `import`
 * type-checks under vitest's esbuild and then fails `tsc -b`; and this package is imported
 * by React client components, where a frozen object literal tree-shakes and a JSON blob
 * does not.
 *
 * **A missing `results/tiers.json` is normal, not an error.** A fresh clone has never run an
 * eval, and CI must not need one. The generated file is then an empty table and
 * `measuredTier` answers `experimental / not-run` for everything — which is the honest
 * answer to "what has the harness measured", and deliberately not the same thing as the
 * language's tier (see `src/tiers.ts`).
 *
 *   pnpm --filter @thibi/languages gen
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface TiersJsonLanguage {
  tier: string;
  reason: string;
  provider: string | null;
  model: string | null;
  n: number;
  cer: number | null;
  cerNospace: number | null;
  cerCi95: [number, number] | null;
  ratio: number | null;
  scriptIntegrity: number | null;
  wer: number | null;
  evalRunId: string;
  evalDate: string;
  humanReview: unknown | null;
  notes: string;
}

interface TiersJson {
  schemaVersion: number;
  generatedAt: string;
  /** v2. The file accumulates across runs, so each row names its own; this is the newest. */
  latestRunId: string;
  languages: Record<string, TiersJsonLanguage>;
}

/** The schema this script understands. Bumped with `TIERS_SCHEMA_VERSION` in `@thibi/eval`. */
const SUPPORTED_SCHEMA = 2;

// Relative to the package, because that is where `pnpm --filter` puts the cwd. The results
// directory belongs to the repo, not to this package: the harness writes it and several
// packages read it.
const source = process.argv[2] ?? resolve('../../results/tiers.json');

let file: TiersJson | null = null;
if (existsSync(source)) {
  file = JSON.parse(readFileSync(source, 'utf8')) as TiersJson;
  if (file.schemaVersion !== SUPPORTED_SCHEMA) {
    // Loudly, rather than emitting a table shaped like a version this code does not
    // understand. A silently mis-parsed tier is a claim made to a newsroom.
    throw new Error(
      `${source}: schemaVersion ${file.schemaVersion} is not supported (expected ${SUPPORTED_SCHEMA}). ` +
        `It is derived from the runlogs in results/runs — republish it with ` +
        `\`thibi eval report --run <runId>\` rather than editing it or loosening this check.`,
    );
  }
}

const rows: Record<string, unknown> = {};
for (const [code, row] of Object.entries(file?.languages ?? {})) {
  rows[code] = {
    tier: row.tier,
    reason: row.reason,
    provider: row.provider,
    model: row.model,
    n: row.n,
    cer: row.cer,
    cerNospace: row.cerNospace,
    cerCi95: row.cerCi95,
    ratio: row.ratio,
    scriptIntegrity: row.scriptIntegrity,
    wer: row.wer,
    evalRunId: row.evalRunId,
    evalDate: row.evalDate,
    // The sign-off itself stays in `results/human-review/`; what the registry needs is
    // whether one exists, and it is a boolean everywhere else in this package.
    humanReviewed: row.humanReview !== null && row.humanReview !== undefined,
    notes: row.notes,
  };
}

const out = `// GENERATED — DO NOT EDIT.
//
// Produced by scripts/gen-tiers.ts from results/tiers.json, which \`thibi eval asr\` writes.
// Regenerate with \`pnpm --filter @thibi/languages gen\`. CI asserts this file matches its
// input, so hand-editing it fails the build rather than taking effect — which matters more
// here than anywhere else in the package: every row is a quality claim about a language,
// and the only thing that may write one is a measurement.
//
// An empty table is the correct state for a checkout where no eval has been run.

import type { MeasuredTier } from '../tiers.js';

/** The run these rows came from, or null if no eval has been published. */
export const TIERS_RUN_ID: string | null = ${JSON.stringify(file?.latestRunId ?? null)};
export const TIERS_GENERATED_AT: string | null = ${JSON.stringify(file?.generatedAt ?? null)};

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
  ${JSON.stringify(rows, null, 2).replace(/\n/gu, '\n  ')} as Record<string, MeasuredTier>,
);
`;

writeFileSync('src/generated/tiers.gen.ts', out);
console.error(
  file === null
    ? `wrote src/generated/tiers.gen.ts — no ${source}, so no measurements (this is normal on a fresh clone)`
    : `wrote src/generated/tiers.gen.ts — ${Object.keys(rows).length} measured language(s), newest run ${file.latestRunId}`,
);
