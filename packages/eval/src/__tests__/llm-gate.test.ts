import { describe, expect, it } from 'vitest';
import type { CleanupArmResult, CleanupRunResult } from '../llm/cleanup.js';
import { formatGateFailures, gateCleanup, GATE_LIMITS } from '../llm/gate.js';

/**
 * The gate's boundaries, against synthetic arms.
 *
 * A run built by hand rather than measured, because the question here is only *where the line
 * is*: `llm-cleanup.test.ts` proves the gate reads a real run correctly, and a threshold test
 * that has to run a model to reach 0.006 is a threshold test nobody will change.
 */

function arm(over: Partial<CleanupArmResult>): CleanupArmResult {
  return {
    arm: 'restraint',
    model: 'm1',
    promptId: 'cleanup.restraint',
    promptVersion: 3,
    n: 30,
    cerPunct: 0.02,
    contentDelta: 0,
    entityDrift: 0,
    lengthDelta: 0.05,
    rewritten: 0,
    cerPunctCi95: null,
    costUsd: 0,
    cachedSegments: 0,
    failed: 0,
    examples: [],
    entitiesLost: [],
    ...over,
  };
}

function run(arms: CleanupArmResult[], code = 'yo-NG'): CleanupRunResult {
  return {
    runId: 'r1',
    startedAt: '2026-08-14T00:00:00.000Z',
    finishedAt: '2026-08-14T00:01:00.000Z',
    provider: 'fake',
    models: ['m1'],
    arms: ['control', 'restraint'],
    split: 'dev',
    n: 30,
    seed: 1,
    languages: [{ languageCode: code, cfg: 'yo_ng', tsvOid: 'oid', n: 30, distinctIds: 30, arms }],
    spentUsd: 0,
    budgetExhausted: false,
  };
}

const control = arm({ arm: 'control', model: '', promptId: null, promptVersion: null, cerPunct: 0.03 });

describe('gateCleanup', () => {
  it('fails an arm above its control and names the language', () => {
    const failures = gateCleanup(run([control, arm({ cerPunct: 0.0301 })]));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'yo-NG', metric: 'cer_punct' });
  });

  it('passes an arm exactly at its control', () => {
    // `>` and not `>=`: an arm that matches the control has not made anything worse, and a
    // gate that failed on equality would fail every run where a language has nothing to fix.
    expect(gateCleanup(run([control, arm({ cerPunct: 0.03 })]))).toEqual([]);
  });

  it('puts content_delta at 0.005, tolerant below and hard above', () => {
    expect(gateCleanup(run([control, arm({ contentDelta: 0.004 })]))).toEqual([]);
    expect(gateCleanup(run([control, arm({ contentDelta: GATE_LIMITS.contentDelta })]))).toEqual([]);
    const failed = gateCleanup(run([control, arm({ contentDelta: 0.006 })]));
    expect(failed.map((f) => f.metric)).toEqual(['content_delta']);
  });

  it('puts entity_drift at 0.02', () => {
    expect(gateCleanup(run([control, arm({ entityDrift: 0.02 })]))).toEqual([]);
    expect(gateCleanup(run([control, arm({ entityDrift: 0.021 })])).map((f) => f.metric)).toEqual([
      'entity_drift',
    ]);
  });

  it('reports every condition an arm broke, not the first', () => {
    const failures = gateCleanup(
      run([control, arm({ cerPunct: 0.06, contentDelta: 0.02, entityDrift: 0.1 })]),
    );
    expect(failures.map((f) => f.metric).sort()).toEqual([
      'cer_punct',
      'content_delta',
      'entity_drift',
    ]);
  });

  it('sorts the worst regression first', () => {
    const failures = gateCleanup(
      run([control, arm({ cerPunct: 0.5, contentDelta: 0.006, entityDrift: 0.021 })]),
    );
    expect(failures[0]!.metric).toBe('cer_punct');
  });

  it('skips a language that produced no arms at all', () => {
    const empty = run([]);
    empty.languages[0]!.error = 'stopped part-way: budget exhausted';
    expect(gateCleanup(empty)).toEqual([]);
  });
});

describe('formatGateFailures', () => {
  it('prints both numbers, the delta and the offending pair', () => {
    const failures = gateCleanup(
      run([
        control,
        arm({
          cerPunct: 0.148,
          examples: [{ id: 7, input: 'UN tún ní ìrètí', output: 'Wọ́n tún ní ìrètí.' }],
          entitiesLost: ['UN'],
        }),
      ]),
    );
    const text = formatGateFailures(failures);
    expect(text).toContain('yo-NG');
    expect(text).toContain('0.1480');
    expect(text).toContain('0.0300');
    // The pair is what a reader can act on. "content_delta 0.012 > 0.005" says a rule broke;
    // the strings say which word moved.
    expect(text).toContain('UN tún ní ìrètí');
    expect(text).toContain('Wọ́n tún ní ìrètí.');
    expect(text).toContain('entities that left the text: UN');
  });

  it('says so plainly when nothing failed', () => {
    expect(formatGateFailures([])).toContain('pass');
  });
});
