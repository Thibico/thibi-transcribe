import { describe, expect, it } from 'vitest';
import { createRegistry, listLanguages, resolveLanguage } from '../registry.js';

/**
 * `createRegistry` must not be a disguised singleton. The CLI builds one from the DB, the
 * worker refreshes its own on NOTIFY (Phase 9), and tests build one from a fixture array.
 * A module-global cache would let any of those see another's tiers, which would make a
 * test's fixture override leak into the next test and — far worse — make the worker's
 * refresh visible to a request already in flight.
 */
describe('registry isolation', () => {
  it('does not share state between registries', () => {
    const beta = createRegistry([{ code: 'ha-NG', tier: 'beta', cer: 0.15 }]);
    const plain = createRegistry();

    expect(beta.get('ha-NG')!.tier).toBe('beta');
    expect(plain.get('ha-NG')!.tier).toBe('experimental');
    expect(plain.get('ha-NG')!.support.cer).toBeNull();

    // Read order must not matter either — a cache populated by one must not serve another.
    expect(beta.get('ha-NG')!.tier).toBe('beta');
  });

  it('leaves the static convenience helpers unaffected', () => {
    createRegistry([{ code: 'ha-NG', tier: 'verified' }]);
    expect(resolveLanguage('ha-NG')!.tier).toBe('experimental');
    expect(listLanguages({ tier: ['verified'] }).map((l) => l.code)).toEqual(['my-MM']);
  });

  it('replaces overrides on refresh without rebuilding the static layer', () => {
    const registry = createRegistry([{ code: 'ha-NG', tier: 'beta' }]);
    expect(registry.get('ha-NG')!.tier).toBe('beta');

    registry.refresh([{ code: 'yo-NG', tier: 'beta' }]);
    // The old override is gone, not merged — refresh replaces the whole layer.
    expect(registry.get('ha-NG')!.tier).toBe('experimental');
    expect(registry.get('yo-NG')!.tier).toBe('beta');
    // Static data survived.
    expect(registry.list().length).toBeGreaterThanOrEqual(116);
    expect(registry.get('my-MM')!.typography.lineHeight).toBe(1.9);
  });

  it('exposes the generation date', () => {
    expect(createRegistry().generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
