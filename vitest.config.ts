import { defineConfig } from 'vitest/config';

// Vitest >= 3.2: `test.projects` replaces the deprecated vitest.workspace.ts file.
// Each package is its own project so `--project @thibi/languages` works and so a
// package that later needs a different environment (jsdom for apps/web) can declare
// it locally without touching this file.
/**
 * **Root-level `test` options do not reach projects.** Setting `hookTimeout` or
 * `testTimeout` here has no effect at all once `test.projects` is used — verified
 * 2026-08-11 by setting both to 1 ms and watching every suite pass unchanged.
 *
 * That matters because it fails in the direction of a false negative. Two separate
 * attempts to fix DB-teardown timeouts by raising these here were inert, and one of them
 * was reported as verified after a run that happened to be fast enough. The timeouts now
 * live on the individual `beforeAll`/`afterAll`/`it` calls that need them, which is where
 * the six database-backed suites already put their `beforeAll` budget.
 *
 * If a shared default is ever genuinely wanted, it has to go inside each project entry.
 */
/**
 * **`pyannote.contract.test.ts` is excluded from the default run, and that is a trade rather
 * than a tidy-up.**
 *
 * It performs a *real* diarization: about 40 seconds of CPU inside Docker Desktop's Linux VM for
 * an 11-second clip, and it runs concurrently with eighty other files. The repo's own handoff has
 * recorded the consequence for a while — "on a loaded machine it starves the Postgres suites into
 * hook timeouts" — and on 2026-08-17 that stopped being occasional: the suite grew nineteen more
 * database-backed tests, and full runs began failing four at a time in a *different* set of
 * suites each run (`constraints`, `persist`, `reconcile`, even the CPU-bound `hungarian`).
 *
 * Raising its deadline made it worse, which is the diagnostic: it was not too short, it was
 * consuming a machine other suites needed. Vitest offers no way to run one file alone, so the
 * only lever is to take it out of the concurrent pass.
 *
 * **The cost is real and must not be glossed:** the one test that checks our hard-coded wire
 * shapes against what `schemas.py` actually emits no longer runs by default, so the two halves
 * can drift in silence. `pnpm test:contract` runs it, it passes in ~23 seconds alone, and it is
 * in the definition of done for any change to the sidecar or to `pyannote.ts`. There is precedent
 * for exactly this shape in the repo: the sidecar's own Python suite is not in `pnpm test`
 * either, for the same reason and with the same instruction to run it by hand.
 */
const CONTRACT_TEST = '**/pyannote.contract.test.ts';

/**
 * `RUN_CONTRACT=1` puts it back in, which is what `pnpm test:contract` sets.
 *
 * An env gate rather than a separate project, because a project would still be picked up by a
 * bare `vitest run` — the exclusion has to be the default and the inclusion has to be deliberate.
 */
const contractExclusions = process.env['RUN_CONTRACT'] ? [] : [CONTRACT_TEST];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', ...contractExclusions],
        },
      },
      'apps/*',
      // Repo-level tests that belong to no single package — currently the assertion that
      // the two architectural ESLint rules actually reject the code they claim to.
      { test: { name: 'repo', include: ['tests/**/*.test.ts'] } },
    ],
  },
});
