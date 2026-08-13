import { LANGUAGES, PROVIDER_MATRIX } from './generated/registry.gen.js';
import { hasMeasurement, measuredTier } from './tiers.js';
import type { ProviderId, ProviderLanguageCapability, Tier } from './types.js';

/**
 * Which provider should transcribe this language, and **why**.
 *
 * The `reason` is not decoration. A silent provider choice is a support ticket: someone gets
 * a bad Burmese transcript, cannot tell which of four providers produced it, and concludes
 * the product is broken. Every path through this function populates `reason`, the CLI prints
 * it on every run, and it is stored in `runs.pipeline`.
 *
 * This lives in `@thibi/languages` rather than the engine because the picker in Phase 11 has
 * to render the same decision, from a browser, without importing a provider.
 */

/** Ranking within the codes a provider will accept. Lower is better. */
const PROVIDER_RANK: Record<ProviderId, number> = {
  // First for anything, and by a wide margin for the 44-code set that no OpenAI model
  // accepts — which is the product.
  google: 0,
  openai: 1,
  'faster-whisper': 2,
  // Last of the four. Not because it is slow (it is by far the fastest and cheapest) but
  // because it is the one provider measured returning fluent-looking non-words, and a
  // ranking that put speed first would hand a newsroom exactly that.
  groq: 3,
};

export interface ChooseOptions {
  /** Word timestamps are required unless the caller says otherwise. */
  requireWordTimestamps?: boolean;
  /** An explicit `--provider`, or a project default. Honoured over everything but support. */
  force?: ProviderId;
  /** Soft preference — consulted after `force`, before the default ranking. */
  prefer?: readonly ProviderId[];
  /**
   * Return a provider the matrix marks unsupported, with the reason saying so.
   *
   * This exists for one genuinely useful case: `--force-unsupported` reproducing the Groq
   * Burmese failure on demand. Being able to re-run the finding the product is built on,
   * without editing data, is worth a flag.
   */
  allowUnsupported?: boolean;
}

export interface ProviderChoice {
  providerId: ProviderId;
  /** Null when the provider has no model recorded — the caller falls back to its default. */
  model: string | null;
  tier: Tier;
  reason: string;
  /** True when this provider is only reachable because `allowUnsupported` was set. */
  forcedUnsupported: boolean;
  capability: ProviderLanguageCapability;
}

/**
 * Whether a capability is good enough to choose on its own.
 *
 * `verdict: 'suspected'` passes here but is ranked behind anything settled, and always says
 * so in the reason. The doctrine is in `data/matrix-overrides.json` and it is deliberate:
 * marking a whole language family unsupported on a hunch is the same error as marking it
 * supported on a status code, in the other direction. Phase 5 promotes or demotes them one
 * measurement at a time.
 */
function isUsable(capability: ProviderLanguageCapability | undefined): boolean {
  return Boolean(capability?.supported);
}

function describe(
  code: string,
  providerId: ProviderId,
  capability: ProviderLanguageCapability,
): string {
  if (!capability.supported) {
    const because =
      capability.status === 'accepted'
        ? `the API accepts ${capability.providerCode} and returns unusable output`
        : `the API rejects ${capability.providerCode}`;
    return `${providerId} is marked unsupported for ${code}: ${because} (${capability.reason ?? capability.verdict}, probed ${capability.probedAt})`;
  }
  if (capability.verdict === 'suspected') {
    return `${providerId} accepts ${code} but the quality is unverified — ${capability.reason ?? 'no measurement yet'}`;
  }
  if (capability.verdict === 'measured-ok') {
    return `${providerId} is measured working for ${code}`;
  }
  return `${providerId} accepts ${code}; quality unmeasured (probed ${capability.probedAt})`;
}

