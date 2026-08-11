import { defineConfig } from 'vitest/config';

// Vitest >= 3.2: `test.projects` replaces the deprecated vitest.workspace.ts file.
// Each package is its own project so `--project @thibi/languages` works and so a
// package that later needs a different environment (jsdom for apps/web) can declare
// it locally without touching this file.
export default defineConfig({
  test: {
    /**
     * 60 s, up from the 10 s default, because of the teardown and not the tests.
     *
     * Five suites create a real Postgres database from a template in `beforeAll` and
     * `drop database … with (force)` it in `afterAll`. Both are slow under load and neither
     * is the thing under test. Measured 2026-08-11: with the Phase 3 sidecar container
     * running alongside, the full 37-file run took 60-70 s and **four** suites failed on
     * `Hook timed out in 10000ms` — with every one of their 605 assertions passing. With
     * the container stopped the same run is 20 s and green.
     *
     * A teardown that fails only when the machine is busy is a test of the machine, and
     * this one reads as a database bug: the suite reports FAIL directly under a green test
     * count. Raising the ceiling is the honest fix; a genuinely wedged `drop` still fails,
     * just not because something else was compiling.
     */
    hookTimeout: 60_000,
    /**
     * 30 s, up from the 5 s default, and for the same reason as `hookTimeout` above.
     *
     * Measured 2026-08-11, adding Phase 3's `diarize/persist.test.ts`: that made a **sixth**
     * suite hold a real database, and the extra contention pushed `speakers.test.ts >
     * answers the review query from the partial index` from 2.0 s standalone to over 5 s
     * inside the 40-file run. It inserts 2,000 segment rows and then plans a query; none of
     * that is the thing under test, and the assertion is about the *plan*, not the clock.
     *
     * The trap this repo already paid for once is the 64x64 Hungarian timing bound, which
     * passed alone and failed in parallel because it was measuring machine load. A default
     * timeout does the same thing silently to any DB suite. Raising it is the honest fix: a
     * genuinely hung test still fails, just not because something else was compiling.
     */
    testTimeout: 30_000,
    projects: [
      'packages/*',
      'apps/*',
      // Repo-level tests that belong to no single package — currently the assertion that
      // the two architectural ESLint rules actually reject the code they claim to.
      { test: { name: 'repo', include: ['tests/**/*.test.ts'] } },
    ],
  },
});
