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
 *     core <- languages <- db <- engine <- { web, cli, worker }
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
const APPS = ['web', 'worker', 'cli'];

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
