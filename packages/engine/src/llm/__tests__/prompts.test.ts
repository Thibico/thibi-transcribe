import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@thibi/languages';
import {
  buildCleanupPrompt,
  buildTranslatePrompt,
  promptVars,
  UnknownLanguageError,
  CLEANUP_CURRENT,
  CLEANUP_RESTRAINT,
  CLEANUP_VERSIONS,
  TRANSLATE_DEFAULT,
  TRANSLATE_VERSION,
  type LlmPrompt,
} from '../index.js';

/**
 * Six languages, chosen so a prompt edit surfaces as a diff across the kinds of orthography
 * that actually break a clause: one non-cased scriptio continua, one Latin, one Ethiopic, one
 * RTL, one more scriptio continua, one Latin with heavy code-switching. Phase 6 §6.4's set.
 *
 * The point is that a sentence which reads fine in English is nonsense once `sentenceEnd` is
 * `።`, and reading six renderings is how anyone notices.
 */
const SNAPSHOT_CODES = ['my-MM', 'ha-NG', 'am-ET', 'ps-AF', 'km-KH', 'ceb-PH'] as const;

const SEGMENTS = [
  { idx: 0, text: 'the first segment' },
  { idx: 1, text: 'the second' },
];

const here = fileURLToPath(new URL('.', import.meta.url));

const cleanup = (code: string, variant: typeof CLEANUP_CURRENT | typeof CLEANUP_RESTRAINT) =>
  buildCleanupPrompt({ vars: promptVars(code), segments: SEGMENTS, variant });

const translate = (code: string) =>
  buildTranslatePrompt({
    source: promptVars(code),
    target: promptVars('en-US'),
    segments: SEGMENTS,
  });

const BUILDERS: Record<string, (code: string) => LlmPrompt> = {
  [CLEANUP_CURRENT]: (code) => cleanup(code, CLEANUP_CURRENT),
  [CLEANUP_RESTRAINT]: (code) => cleanup(code, CLEANUP_RESTRAINT),
  [TRANSLATE_DEFAULT]: translate,
};

const VERSIONS: Record<string, number> = {
  [CLEANUP_CURRENT]: CLEANUP_VERSIONS[CLEANUP_CURRENT],
  [CLEANUP_RESTRAINT]: CLEANUP_VERSIONS[CLEANUP_RESTRAINT],
  [TRANSLATE_DEFAULT]: TRANSLATE_VERSION,
};

describe('prompt snapshots', () => {
  for (const promptId of Object.keys(BUILDERS)) {
    for (const code of SNAPSHOT_CODES) {
      it(`${promptId} renders for ${code}`, async () => {
        const built = BUILDERS[promptId]!(code);
        // Beside the prompts rather than beside the test, because the diff a reviewer needs
        // is the one next to the text that produced it — Phase 6 §6.4's path.
        await expect(built.system).toMatchFileSnapshot(
          `../prompts/__snapshots__/${promptId}.${code}.txt`,
        );
      });
    }
  }
});

/**
 * The version-bump guard, and the reason it is a digest file rather than a snapshot.
 *
 * A snapshot test fails on *any* change and is fixed by running `vitest -u`, which is exactly
 * how a prompt edit ships with a stale `promptVersion`. The Phase 5 response cache keys on
 * `promptId` + `promptVersion`, so a stale version means a bumped prompt is a cache **hit**:
 * the CI gate then passes on numbers the previous prompt produced, and the whole mechanism is
 * theatre. §5.10 calls that "one line in §5.8" and this is the test that holds it up.
 *
 * `prompt-versions.json` is committed and hand-updated. Both halves are asserted — a changed
 * rendering under an unchanged version fails, and a bumped version with a stale digest fails
 * too — so the only way through is to record both, in a diff a reviewer can read.
 */
