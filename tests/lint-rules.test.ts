import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The two rules in eslint.config.js that are architecture rather than style. A design
 * document saying "the engine never reads process.env" is a wish; this file is what makes
 * it a fact, and it is the reason both rules were added in Phase 0 rather than after the
 * first violation.
 *
 * The first assertion pays for the whole file's setup: `lintText` lazily builds the flat
 * config and loads typescript-eslint, which takes well over a second on its own and several
 * under load. At vitest's 5 s default this suite passed alone and failed in a full `pnpm
 * test` run, where it competes with the Postgres-backed suites — a flaky gate is worse than
 * a slow one, so the timeout is explicit rather than inherited.
 */
const LINT_TIMEOUT_MS = 30_000;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

async function messagesFor(relPath: string, code: string) {
  const [result] = await eslint.lintText(code, {
    filePath: join(REPO_ROOT, relPath),
    warnIgnored: false,
  });
  return result?.messages ?? [];
}

describe('dependency direction', () => {
  it('rejects @thibi/db imported from packages/core', async () => {
    const messages = await messagesFor('packages/core/src/probe.ts', `import '@thibi/db';\n`);
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain('packages/core may not import @thibi/db');
  }, LINT_TIMEOUT_MS);

  it('rejects an app imported from a package', async () => {
    const messages = await messagesFor(
      'packages/engine/src/probe.ts',
      `import '@thibi/worker';\n`,
    );
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toHaveLength(1);
  }, LINT_TIMEOUT_MS);

  it('rejects a subpath import of a forbidden package', async () => {
    const messages = await messagesFor(
      'packages/languages/src/probe.ts',
      `import '@thibi/engine/pipeline';\n`,
    );
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toHaveLength(1);
  }, LINT_TIMEOUT_MS);

  it('allows the declared direction', async () => {
    for (const [pkg, dep] of [
      ['languages', 'core'],
      ['engine', 'db'],
      ['engine', 'storage'],
      ['eval', 'languages'],
      ['db', 'languages'],
    ] as const) {
      const messages = await messagesFor(
        `packages/${pkg}/src/probe.ts`,
        `import '@thibi/${dep}';\n`,
      );
      expect(
        messages.filter((m) => m.ruleId === 'no-restricted-imports'),
        `packages/${pkg} should be allowed to import @thibi/${dep}`,
      ).toHaveLength(0);
    }
  }, LINT_TIMEOUT_MS);
});

describe('ambient configuration ban', () => {
  // lib/db.ts:5 in the old app is `DATA_DIR = process.cwd()/data`. It must not survive
  // the port, and this is what stops it.
  it.each([
    ['process.env', `export const x = process.env.GOOGLE_REGION;\n`, 'no-restricted-properties'],
    ['process.cwd()', `export const x = process.cwd();\n`, 'no-restricted-properties'],
    ['__dirname', `export const x = __dirname;\n`, 'no-restricted-globals'],
  ])(
    'rejects %s in engine source',
    async (_label, code, ruleId) => {
      const messages = await messagesFor('packages/engine/src/probe.ts', code);
      expect(messages.filter((m) => m.ruleId === ruleId).length).toBeGreaterThan(0);
    },
    LINT_TIMEOUT_MS,
  );

  it('allows process.env in a package test', async () => {
    const messages = await messagesFor(
      'packages/engine/src/__tests__/probe.test.ts',
      `export const x = process.env.CI;\n`,
    );
    expect(messages.filter((m) => m.ruleId === 'no-restricted-properties')).toHaveLength(0);
  }, LINT_TIMEOUT_MS);

  it('allows process.env in build tooling', async () => {
    const messages = await messagesFor(
      'packages/languages/scripts/probe.ts',
      `export const x = process.env.HF_TOKEN;\n`,
    );
    expect(messages.filter((m) => m.ruleId === 'no-restricted-properties')).toHaveLength(0);
  }, LINT_TIMEOUT_MS);
});