export function chooseProvider(code: string, options: ChooseOptions = {}): ProviderChoice | null {
  const row = PROVIDER_MATRIX[code];
  const language = LANGUAGES[code];
  if (!row || !language) return null;

  const build = (providerId: ProviderId, prefix: string): ProviderChoice | null => {
    const capability = row[providerId];
    if (!capability) return null;
    const usable = isUsable(capability);
    if (!usable && !options.allowUnsupported) return null;
    // Word timestamps are a hard filter, not a preference: a subtitle workflow that silently
    // received interpolated timings would look like a timing bug in the editor.
    if (options.requireWordTimestamps && capability.wordTimestamps === false) return null;
    return {
      providerId,
      model: capability.models?.[0] ?? null,
      /**
       * The **measured** tier where one exists, falling back to the seed.
       *
       * This read `language.seed.tier` until 2026-08-13, which meant the picker reported a
       * seeded guess while `resolveLanguage` reported a measurement — two answers to the
       * same question, in one package, differing exactly when a measurement had been taken.
       * `hasMeasurement` rather than `measuredTier` alone, for the reason in `tiers.ts`: the
       * unmeasured fallback answers "what has been measured", and using it as a tier would
       * demote every language on a checkout that has never run an eval.
       */
      tier: hasMeasurement(code) ? measuredTier(code).tier : language.seed.tier,
      reason: `${prefix}; ${describe(code, providerId, capability)}`,
      forcedUnsupported: !usable,
      capability,
    };
  };

  if (options.force) {
    // An explicit choice is honoured or refused, never quietly replaced. Substituting a
    // different provider for the one someone named is how an eval sweep silently measures
    // the wrong thing.
    return build(options.force, 'chosen explicitly');
  }

  for (const preferred of options.prefer ?? []) {
    const choice = build(preferred, 'preferred by the caller');
    if (choice) return choice;
  }

  const candidates = (Object.keys(row) as ProviderId[])
    .filter((id) => isUsable(row[id]))
    .filter((id) => !(options.requireWordTimestamps && row[id]!.wordTimestamps === false))
    .sort((a, b) => {
      // Settled verdicts before suspected ones, then the fixed provider ranking. Sorting on
      // the verdict first is what keeps a `suspected` Groq row from outranking a plain
      // `probe-only` Google one on a code where both are nominally supported.
      const suspect = Number(row[a]!.verdict === 'suspected') - Number(row[b]!.verdict === 'suspected');
      if (suspect !== 0) return suspect;
      return PROVIDER_RANK[a] - PROVIDER_RANK[b];
    });

  const best = candidates[0];
  if (!best) return null;
  return build(best, 'the highest-ranked provider that supports this language');
}

export interface ProviderRow {
  providerId: ProviderId;
  model: string | null;
  status: string;
  wordTimestamps: boolean | null;
  wordConfidence: 'yes' | 'no' | 'unknown';
  capability: ProviderLanguageCapability;
}

/**
 * The per-language provider table `thibi providers list --language <code>` renders.
 *
 * `wordConfidence` is a fact about the provider rather than the language, and it is the
 * column most worth printing: exactly one provider in this system returns a genuine per-word
 * probability, and every UI that shows a low-confidence marker has to know which.
 */
export function providerRows(code: string): ProviderRow[] {
  const row = PROVIDER_MATRIX[code];
  if (!row) return [];

  return (Object.keys(row) as ProviderId[])
    .sort((a, b) => PROVIDER_RANK[a] - PROVIDER_RANK[b])
    .map((providerId) => {
      const capability = row[providerId]!;
      return {
        providerId,
        model: capability.supported ? (capability.models?.[0] ?? null) : null,
        status: statusLabel(code, capability),
        wordTimestamps: capability.wordTimestamps,
        wordConfidence: wordConfidenceOf(providerId),
        capability,
      };
    });
}

function statusLabel(_code: string, capability: ProviderLanguageCapability): string {
  if (!capability.supported) {
    return capability.status === 'accepted'
      ? `unsupported — accepted but mangles (${capability.probedAt})`
      : `unsupported — code not accepted`;
  }
  if (capability.verdict === 'suspected') return 'accepted — quality unverified';
  if (capability.verdict === 'measured-ok') return 'measured working';
  return `accepted — quality unmeasured (${capability.probedAt})`;
}

/**
 * Per-word confidence, per provider.
 *
 * - `google` — **unknown here on purpose.** Spike S2 measured it genuine (101/101 words,
 *   101 distinct values, calibrated across languages), but that is a fact about the *engine's*
 *   Google adapter and this package must not encode a provider's runtime capability. The CLI
 *   overlays the real answer from `provider.capabilities()`.
 * - `openai` / `groq` — no. `exp(avg_logprob)` is a segment-level likelihood; there is no
 *   per-word number in the response.
 * - `faster-whisper` — yes, once Phase 4b lands it: `word.probability` is the only genuine
 *   per-word probability in the system.
 */
function wordConfidenceOf(providerId: ProviderId): 'yes' | 'no' | 'unknown' {
  if (providerId === 'openai' || providerId === 'groq') return 'no';
  if (providerId === 'faster-whisper') return 'yes';
  return 'unknown';
}
