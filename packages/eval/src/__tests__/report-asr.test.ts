import { describe, expect, it } from 'vitest';
import { renderAsrReport } from '../report/asr.js';
import { buildTiersFile, diffTiers, type TiersFile } from '../results/tiers.js';
import type { AsrRunResult, LanguageResult } from '../runner.js';

/**
 * The report's contract is an ordering claim: **a reader who reads only the top learns what
 * moved.** Most of what follows is that, plus the two sections that turn a threshold firing
 * into something a person can act on.
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
    cerCi95: [0.1, 0.14],
    wer: null,
    werKind: null,
    scriptIntegrity: 0.99,
    ratio: 1,
    costUsd: 0,
    cachedClips: 0,
    unmatched: 0,
    example: { id: 1, ref: 'မြန်မာစာ', hyp: 'မြန်မာစာ' },
    tier: { tier: 'beta', reason: 'measured', blockedFromVerifiedBy: ['humanReview'] },
    ...over,
  };
}

function tiersOf(languages: LanguageResult[], previous: TiersFile | null = null): TiersFile {
  const run: AsrRunResult = {
    runId: 'run-2',
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
  };
  return buildTiersFile({ run, engineVersion: 'test', previous });
}

const render = (languages: LanguageResult[], previous: TiersFile | null = null): string => {
  const tiers = tiersOf(languages, previous);
  return renderAsrReport({ tiers, previous, changes: diffTiers(previous, tiers) });
};

describe('ordering', () => {
  it('puts tier changes above everything else, including the run metadata', () => {
    const previous = tiersOf([language({ cerNospace: 0.12 })]);
    const md = render(
      [
        language({
          cerNospace: 0.9,
          tier: { tier: 'unsupported', reason: 'measured', blockedFromVerifiedBy: ['cer>0.6'] },
        }),
      ],
      previous,
    );

    const changes = md.indexOf('## Tier changes');
    const meta = md.indexOf('## Run');
    const table = md.indexOf('## Languages');
    expect(changes).toBeGreaterThan(-1);
    expect(changes).toBeLessThan(meta);
    expect(meta).toBeLessThan(table);
    expect(md).toMatch(/\| `my-MM` \| beta \| \*\*unsupported\*\* \| 0\.120 \| 0\.900 \|/u);
  });

  it('says so in one line when nothing moved', () => {
    const previous = tiersOf([language()]);
    const md = render([language()], previous);
    expect(md).toContain('No tier changes.');
  });

  it('says a first run is a first run rather than reporting every language as a promotion', () => {
    const md = render([language()]);
    expect(md).toMatch(/First run/u);
  });
});

describe('the baseline banner', () => {
  it('warns above the table when the baseline moved, and says the file was not written', () => {
    const previous = tiersOf([language({ cerNospace: 0.12 })]);
    const md = render([language({ cerNospace: 0.4 })], previous);
    expect(md).toContain('Baseline suspect');
    expect(md).toContain('**not written**');
    expect(md.indexOf('Baseline suspect')).toBeLessThan(md.indexOf('## Languages'));
  });

  it('is absent when the baseline held', () => {
    expect(render([language()])).not.toContain('Baseline suspect');
  });
});

describe('the sections that make a threshold actionable', () => {
  /**
   * `0.02` says a threshold fired. The romanized string beside the Burmese it should have
   * been says what the provider did.
   */
  it('prints a script-integrity failure verbatim, both sides, un-normalized', () => {
    const md = render([
      language({
        scriptIntegrity: 0.02,
        cerNospace: 0.97,
        example: { id: 7, ref: 'အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက်', hyp: 'ASEAN YAK SOMPHA CHHA KOO' },
        tier: { tier: 'unsupported', reason: 'script-integrity', blockedFromVerifiedBy: ['scriptIntegrity<0.8'] },
      }),
    ]);
    expect(md).toContain('ASEAN YAK SOMPHA CHHA KOO');
    expect(md).toContain('အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက်');
  });

  it('names what each language still needs, as a work queue', () => {
    const md = render([language()]);
    expect(md).toContain('## Blocked from verified');
    expect(md).toMatch(/\| `my-MM` \| beta \| `humanReview` \|/u);
  });

  /** Amendment 68: a Burmese CER is a measurement of female speech, and the report says so. */
  it('prints the sample composition beside the numbers, not only in the JSON', () => {
    const md = render([language()]);
    expect(md).toContain('## What these samples are');
    expect(md).toMatch(/`my-MM` — Every clip in this sample is FEMALE/u);
  });

  it('states that integrity is a screen even when nothing failed', () => {
    const md = render([language()]);
    expect(md).toMatch(/screen.*not a/su);
  });
});

describe('the caveats', () => {
  it('repeats the methodology boilerplate in every report', () => {
    const md = render([language()]);
    expect(md).toContain('FLEURS is read Wikipedia sentences');
    expect(md).toContain('overstates');
    expect(md).toContain('It can never award `verified`');
  });

  /**
   * A whitespace-tokenized WER for Burmese would be a different quantity wearing the same
   * column heading, so the cell says why it is empty rather than leaving a blank.
   */
  it('explains an empty WER rather than printing a blank cell', () => {
    const md = render([language()]);
    expect(md).toContain('*(no word segmentation)*');
  });

  it('labels which segmentation a WER came from', () => {
    const md = render([language({ languageCode: 'ha-NG', wer: 0.4, werKind: 'spaces' })]);
    expect(md).toContain('0.400 *(spaces)*');
  });
});
