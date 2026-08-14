import type { CleanupArmResult, CleanupRunResult } from './cleanup.js';

/**
 * The CI gate — Phase 5 §5.10.
 *
 * Three conditions, and the first is the one that matters: **an arm that is worse than doing
 * nothing fails.** That is a comparison against a control measured in the same run, not a
 * threshold, and the difference is the whole design. Thresholds get tuned until they pass. A
 * control cannot be.
 *
 * Without `--gate` the same run reports and exits 0, so local iteration is not a fight.
 */
export const GATE_LIMITS = {
  /**
   * ~1 character in 200. Not zero only because Unicode normalization differences across
   * providers are real; anything above this is the arm having rewritten content, by
   * definition, with no argument available about whether the rewrite was an improvement.
   */
  contentDelta: 0.005,
  /** Named entities moved. `UN → Wọ́n` is one token in a short sentence. */
  entityDrift: 0.02,
} as const;

export type GateMetric =
  | 'cer_punct'
  | 'content_delta'
  | 'entity_drift'
  | 'control_missing'
  | 'not_measured';

export interface GateFailure {
  code: string;
  arm: string;
  model: string;
  metric: GateMetric;
  /** The arm's value. Null only for `control_missing`. */
  value: number | null;
  /** What it was judged against: the control's CER, or the fixed tolerance. */
  against: number | null;
  delta: number | null;
  /** The worst pair this arm produced, so a failure names a string and not only a number. */
  example: { id: number; input: string; output: string } | null;
  entitiesLost: readonly string[];
  /** Why a language went unmeasured: the run's error, or the provider's own words. */
  reason?: string;
}

export function gateCleanup(run: CleanupRunResult): GateFailure[] {
  const failures: GateFailure[] = [];
  const wanted = run.arms.filter((a) => a !== 'control');

  for (const language of run.languages) {
    // A language with no eval set is a fact about FLEURS, not a failure to measure: the ASR
    // command exits 0 on the five Google locales that have none, and so does this.
    if (language.cfg === null && !language.error) continue;

    /**
     * A language the run asked for and did not measure fails the gate.
     *
     * Measured 2026-08-14, and it is the failure this whole mechanism exists to prevent. A
     * six-language run lost five languages to one rate-limit error each and one to a 400,
     * so every language ended with zero arms — and the gate printed **"pass — every arm is
     * at or below its control"** and exited 0, because it had nothing to compare and
     * skipped them all. A gate that treats "nothing measured" as "nothing wrong" is a green
     * check over an unmeasured prompt.
     */
    const scoredCandidates = language.arms.filter((a) => a.arm !== 'control' && a.n > 0);
    if (wanted.length > 0 && scoredCandidates.length < wanted.length * run.models.length) {
      const reason =
        language.error ?? language.arms.find((a) => a.failure !== undefined)?.failure;
      failures.push({
        code: language.languageCode,
        arm: wanted.join(','),
        model: run.models.join(','),
        metric: 'not_measured',
        value: null,
        against: null,
        delta: null,
        example: null,
        entitiesLost: [],
        ...(reason === undefined ? {} : { reason }),
      });
      continue;
    }

    const control = language.arms.find((a) => a.arm === 'control');
    const candidates = language.arms.filter((a) => a.arm !== 'control');
    if (candidates.length === 0) continue;

    if (!control || control.cerPunct === null) {
      /**
       * A gate that silently passes when its comparison is missing is worse than no gate: the
       * run still exits 0 and the report still prints numbers. `--arms restraint` alone is a
       * legitimate thing to *ask* for and an illegitimate thing to gate on.
       */
      failures.push({
        code: language.languageCode,
        arm: candidates[0]!.arm,
        model: candidates[0]!.model,
        metric: 'control_missing',
        value: null,
        against: null,
        delta: null,
        example: null,
        entitiesLost: [],
      });
      continue;
    }

    for (const arm of candidates) {
      const at = (metric: GateMetric, value: number | null, against: number | null): GateFailure => ({
        code: language.languageCode,
        arm: arm.arm,
        model: arm.model,
        metric,
        value,
        against,
        delta: value !== null && against !== null ? value - against : null,
        example: worstExample(arm),
        entitiesLost: arm.entitiesLost,
      });

      if (arm.cerPunct !== null && arm.cerPunct > control.cerPunct) {
        failures.push(at('cer_punct', arm.cerPunct, control.cerPunct));
      }
      if (arm.contentDelta !== null && arm.contentDelta > GATE_LIMITS.contentDelta) {
        failures.push(at('content_delta', arm.contentDelta, GATE_LIMITS.contentDelta));
      }
      if (arm.entityDrift !== null && arm.entityDrift > GATE_LIMITS.entityDrift) {
        failures.push(at('entity_drift', arm.entityDrift, GATE_LIMITS.entityDrift));
      }
    }
  }

  // Worst first, so a truncated terminal still shows the largest regression.
  return failures.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
}

function worstExample(arm: CleanupArmResult): GateFailure['example'] {
  return arm.examples[0] ?? null;
}

const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(4));

/**
 * What a failing gate prints.
 *
 * Both numbers and the delta, then the offending pair in full. A CI log that says
 * "content_delta 0.012 > 0.005" tells a reader a rule was broken; the pair tells them which
 * word the model changed, which is the only form of that message anyone can act on.
 */
export function formatGateFailures(failures: readonly GateFailure[]): string {
  if (failures.length === 0) return 'gate: pass — every arm is at or below its control.';
  const out: string[] = [`gate: FAIL — ${failures.length} condition(s)`, ''];
  for (const f of failures) {
    if (f.metric === 'not_measured') {
      out.push(
        `  ${f.code}  asked for ${f.arm} and measured nothing. A gate cannot pass a language ` +
          `it did not measure.`,
      );
      if (f.reason) out.push(`    ${f.reason}`);
      out.push('');
      continue;
    }
    if (f.metric === 'control_missing') {
      out.push(
        `  ${f.code}  ${f.arm}: no control arm in this run. The gate compares against a ` +
          `do-nothing control measured in the same run; add \`control\` to --arms.`,
      );
      out.push('');
      continue;
    }
    const how =
      f.metric === 'cer_punct'
        ? `cer_punct ${fmt(f.value)} vs control ${fmt(f.against)} (+${fmt(f.delta)}) — worse than doing nothing`
        : `${f.metric} ${fmt(f.value)} > ${fmt(f.against)} (+${fmt(f.delta)})`;
    out.push(`  ${f.code}  ${f.arm}${f.model ? `/${f.model}` : ''}: ${how}`);
    if (f.entitiesLost.length > 0) {
      out.push(`    entities that left the text: ${f.entitiesLost.join(', ')}`);
    }
    if (f.example) {
      out.push(`    in : ${f.example.input}`);
      out.push(`    out: ${f.example.output}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