describe('prompt version guard', () => {
  const recorded = JSON.parse(
    readFileSync(`${here}../prompts/prompt-versions.json`, 'utf8'),
  ) as Record<string, { version: number; sha256: string }>;

  for (const promptId of Object.keys(BUILDERS)) {
    it(`${promptId}: a changed rendering requires a new version`, () => {
      const digest = createHash('sha256');
      for (const code of SNAPSHOT_CODES) digest.update(BUILDERS[promptId]!(code).system, 'utf8');
      const sha256 = digest.digest('hex');
      const entry = recorded[promptId];

      expect(entry, `${promptId} is missing from prompt-versions.json`).toBeDefined();
      expect(
        entry!.version,
        `${promptId}: prompt-versions.json records v${entry!.version} but the builder ` +
          `returns v${VERSIONS[promptId]}`,
      ).toBe(VERSIONS[promptId]);
      expect(
        sha256,
        `${promptId} renders differently from the text recorded for v${entry!.version}. ` +
          'Bump promptVersion in the prompt module and record the new digest in ' +
          'prompt-versions.json — a prompt change that keeps its version is a cache hit, and ' +
          'the CI gate would then pass on the old prompt\'s numbers.',
      ).toBe(entry!.sha256);
    });
  }
});

describe('promptVars', () => {
  it('splits a clause mark out of the sentence enders', () => {
    // The registry lists `။` and `၊` together under sentenceEnders. A prompt that offered
    // both as sentence-ending punctuation would be telling a model the Burmese comma ends a
    // sentence — which is the kind of error that reads as fluent output.
    const my = promptVars('my-MM');
    expect(my.sentenceEnd).toEqual(['။']);
    expect(my.clausePunct).toEqual(['၊']);

    const am = promptVars('am-ET');
    expect(am.sentenceEnd).not.toContain('፣');
    expect(am.clausePunct).toEqual(['፣', '፤']);
  });

  it('carries script facts, not language guesses', () => {
    expect(promptVars('my-MM').hasCase).toBe(false);
    expect(promptVars('ha-NG').hasCase).toBe(true);
    expect(promptVars('ps-AF').direction).toBe('rtl');
    expect(promptVars('my-MM').spacing).toBe('phrase-level');
    expect(promptVars('ha-NG').spacing).toBe('inter-word');
    // CJK does not space at all, so it must not inherit the phrase-boundary permission that
    // Burmese, Khmer, Lao and Thai get from `wordSegmentation: 'none'`.
    expect(promptVars('ja-JP').spacing).toBe('none');
    expect(promptVars('my-MM').digitsExample).toBe('၀၁၂၃ or 0123');
    expect(promptVars('ha-NG').digitsExample).toBe('0123');
  });

  it('never subtracts every sentence ender a language has', () => {
    // The failure this guards is quiet: put a mark in a script's `clausePunct` that is the
    // *only* sentence ender some language using that script has, and every prompt for that
    // language silently loses its sentence-ending permission. Nothing else would notice.
    const lost: string[] = [];
    for (const [code, entry] of Object.entries(LANGUAGES)) {
      if (entry.text.punctuation.sentenceEnders.length === 0) continue;
      if (promptVars(code).sentenceEnd.length === 0) lost.push(code);
    }
    expect(lost).toEqual([]);
  });

  it('refuses an unknown code rather than rendering defaults', () => {
    // A prompt rendered from defaults instructs a model in the punctuation of no language in
    // particular, and it looks entirely normal in the output.
    expect(() => promptVars('zz-ZZ')).toThrow(UnknownLanguageError);
  });
});

