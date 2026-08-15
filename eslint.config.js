import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Two of the rules below are architecture, not style. They are free to add now and a
 * refactor to add later, which is the whole reason they land in Phase 0.
 */

/**
 * The one-way dependency direction from 00-overview.md:
 *
 *     core <- languages <- db <- engine <- runtime <- { web, cli, worker }
 *     core <- storage --------- ^
 *
 * `core` is importable from React client components — that is why subtitle re-flow and
 * the CER metrics live there, and why it may depend on nothing.
 */
const LAYERS = {
  core: [],
  languages: ['core'],
  storage: ['core'],
  db: ['core', 'languages'],
  engine: ['core', 'languages', 'db', 'storage'],
  eval: ['core', 'languages', 'engine'],
};

const ALL_PACKAGES = Object.keys(LAYERS);
// `runtime` is in this list although it is not an app: it is the composition root the apps
// share, it reads the environment, and a package that imported it would be reaching for
// exactly the ambient configuration the layer rules exist to keep out.
const APPS = ['web', 'worker', 'cli', 'runtime'];

/** Every @thibi/* specifier a package in `pkg` is not allowed to reach for. */
function forbiddenFor(pkg) {
  const allowed = new Set([pkg, ...LAYERS[pkg]]);
  return [
    ...ALL_PACKAGES.filter((p) => !allowed.has(p)),
    // No engine package may reach back into an application. An app composes the
    // packages; a package that knows about an app cannot be reused by the next one.
    ...APPS,
  ];
}

const layerRules = ALL_PACKAGES.map((pkg) => ({
  files: [`packages/${pkg}/src/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: forbiddenFor(pkg).map((target) => ({
          group: [`@thibi/${target}`, `@thibi/${target}/*`],
          message:
            `packages/${pkg} may not import @thibi/${target}. The dependency direction is ` +
            `one-way (core <- languages <- db <- engine <- apps); see 00-overview.md.`,
        })),
      },
    ],
  },
}));

/**
 * The engine never reads process.env or process.cwd(). Everything arrives via one
 * EngineContext. Without this rule the ban is a sentence in a design document; with it,
 * `lib/db.ts:5`'s `DATA_DIR = process.cwd()/data` cannot be reintroduced by accident.
 *
 * A CI grep backs this up, because an `eslint-disable` comment would otherwise be enough
 * to reintroduce it quietly.
 */
const noAmbientConfig = {
  files: ['packages/*/src/**/*.ts'],
  ignores: ['packages/*/src/**/__tests__/**'],
  rules: {
    'no-restricted-properties': [
      'error',
      {
        object: 'process',
        property: 'env',
        message: 'The engine never reads process.env — take it from EngineContext.',
      },
      {
        object: 'process',
        property: 'cwd',
        message: 'The engine never reads process.cwd() — take paths from EngineContext.',
      },
    ],
    'no-restricted-globals': [
      'error',
      { name: '__dirname', message: 'Engine code has no filesystem identity.' },
      { name: '__filename', message: 'Engine code has no filesystem identity.' },
    ],
  },
};

/**
 * A handler does its work and returns a `StepResult`. It does not ring the doorbell, does not
 * reconcile, and does not decide its own retry.
 *
 * Those three belong to `sendStep`, `reconcile` and `runStep`, and each is the *only* thing
 * that does its job — one promotion path, one send path, one retry count. A handler that
 * reconciled after writing its own segments would be a second promotion path, and one that
 * wrapped itself in `withRetry` would be a second retry count: the step would run six times
 * while `/admin/queue` said three, and the number an admin can see is the one that has to be
 * true. Phase 9 §13 asks for this rule by name.
 */
const handlersOwnNothing = {
  files: ['apps/worker/src/handlers/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@thibi/engine',
            importNames: ['reconcileRun', 'PgBossDoorbell', 'withRetry', 'reconcileAllLive'],
            message:
              'A handler returns a StepResult and nothing else. Promotion belongs to ' +
              'reconcile, sending to the doorbell, and retry to runStep — see phase 9 §13.',
          },
          {
            name: 'pg-boss',
            message: 'Only queue/boss.ts imports pg-boss. A handler must not know it exists.',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/.next/**',
      '**/coverage/**',
      'spikes/raw/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  noAmbientConfig,
  handlersOwnNothing,
  ...layerRules,
  {
    // Generated output is asserted byte-for-byte by the drift test; linting it would only
    // ever produce a demand to hand-edit a file that must never be hand-edited.
    files: ['packages/languages/src/generated/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Build tooling legitimately reads argv, env and the filesystem — it is not the engine.
    files: ['packages/*/scripts/**/*.ts', 'scripts/**/*.ts', '*.config.ts', '*.config.js'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-globals': 'off',
      'no-console': 'off',
    },
  },
);
