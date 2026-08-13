import { describe, expect, it } from 'vitest';
import { assignTier, THRESHOLDS, type TierInput } from '../tier.js';

/**
 * A language that clears every verified gate, so each case below can break exactly one.
 *
 * The interval is deliberately tight. §5.9 requires `ciHi / baseline ≤ 1.15` as well as
 * `ciHi ≤ 0.20`, so a CI whose upper bound sits 20% above its own point estimate fails
 * — which is the whole point of gating on the interval, and is what a first draft of this
 * fixture got wrong.
 */
const perfect: TierInput = {
  cerNospace: 0.1,
  ci95: [0.092, 0.11],
  ratio: 1.0,
  scriptIntegrity: 0.99,
  n: 30,
  humanReview: { by: 'someone', at: '2026-08-13' },
};

describe('assignTier ordering', () => {
  /**
   * The order is the design. A flattering CER with broken script integrity must come out
   * unsupported — Groq's romanized Burmese is the case this exists for, and testing
   * integrity after the error rate is how it would reach a newsroom as `verified`.
   */
  it('puts script integrity ahead of a good error rate', () => {
    const r = assignTier({ ...perfect, cerNospace: 0.1, scriptIntegrity: 0.3 });
    expect(r.tier).toBe('unsupported');
    expect(r.reason).toBe('script-integrity');
  });

  it('marks a rejected code unsupported without needing any numbers', () => {
    const r = assignTier({
      cerNospace: null,
      ci95: null,
      ratio: null,
      scriptIntegrity: null,
      n: 0,
      codeRejected: true,
    });
    expect(r.tier).toBe('unsupported');
    expect(r.reason).toBe('code-rejected');
  });

  /**
   * FLEURS not carrying a language says nothing about whether the provider can transcribe
   * it. Conflating the two would mark five working Google locales as broken.
   */
  it('treats a missing eval set as experimental, not unsupported', () => {
    const r = assignTier({
      cerNospace: null,
      ci95: null,
      ratio: null,
      scriptIntegrity: null,
      n: 0,
      noEvalSet: true,
    });
    expect(r.tier).toBe('experimental');
    expect(r.reason).toBe('no-eval-set');
    expect(r.blockedFromVerifiedBy).toEqual(['no-eval-set']);
  });

  it('distinguishes not-run from measured-and-bad', () => {
    const r = assignTier({ ...perfect, cerNospace: null, ci95: null });
    expect(r.reason).toBe('not-run');
  });
});

describe('assignTier boundaries', () => {
  it('assigns verified only when every gate passes', () => {
    const r = assignTier(perfect);
    expect(r.tier).toBe('verified');
    expect(r.blockedFromVerifiedBy).toEqual([]);
  });

  it('refuses verified without human review, and says so', () => {
    const r = assignTier({ ...perfect, humanReview: null });
    expect(r.tier).toBe('beta');
    expect(r.blockedFromVerifiedBy).toContain('humanReview');
  });

  /**
   * The interval, not the point estimate. At n=30 the point estimate clears the line long
   * before the interval does, which is the mechanical reason verified also needs a human.
   */
  it('blocks on the CI upper bound even when the point estimate passes', () => {
    const r = assignTier({ ...perfect, cerNospace: 0.19, ci95: [0.15, 0.28] });
    expect(r.tier).toBe('beta');
    expect(r.blockedFromVerifiedBy).toContain(`ciHi>${THRESHOLDS.verifiedCer}`);
  });

  it('blocks on n below the minimum', () => {
    const r = assignTier({ ...perfect, n: 5 });
    expect(r.blockedFromVerifiedBy).toContain(`n<${THRESHOLDS.verifiedMinN}`);
    expect(r.tier).toBe('beta');
  });

  it('blocks on ratio to the baseline', () => {
    const r = assignTier({ ...perfect, ratio: 1.5 });
    expect(r.blockedFromVerifiedBy).toContain(`ratio>${THRESHOLDS.verifiedRatio}`);
  });

  it('assigns beta inside the beta bounds', () => {
    const r = assignTier({ ...perfect, cerNospace: 0.3, ci95: [0.26, 0.34], ratio: 1.9, n: 30 });
    expect(r.tier).toBe('beta');
  });

  it('drops to experimental beyond the beta bounds but below unsupported', () => {
    const r = assignTier({ ...perfect, cerNospace: 0.45, ci95: [0.4, 0.5], ratio: 3.0 });
    expect(r.tier).toBe('experimental');
    expect(r.reason).toBe('measured');
  });

  it('assigns unsupported above the CER ceiling', () => {
    const r = assignTier({ ...perfect, cerNospace: 0.7, ci95: [0.65, 0.75], ratio: 5 });
    expect(r.tier).toBe('unsupported');
    expect(r.reason).toBe('measured');
  });

  it('treats an absent interval as failing the interval gate', () => {
    const r = assignTier({ ...perfect, ci95: null });
    expect(r.blockedFromVerifiedBy).toContain('ciHi>0.20');
    expect(r.tier).toBe('beta');
  });

  /**
   * The first real measurement, 2026-08-13: Burmese, Google `chirp_2`, n=5, CER 0.072.
   *
   * `beta`, and the three blockers are worth reading rather than just asserting. `n<30` and
   * `humanReview` are expected. **`ciHiRatio>1.15` is the interesting one**: at n=5 the
   * interval runs [0.019, 0.122], so its upper bound is 1.7× the point estimate, and the
   * gate that compares the *interval* against the baseline catches what a 7.2% CER on its
   * own would not — five clips do not establish a language, however good the number looks.
   */
  it('tiers the first real Burmese measurement the way the run reported it', () => {
    const r = assignTier({
      cerNospace: 0.072,
      ci95: [0.019, 0.122],
      ratio: 1.0,
      scriptIntegrity: 1.0,
      n: 5,
      humanReview: null,
    });
    expect(r.tier).toBe('beta');
    expect(r.blockedFromVerifiedBy.sort()).toEqual(['ciHiRatio>1.15', 'humanReview', 'n<30']);
  });
});
