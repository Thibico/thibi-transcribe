import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishRun } from '../results/publish.js';
import { readTiersFile, type HumanReview } from '../results/tiers.js';
import type { AsrRunResult, LanguageResult } from '../runner.js';

/**
 * Publishing is where a measurement becomes a claim, so these are the rules about when the
 * harness is *not* allowed to make one.
 */

function language(over: Partial<LanguageResult> = {}): LanguageResult {
  return {
    languageCode: 'my-MM',
    cfg: 'my_mm',
    tsvOid: 'oid',
    n: 30,
    clipSeconds: 300,
    genderSplit: { FEMALE: 30 },
    genderUniform: true,
    distinctIds: 30,
    cer: 0.12,
    cerNospace: 0.12,
    cerCi95: [0.11, 0.13],
    wer: null,
    werKind: null,
    scriptIntegrity: 0.99,
    ratio: 1,
    costUsd: 0,
    cachedClips: 0,
    unmatched: 0,
    example: { id: 1, ref: 'မြန်မာ', hyp: 'မြန်မာ' },
    tier: { tier: 'beta', reason: 'measured', blockedFromVerifiedBy: ['humanReview'] },
    ...over,
  };
}

const run = (languages: LanguageResult[], runId = 'run-1'): AsrRunResult => ({
  runId,
  startedAt: '2026-08-13T12:00:00.000Z',
  finishedAt: '2026-08-13T12:05:00.000Z',
  provider: 'google',
  model: 'chirp_2',
  split: 'dev',
  n: 30,
  baselineCode: 'my-MM',
  baselineAdded: false,
  languages,
  spentUsd: 0.16,
  budgetExhausted: false,
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thibi-publish-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('publishRun', () => {
  it('writes both files and exits 0 on a clean run', async () => {
    const p = await publishRun(dir, run([language()]), 'test');
    expect(p.exitCode).toBe(0);
    expect(p.tiersPath).not.toBeNull();
    expect(await readTiersFile(dir)).not.toBeNull();
    expect(await readFile(p.reportPath, 'utf8')).toContain('# ASR eval — 2026-08-13');
  });

  /**
   * A baseline that moved re-tiers every other language at once for a reason that has
   * nothing to do with those languages. Refusing to write is the point; refusing to *show*
   * the numbers would leave whoever has to investigate it with nothing to look at.
   */
  it('refuses to write tiers.json when the baseline drifted, but still writes the report', async () => {
    await publishRun(dir, run([language({ cerNospace: 0.12 })], 'run-1'), 'test');
    const before = await readTiersFile(dir);

    const p = await publishRun(dir, run([language({ cerNospace: 0.4 })], 'run-2'), 'test');
    expect(p.exitCode).toBe(4);
    expect(p.tiersPath).toBeNull();
    expect(await readFile(p.reportPath, 'utf8')).toContain('Baseline suspect');

    // The file on disk is still the last trustworthy one, unchanged.
    expect(await readTiersFile(dir)).toEqual(before);
  });

  it('reports the tier changes it published', async () => {
    await publishRun(dir, run([language()], 'run-1'), 'test');
    const p = await publishRun(
      dir,
      run(
        [
          language({
            cerNospace: 0.13,
            tier: { tier: 'experimental', reason: 'measured', blockedFromVerifiedBy: ['ratio>1.15'] },
          }),
        ],
        'run-2',
      ),
      'test',
    );
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ code: 'my-MM', from: 'beta', to: 'experimental' });
  });

  it('honours a sign-off naming this run, and ignores one naming another', async () => {
    await mkdir(join(dir, 'human-review'), { recursive: true });
    const review: HumanReview = {
      code: 'my-MM',
      reviewer: 'Someone <s@example.com>',
      reviewedAt: '2026-08-13',
      evalRunId: 'run-1',
      clipsReviewed: 12,
      verdict: 'pass',
      nativeSpeaker: true,
    };
    await writeFile(join(dir, 'human-review', 'my-MM.json'), JSON.stringify(review), 'utf8');

    const matching = await publishRun(dir, run([language()], 'run-1'), 'test');
    expect(matching.tiers.languages['my-MM']!.humanReview).not.toBeNull();

    const later = await publishRun(dir, run([language()], 'run-9'), 'test');
    expect(later.tiers.languages['my-MM']!.humanReview).toBeNull();
    expect(await readFile(later.reportPath, 'utf8')).toContain('Sign-off stale');
  });
});
