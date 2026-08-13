/**
 * Tiering — turning a CER into a claim the product is willing to make.
 *
 * The order of the checks is the design, not an implementation detail. `unsupported` is
 * tested **first**, so a language with a flattering CER and broken script integrity cannot
 * come out `verified`: Groq on Burmese returns Myanmar-script non-words at integrity ~1.0
 * and romanization at integrity ~0.0, and only running the integrity gate before the error
 * gate names the second failure for what it is.
 */

export const THRESHOLDS = {
  verifiedCer: 0.2,
  verifiedRatio: 1.15,
  verifiedMinN: 30,
  betaCer: 0.35,
  betaRatio: 2.0,
  unsupportedCer: 0.6,
  minScriptIntegrity: 0.8,
} as const;

export type Tier = 'verified' | 'beta' | 'experimental' | 'unsupported';

/**
 * Why a language sits where it does.
 *
 * The UI branches on this, and the reason it is an enum rather than prose is a product
 * requirement: **"not yet measured" and "measured and bad" must never render the same.**
 */
export type TierReason =
  | 'measured'
  | 'no-eval-set'
  | 'code-rejected'
  | 'script-integrity'
  | 'not-run';

export interface TierInput {
  /** Null when nothing was measured — no eval set, or the run never reached this language. */
  cerNospace: number | null;
  /** 95% bootstrap interval on `cerNospace`. */
  ci95: readonly [number, number] | null;
  /** `cerNospace(lang) / cerNospace(baseline)`. */
  ratio: number | null;
  scriptIntegrity: number | null;
  n: number;
  /** The provider refused the language code outright. */
  codeRejected?: boolean;
  /** No FLEURS config and no manifest. */
  noEvalSet?: boolean;
  /** A human signed off. `verified` is unreachable without it, by design. */
  humanReview?: unknown;
}

export interface TierResult {
  tier: Tier;
  reason: TierReason;
  /**
   * Every verified requirement this language failed, named.
   *
   * Present even when the tier is `beta` or lower, because "why is this not verified" is the
   * question the settings page exists to answer, and recomputing it in the UI would be a
   * second implementation of these thresholds.
   */
  blockedFromVerifiedBy: string[];
}

export function assignTier(input: TierInput): TierResult {
  const {
    cerNospace,
    ci95,
    ratio,
    scriptIntegrity,
    n,
    codeRejected,
    noEvalSet,
    humanReview,
  } = input;

  if (codeRejected) {
    return { tier: 'unsupported', reason: 'code-rejected', blockedFromVerifiedBy: ['code-rejected'] };
  }
  if (noEvalSet) {
    // Experimental, not unsupported: FLEURS not carrying a language says nothing about
    // whether the provider can transcribe it. Conflating the two would mark five working
    // Google locales as broken.
    return { tier: 'experimental', reason: 'no-eval-set', blockedFromVerifiedBy: ['no-eval-set'] };
  }
  if (cerNospace === null) {
    return { tier: 'experimental', reason: 'not-run', blockedFromVerifiedBy: ['not-run'] };
  }

  // Integrity before error rate. A wrong-alphabet transcript can score a low CER by accident;
  // it is still unusable, and calling it anything but unsupported is how the romanization
  // failure reaches a newsroom.
  if (scriptIntegrity !== null && scriptIntegrity < THRESHOLDS.minScriptIntegrity) {
    return {
      tier: 'unsupported',
      reason: 'script-integrity',
      blockedFromVerifiedBy: [`scriptIntegrity<${THRESHOLDS.minScriptIntegrity}`],
    };
  }
  if (cerNospace > THRESHOLDS.unsupportedCer) {
    return {
      tier: 'unsupported',
      reason: 'measured',
      blockedFromVerifiedBy: [`cer>${THRESHOLDS.unsupportedCer}`],
    };
  }

  // Everything from here is "how good", and the blockers accumulate so the UI can say why.
  const blocked: string[] = [];
  if (ratio === null || ratio > THRESHOLDS.verifiedRatio) blocked.push(`ratio>${THRESHOLDS.verifiedRatio}`);
  if (cerNospace > THRESHOLDS.verifiedCer) blocked.push(`cer>${THRESHOLDS.verifiedCer}`);
  if (n < THRESHOLDS.verifiedMinN) blocked.push(`n<${THRESHOLDS.verifiedMinN}`);

  // The interval, not the point estimate. At n=30 the point estimate clears the line long
  // before the interval does, and that gap is the mechanical reason `verified` also needs a
  // human: the number is not yet precise enough to carry the claim on its own.
  const ciHi = ci95?.[1] ?? null;
  if (ciHi === null) blocked.push('ciHi>0.20');
  else {
    if (ciHi > THRESHOLDS.verifiedCer) blocked.push(`ciHi>${THRESHOLDS.verifiedCer}`);
    if (ratio !== null && cerNospace > 0) {
      const baseline = cerNospace / ratio;
      if (baseline > 0 && ciHi / baseline > THRESHOLDS.verifiedRatio) blocked.push('ciHiRatio>1.15');
    }
  }
  if (humanReview === null || humanReview === undefined) blocked.push('humanReview');

  if (blocked.length === 0) return { tier: 'verified', reason: 'measured', blockedFromVerifiedBy: [] };

  if (ratio !== null && ratio <= THRESHOLDS.betaRatio && cerNospace <= THRESHOLDS.betaCer) {
    return { tier: 'beta', reason: 'measured', blockedFromVerifiedBy: blocked };
  }
  return { tier: 'experimental', reason: 'measured', blockedFromVerifiedBy: blocked };
}
