import { describe, expect, it } from 'vitest';
import { hasMeasurement, measuredTier, MEASURED_TIERS } from '../tiers.js';
import { resolveLanguage } from '../registry.js';

/**
 * The measured layer, and the one distinction it must not blur.
 *
 * `measuredTier` answers *"what has the harness measured?"* and falls back to
 * `experimental / not-run`. A language's **tier** is a different question, and if the
 * fallback ever became the answer to it, every fresh clone — none of which has run an eval —
 * would demote `my-MM` from verified. That language is verified by operational use and was
 * never a harness claim; the harness cannot award `verified` at all.
 */

describe('the unmeasured fallback', () => {
  it('answers experimental / not-run for a language nothing has measured', () => {
    const t = measuredTier('zz-ZZ');
    expect(t.tier).toBe('experimental');
    expect(t.reason).toBe('not-run');
    expect(t.cer).toBeNull();
    expect(t.n).toBe(0);
  });

  it('is a fallback, not a measurement', () => {
    expect(hasMeasurement('zz-ZZ')).toBe(false);
  });

  it('never returns null or throws, whatever it is handed', () => {
    expect(measuredTier('')).toBeDefined();
    expect(measuredTier('not-a-code-at-all')).toBeDefined();
  });

  it('does not let the fallback demote a seeded tier', () => {
    // The load-bearing assertion. `my-MM` is seeded `verified` by human judgement; with no
    // measurement in the table it must stay there and say the tier came from the seed.
    const my = resolveLanguage('my-MM')!;
    if (!hasMeasurement('my-MM')) {
      expect(my.tier).toBe('verified');
      expect(my.tierSource).toBe('seed');
    } else {
      expect(my.tierSource).toBe('measured');
    }
  });
});

describe('provenance', () => {
  it('reports an admin override as an override, whatever the measurement said', () => {
    const promoted = resolveLanguage('ha-NG', [{ code: 'ha-NG', tier: 'verified' }])!;
    expect(promoted.tier).toBe('verified');
    expect(promoted.tierSource).toBe('override');
  });

  it('reports the seed as the seed when nothing else has an opinion', () => {
    const ha = resolveLanguage('ha-NG')!;
    expect(['seed', 'measured']).toContain(ha.tierSource);
    if (!hasMeasurement('ha-NG')) expect(ha.tierSource).toBe('seed');
  });
});

describe('the generated table', () => {
  /**
   * Whatever is in it, every row has to be a complete measurement — a half-filled row would
   * put a tier on a language with no number behind it.
   */
  it('carries a tier, a reason and a run id on every row it has', () => {
    for (const [code, row] of Object.entries(MEASURED_TIERS)) {
      expect(row.tier, code).toBeDefined();
      expect(row.reason, code).toBeDefined();
      expect(row.evalRunId, code).toBeTruthy();
    }
  });

  it('is frozen, so no consumer can rewrite a quality claim at runtime', () => {
    expect(Object.isFrozen(MEASURED_TIERS)).toBe(true);
  });
});
