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
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/*',
      // Repo-level tests that belong to no single package — currently the assertion that
      // the two architectural ESLint rules actually reject the code they claim to.
      { test: { name: 'repo', include: ['tests/**/*.test.ts'] } },
    ],
  },
});
