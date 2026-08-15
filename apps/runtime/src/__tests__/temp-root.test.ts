import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotConfiguredError } from '@thibi/engine';
import { resolveTempRoot } from '../context.js';

/**
 * `mkdtemp` does not create its parent, so a wrong `THIBI_TMP_DIR` used to surface as a raw
 * `ENOENT` stack trace from three stages into a pipeline — after the probe, after normalize
 * had decided what it wanted. These assert the two things that matter: the failure is a
 * sentence rather than a trace, and it happens before any work.
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'thibi-temproot-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveTempRoot', () => {
  it('falls back to the system temp directory when unset', () => {
    expect(resolveTempRoot(undefined)).toBe(tmpdir());
    expect(resolveTempRoot('')).toBe(tmpdir());
    expect(resolveTempRoot('   ')).toBe(tmpdir());
  });

  it('accepts a directory that exists and is writable', () => {
    expect(resolveTempRoot(dir)).toBe(dir);
  });

  it('rejects a path that does not exist, and says how to fix it', () => {
    const missing = join(dir, 'not-here');
    expect(() => resolveTempRoot(missing)).toThrow(NotConfiguredError);
    try {
      resolveTempRoot(missing);
    } catch (err) {
      expect((err as Error).message).toContain('does not exist');
      // The hint has to carry the path — an operator fixing this is copying a command.
      expect((err as NotConfiguredError).hint).toContain(missing);
      expect((err as NotConfiguredError).hint).toContain('mkdir -p');
    }
  });

  it('rejects a path that is a file rather than a directory', () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(() => resolveTempRoot(file)).toThrow(/not a directory/u);
  });

  /**
   * Skipped as root, which can write to a 0o500 directory and would make this assert the
   * opposite of what it claims.
   */
  it.skipIf(process.getuid?.() === 0)('rejects a directory it cannot write to', () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      expect(() => resolveTempRoot(locked)).toThrow(/not writable/u);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  /** It must not create the directory: a missing mount should be an error, not a new disk. */
  it('does not create the directory it was given', () => {
    const missing = join(dir, 'still-not-here');
    expect(() => resolveTempRoot(missing)).toThrow();
    expect(() => resolveTempRoot(missing)).toThrow(); // second call, same failure
  });
});