describe('cleanup.restraint', () => {
  it('never re-adds the two lines that caused the damage', () => {
    for (const code of SNAPSHOT_CODES) {
      const { system } = cleanup(code, CLEANUP_RESTRAINT);
      // `cleanup.ts:17` — the measured cause. In a low-resource language it licenses the
      // model to "correct" text that was already right.
      expect(system).not.toMatch(/Fix obvious spelling/iu);
      // `cleanup.ts:19-21` — the escape hatch. `UN → Wọ́n` is a model deciding it knew the
      // unambiguous correct form.
      expect(system).not.toMatch(/unambiguous/iu);
    }
  });

  it('names no language but its own', () => {
    const hausa = cleanup('ha-NG', CLEANUP_RESTRAINT).system;
    expect(hausa).toContain('Hausa');
    expect(hausa).not.toContain('Burmese');
    expect(hausa).not.toContain('မြန်မာ');
  });

  it('emits the directional-mark constraint for RTL only', () => {
    expect(cleanup('ps-AF', CLEANUP_RESTRAINT).system).toContain('directional marks');
    expect(cleanup('ha-NG', CLEANUP_RESTRAINT).system).not.toContain('directional marks');
  });

  it('omits a permission it has no marks for', () => {
    // Thai ends sentences with a space, and the registry says so by carrying no sentence
    // enders. A line reading "Sentence-ending punctuation:" with nothing after it is a
    // permission with no object; the safe reading of an unlisted mark is "do not insert it".
    const thai = cleanup('th-TH', CLEANUP_RESTRAINT).system;
    expect(thai).not.toContain('Sentence-ending punctuation');
    expect(thai).not.toContain('Clause-internal punctuation');
    expect(cleanup('my-MM', CLEANUP_RESTRAINT).system).toContain('Sentence-ending punctuation: ။');
  });

  it('states the case rule the script actually has', () => {
    expect(cleanup('my-MM', CLEANUP_RESTRAINT).system).toContain('no letter case');
    expect(cleanup('ha-NG', CLEANUP_RESTRAINT).system).toContain('sentence-initial capitals');
  });
});

describe('cleanup.current', () => {
  it('keeps the two lines, because the arm is the text that shipped', () => {
    // This variant exists to be measured, not used. Tidying it up would make the gate's
    // regression arm a measurement of something nobody ships.
    const system = cleanup('my-MM', CLEANUP_CURRENT).system;
    expect(system).toContain('Fix obvious spelling and Unicode normalization errors');
    expect(system).toContain('unless');
    expect(system).toContain('unambiguous');
  });

  it('is a different prompt id and version from the restraint one', () => {
    expect(cleanup('my-MM', CLEANUP_CURRENT).promptId).toBe('cleanup.current');
    expect(cleanup('my-MM', CLEANUP_RESTRAINT).promptId).toBe('cleanup.restraint');
    expect(cleanup('my-MM', CLEANUP_RESTRAINT).promptVersion).toBe(3);
  });
});

describe('the JSON envelope', () => {
  it('is identical across prompts and stable in key order', () => {
    // Hashed into the response cache key: a formatting change here silently invalidates every
    // cached LLM response in the tree.
    const expected = '{"segments":[{"idx":0,"text":"the first segment"},{"idx":1,"text":"the second"}]}';
    expect(cleanup('my-MM', CLEANUP_RESTRAINT).user).toBe(expected);
    expect(translate('my-MM').user).toBe(expected);
  });
});

describe('translate.default', () => {
  it('takes its target as a parameter', () => {
    const toEnglish = buildTranslatePrompt({
      source: promptVars('my-MM'),
      target: promptVars('en-US'),
      segments: SEGMENTS,
    });
    const toFrench = buildTranslatePrompt({
      source: promptVars('my-MM'),
      target: promptVars('fr-FR'),
      segments: SEGMENTS,
    });
    expect(toEnglish.system).toContain('English');
    expect(toFrench.system).toContain('French');
    expect(toFrench.system).not.toContain('English');
    expect(toEnglish.promptId).toBe('translate.default');
  });

  it('omits the glossary block entirely when there is none', () => {
    const bare = translate('my-MM').system;
    expect(bare).not.toContain('Fixed terminology');
    const withGlossary = buildTranslatePrompt({
      source: promptVars('my-MM'),
      target: promptVars('en-US'),
      segments: SEGMENTS,
      glossaryBlock: 'Fixed terminology. Use these renderings exactly:\n  x → y',
    });
    expect(withGlossary.system).toContain('Fixed terminology');
  });
});
