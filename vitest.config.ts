import { defineConfig } from 'vitest/config';

// Vitest >= 3.2: `test.projects` replaces the deprecated vitest.workspace.ts file.
// Each package is its own project so `--project @thibi/languages` works and so a
// package that later needs a different environment (jsdom for apps/web) can declare
// it locally without touching this file.
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
