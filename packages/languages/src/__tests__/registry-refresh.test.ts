import { describe, expect, it } from 'vitest';
import { createRegistry, listLanguages, resolveLanguage } from '../registry.js';

/**
 * `createRegistry` must not be a disguised singleton. The CLI builds one from the DB, the
 * worker refreshes its own on NOTIFY (Phase 9), and tests build one from a fixture array.
 * A module-global cache would let any of those see another's tiers, which would make a
 * test's fixture override leak into the next test and — far worse — make the worker's
 * refresh visible to a request already in flight.
 */
/**
 * `UNMEASURED` — a language the eval harness has never run, so its resolved tier is the
 * seeded one and stays put no matter what the last sweep measured.
 *
 * These tests used `ha-NG` and asserted the literal `experimental` it is seeded with. That
 * held until the first n=30 sweep measured Hausa at CER 0.059 and the registry started
 * resolving it to `beta` — correctly, and three isolation tests went red for a reason that
 * had nothing to do with isolation. **A test about override precedence must not depend on
 * which languages somebody happened to measure last.**
 */
const UNMEASURED = 'af-ZA';

describe('registry isolation', () => {
  it('does not share state between registries', () => {
    const beta = createRegistry([{ code: UNMEASURED, tier: 'beta', cer: 0.15 }]);
    const plain = createRegistry();

    expect(beta.get(UNMEASURED)!.tier).toBe('beta');
    expect(plain.get(UNMEASURED)!.tier).toBe('experimental');
    expect(plain.get(UNMEASURED)!.support.cer).toBeNull();

    // Read order must not matter either — a cache populated by one must not serve another.
    expect(beta.get(UNMEASURED)!.tier).toBe('beta');
  });

  it('leaves the static convenience helpers unaffected', () => {
    createRegistry([{ code: UNMEASURED, tier: 'verified' }]);
    expect(resolveLanguage(UNMEASURED)!.tier).toBe('experimental');
    /**
     * **Nothing is verified from the static layer alone, and that is a change.** `my-MM`
     * was the one seeded `verified` language; the 2026-08-13 sweep measured it, and a
     * measurement supersedes a seed. It came out `beta`, blocked by `humanReview` — the
     * harness cannot award `verified` and never could. The route back is a real sign-off in
     * `results/human-review/my-MM.json` naming the current run, written by a person, or a
     * `language_support` row set by an admin who has decided for their own instance.
     */
    expect(listLanguages({ tier: ['verified'] }).map((l) => l.code)).toEqual([]);
  });

  it('replaces overrides on refresh without rebuilding the static layer', () => {
    const registry = createRegistry([{ code: UNMEASURED, tier: 'beta' }]);
    expect(registry.get(UNMEASURED)!.tier).toBe('beta');

    registry.refresh([{ code: 'yo-NG', tier: 'beta' }]);
    // The old override is gone, not merged — refresh replaces the whole layer.
    expect(registry.get(UNMEASURED)!.tier).toBe('experimental');
    expect(registry.get('yo-NG')!.tier).toBe('beta');
    // Static data survived.
    expect(registry.list().length).toBeGreaterThanOrEqual(116);
    expect(registry.get('my-MM')!.typography.lineHeight).toBe(1.9);
  });

  it('exposes the generation date', () => {
    expect(createRegistry().generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
