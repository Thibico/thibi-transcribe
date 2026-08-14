import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LANGUAGES } from '@thibi/languages';
import type { CleanupLanguageResult, CleanupRunResult } from '../llm/cleanup.js';
import { GATE_LIMITS, type GateFailure } from '../llm/gate.js';
import type { TranslateRunResult } from '../llm/translate.js';

/**
 * `results/reports/llm-YYYY-MM-DD.md`.
 *
 * Deliberately diffable against the research table it reproduces — same row order, same
 * columns — and deliberately unable to *quote* it. The research reports Yoruba at 0.148 for
 * the current prompt and an 87.0 translation ceiling; this file prints what this run measured
 * and nothing else, because a report that carries a number nobody here observed is a report
 * that will be read as evidence. The ordering is the claim worth checking, not the magnitudes:
 * different models, different `n`.
 *
 * The examples are the point of the file. A reviewer reading an LLM report should see the
 * actual damaged strings, not only rates — `content_delta 0.004` is a rule being approached,
 * and `UN tún ní ìrètí… → Wọ́n tún ní ìrètí…` is a quotation being altered.
 */

/**
 * One path per eval kind, not one per day. Both LLM evals produce a dated markdown file and
 * a shared `llm-<date>.md` would mean a translation run silently replacing the morning's
 * cleanup report — with the gate's evidence in it.
 */
export const llmReportPath = (
  resultsDir: string,
  date: string,
  kind: 'cleanup' | 'translate',
): string => join(resultsDir, 'reports', `llm-${kind}-${date}.md`);

export async function writeLlmReport(
  resultsDir: string,
  date: string,
  kind: 'cleanup' | 'translate',
  markdown: string,
): Promise<string> {
  const path = llmReportPath(resultsDir, date, kind);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, 'utf8');
  return path;
}

const num = (v: number | null, digits = 3) => (v === null ? '—' : v.toFixed(digits));

export interface CleanupReportInput {
  run: CleanupRunResult;
  failures: readonly GateFailure[];
  /** True when `--gate` was passed. Without it the same numbers report and the run exits 0. */
  gated: boolean;
}

export function renderCleanupReport(input: CleanupReportInput): string {
  const { run, failures } = input;
  const date = run.finishedAt.slice(0, 10);
  const out: string[] = [];

  out.push(`# Cleanup eval — ${date}`);
  out.push('');

  // The verdict first, before the metadata and before the table, for the same reason tier
  // changes lead the ASR report: a reader who reads only the top of the file must still learn
  // the thing that matters.
  out.push('## Verdict', '');
  if (!input.gated) {
    out.push(
      'Run without `--gate`, so nothing was enforced. The conditions are evaluated anyway and',
      'listed below; local iteration is not a fight, but CI runs the same command with the flag.',
      '',
    );
  }
  if (failures.length === 0) {
    out.push('Every arm is at or below its do-nothing control, within tolerance on both', 'contract metrics.', '');
  } else {
    out.push(`| language | arm | metric | value | against | delta |`);
    out.push('|---|---|---|---|---|---|');
    for (const f of failures) {
      out.push(
        `| \`${f.code}\` | ${f.arm}${f.model ? `/${f.model}` : ''} | ${f.metric} | ` +
          `${num(f.value, 4)} | ${num(f.against, 4)} | ${num(f.delta, 4)} |`,
      );
    }
    out.push('');
  }

  out.push('## Run', '');
  out.push(`- \`${run.runId}\``);
  out.push(`- provider **${run.provider}**, models ${run.models.map((m) => `\`${m}\``).join(', ')}`);
  out.push(`- arms ${run.arms.join(', ')} · split ${run.split} · n=${run.n} · seed ${run.seed}`);
  out.push(`- spent $${run.spentUsd.toFixed(4)}`);
  out.push('');

  for (const language of run.languages) {
    out.push(...languageSection(language));
  }

  out.push(...cleanupMethodology());
  return `${out.join('\n').trimEnd()}\n`;
}

function languageSection(language: CleanupLanguageResult): string[] {
  const name = LANGUAGES[language.languageCode]?.nameEn ?? language.languageCode;
  const out = [`## \`${language.languageCode}\` — ${name}`, ''];

  if (language.error) {
    out.push(`${language.error}`, '');
    return out;
  }
  if (language.cfg === null) {
    out.push('No FLEURS eval set for this language, so there is nothing to score against.', '');
    return out;
  }

  out.push(`${language.n} segment(s), ${language.distinctIds} distinct sentence id(s).`, '');
  out.push('| arm | model | cer_punct | ci95 | content_delta | entity_drift | length_delta | rewritten | failed |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const arm of language.arms) {
    const ci = arm.cerPunctCi95 ? `[${num(arm.cerPunctCi95[0])}, ${num(arm.cerPunctCi95[1])}]` : '—';
    out.push(
      `| ${arm.arm === 'control' ? '**control**' : arm.arm} | ${arm.model || '—'} | ` +
        `${num(arm.cerPunct)} | ${ci} | ${num(arm.contentDelta, 4)} | ${num(arm.entityDrift, 4)} | ` +
        `${num(arm.lengthDelta, 4)} | ${arm.rewritten}/${arm.n} | ${arm.failed} |`,
    );
  }
  out.push('');

  for (const arm of language.arms) {
    if (arm.arm === 'control' || arm.examples.length === 0) continue;
    out.push(`**${arm.arm}${arm.model ? `/${arm.model}` : ''} — segments it rewrote**`, '');
    if (arm.entitiesLost.length > 0) {
      out.push(`Entity tokens that left the text: ${arm.entitiesLost.map((t) => `\`${t}\``).join(', ')}`, '');
    }
    for (const ex of arm.examples) {
      out.push(`- id ${ex.id}`);
      out.push(`  - in : ${ex.input}`);
      out.push(`  - out: ${ex.output}`);
    }
    out.push('');
  }
  return out;
}

function cleanupMethodology(): string[] {
  return [
    '## Methodology',
    '',
    '- Input is FLEURS column 3 (`transcription`, lowercased and unpunctuated); the reference',
    '  is column 2 (`raw_transcription`, punctuated and cased). Scored with punctuation kept',
    '  and case preserved, which is the one place in this harness that happens.',
    `- **\`content_delta\` is a contract check, not a quality score.** Both sides are stripped of`,
    '  punctuation, case and whitespace; a compliant pass leaves them identical, so the value',
    `  must be 0.000. The gate tolerates ${GATE_LIMITS.contentDelta} only because Unicode`,
    '  normalization differs across providers — about one character in two hundred.',
    '- `entity_drift` is the multiset symmetric difference over ALL-CAPS runs, digit strings',
    '  and — in a non-Latin script — Latin tokens. It is what names an acronym being replaced',
    `  by a pronoun; raw CER moves by two characters for that edit. Gate: ${GATE_LIMITS.entityDrift}.`,
    '- The pass condition is **beating the do-nothing control, per language**, not clearing a',
    '  threshold. Thresholds get tuned until they pass; a control cannot be.',
    '- FLEURS is read Wikipedia sentences — clean, careful, single-speaker, no code-switching.',
    '  Every number here overstates newsroom performance.',
    '',
  ];
}

export function renderTranslateReport(run: TranslateRunResult): string {
  const date = run.finishedAt.slice(0, 10);
  const out: string[] = [];
  out.push(`# Translation eval — ${date}`);
  out.push('');
  out.push('## Run', '');
  out.push(`- \`${run.runId}\``);
  out.push(`- provider **${run.provider}**, models ${run.models.map((m) => `\`${m}\``).join(', ')}`);
  out.push(`- target **${run.target}** · split ${run.split} · n=${run.n} · seed ${run.seed}`);
  out.push(`- spent $${run.spentUsd.toFixed(4)}`);
  out.push('');

  out.push('## chrF2', '');
  out.push(`| language | role | joined | n | ${run.models.map((m) => `\`${m}\``).join(' | ')} |`);
  out.push(`|---|---|---|---|${run.models.map(() => '---').join('|')}|`);
  // Ceiling first, then the bar, then everything else: the two rows that tell a reader how to
  // read the rest belong above the rest.
  const order = { ceiling: 0, bar: 1, measured: 2 } as const;
  const rows = [...run.languages].sort((a, b) => order[a.role] - order[b.role]);
  for (const l of rows) {
    if (l.error) {
      out.push(`| \`${l.languageCode}\` | ${l.role} | — | — | ${run.models.map(() => l.error).join(' | ')} |`);
      continue;
    }
    const cells = run.models.map((m) => {
      const arm = l.arms.find((a) => a.model === m);
      return arm ? num(arm.chrf2, 1) : '—';
    });
    out.push(`| \`${l.languageCode}\` | ${l.role} | ${l.joined} | ${l.n} | ${cells.join(' | ')} |`);
  }
  out.push('');

  const ceiling = rows.find((l) => l.role === 'ceiling')?.arms[0]?.chrf2 ?? null;
  const bar = rows.find((l) => l.role === 'bar')?.arms[0]?.chrf2 ?? null;
  out.push('## How to read this', '');
  out.push(
    `- The **ceiling** row is \`${run.target}\` translated into itself: ${num(ceiling, 1)} on this`,
    '  run. It is not 100 because the model rewords, and it is the reason a score of 72 must',
    '  not be read as "72% correct".',
    `- The **bar** row is the language already in production: ${num(bar, 1)}. A language at or`,
    '  above it is at the quality this product already ships.',
    '- Both are measured here rather than quoted from the research that motivated this eval.',
    '  Magnitudes will differ from that table — different models, different `n`; the ordering',
    '  is what is worth checking.',
    '- `joined` is the inner join on FLEURS `id` after deduping both sides; `n` is the sample',
    '  taken from it. Both are smaller than either split.',
    '- No gate. Translation quality is a language property, not a regression surface.',
    '',
  );
  return `${out.join('\n').trimEnd()}\n`;
}
