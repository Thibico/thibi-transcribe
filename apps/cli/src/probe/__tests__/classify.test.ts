import { describe, expect, it } from 'vitest';
import type { ProviderLanguageCapability } from '@thibi/languages';
import { classifyLanguage, classifyOutcome } from '../classify.js';
import { whisperCode } from '../whisper.js';
import type { ProbeOutcome } from '../types.js';

const BASE = { providerCode: 'my-MM', probedAt: '2026-08-09', adaptation: 'none' } as const;

const ok = (over: Partial<ProbeOutcome> = {}): ProbeOutcome => ({
  httpStatus: 200,
  transcript: 'မင်္ဂလာပါ',
  hasWords: true,
  ...over,
});

const unsupported = (message = "Language 'xx' is not supported."): ProbeOutcome => ({
  httpStatus: 400,
  transcript: '',
  hasWords: null,
  errorMessage: message,
});

const otherBadRequest: ProbeOutcome = {
  httpStatus: 400,
  transcript: '',
  hasWords: null,
  errorMessage: 'Invalid audio encoding: could not decode the supplied content.',
};

const rateLimited: ProbeOutcome = {
  httpStatus: 429,
  transcript: '',
  hasWords: null,
  errorMessage: 'Rate limit reached.',
};

const PREVIOUSLY_ACCEPTED: ProviderLanguageCapability = {
  status: 'accepted',
  supported: true,
  verdict: 'probe-only',
  providerCode: 'my-MM',
  models: ['chirp_2'],
  wordTimestamps: true,
  adaptation: 'none',
  probedAt: '2026-07-30',
};

describe('classifyOutcome', () => {
  it('reads a 200 as acceptance', () => {
    expect(classifyOutcome(ok())).toBe('accepted');
  });

  // Every string here was returned by a live endpoint during the 2026-08-09 probe. The
  // four providers word the same verdict four different ways and none of them uses a
  // distinguishing status code, so this table is the whole contract.
  it.each([
    ['Google', 'Bad language code'],
    [
      'OpenAI',
      "Language code 'ha' is not recognized. Try adding the language name to your prompt.",
    ],
    ['Groq', 'unsupported language: xx\nLanguage must be one of: [gu ms sl oc yi lo ht mt fr]'],
    ['generic', "Language 'xx' is not supported."],
    ['generic', 'Invalid value at language_code'],
  ])('reads a %s rejection as a rejection', (_provider, message) => {
    expect(classifyOutcome(unsupported(message))).toBe('rejected');
  });

  it('reads any other 400 as an error needing a human', () => {
    expect(classifyOutcome(otherBadRequest)).toBe('error');
  });

  it('reads a rate limit as unknown, never as rejection', () => {
    expect(classifyOutcome(rateLimited)).toBe('unknown');
    expect(classifyOutcome({ httpStatus: 503, transcript: '', hasWords: null })).toBe('unknown');
    expect(classifyOutcome({ httpStatus: 0, transcript: '', hasWords: null })).toBe('unknown');
  });
});

describe('classifyLanguage', () => {
  it('records an acceptance as probe-only, never as measured quality', () => {
    const row = classifyLanguage({ ...BASE, attempts: [{ model: 'chirp_2', outcome: ok() }] });
    expect(row).toMatchObject({
      status: 'accepted',
      supported: true,
      verdict: 'probe-only',
      models: ['chirp_2'],
      wordTimestamps: true,
      probedAt: '2026-08-09',
    });
  });

  it('accepts if any model accepts, and lists only the models that did', () => {
    const row = classifyLanguage({
      ...BASE,
      attempts: [
        { model: 'whisper-1', outcome: unsupported() },
        { model: 'gpt-4o-transcribe', outcome: ok({ hasWords: false }) },
      ],
    });
    expect(row.status).toBe('accepted');
    expect(row.models).toEqual(['gpt-4o-transcribe']);
  });

  it('records wordTimestamps as null when the clip produced no transcript', () => {
    // The probe clip is Burmese. Silence under ha-NG says nothing about whether Hausa
    // would return word offsets, and recording `false` would invent a finding.
    const row = classifyLanguage({
      ...BASE,
      attempts: [{ model: 'chirp_2', outcome: ok({ transcript: '', hasWords: null }) }],
    });
    expect(row.status).toBe('accepted');
    expect(row.wordTimestamps).toBeNull();
  });

  it('records a rejection as a measured failure', () => {
    const row = classifyLanguage({
      ...BASE,
      attempts: [{ model: 'whisper-1', outcome: unsupported() }],
    });
    expect(row).toMatchObject({ status: 'rejected', supported: false, verdict: 'measured-failure' });
  });

  // The three rules below are the whole reason this is a pure function with tests.
  it('leaves a previous acceptance untouched after an unrecognised 400', () => {
    const row = classifyLanguage({
      ...BASE,
      attempts: [{ model: 'chirp_2', outcome: otherBadRequest }],
      previous: PREVIOUSLY_ACCEPTED,
    });
    expect(row.status).toBe('error');
    expect(row.supported).toBe(true);
    expect(row.wordTimestamps).toBe(true);
    expect(row.models).toEqual(['chirp_2']);
  });

  it('does not let a rate limit erase a previous acceptance', () => {
    const row = classifyLanguage({
      ...BASE,
      attempts: [{ model: 'chirp_2', outcome: rateLimited }],
      previous: PREVIOUSLY_ACCEPTED,
    });
    expect(row.status).toBe('unknown');
    expect(row.supported).toBe(true);
  });

  it('does not refresh probedAt when it learned nothing', () => {
    // Otherwise a year of rate-limited re-runs would make stale data look current, and
    // the probedAt date in /settings/languages is the whole freshness discipline.
    const row = classifyLanguage({
      ...BASE,
      attempts: [{ model: 'chirp_2', outcome: rateLimited }],
      previous: PREVIOUSLY_ACCEPTED,
    });
    expect(row.probedAt).toBe('2026-07-30');
  });

  it('marks an unmeasurable code with no history as unknown, claiming nothing', () => {
    const row = classifyLanguage({ ...BASE, attempts: [{ model: 'chirp_2', outcome: rateLimited }] });
    expect(row).toMatchObject({ status: 'unknown', supported: false, probedAt: 'never' });
  });

  it('carries a hand-written reason and evidence through a re-probe', () => {
    // The Groq Burmese finding must survive every future run of the probe.
    const row = classifyLanguage({
      ...BASE,
      attempts: [{ model: 'whisper-large-v3', outcome: ok() }],
      previous: {
        ...PREVIOUSLY_ACCEPTED,
        reason: 'Accepts language=my and returns non-words.',
        evidence: 'research/language-support-whisper-vs-google.md, 2026-07-30',
      },
    });
    expect(row.reason).toBe('Accepts language=my and returns non-words.');
    expect(row.evidence).toContain('2026-07-30');
    // The probe still records the 200 it actually saw. Only matrix-overrides.json can
    // turn `supported` back off, and it is merged after this.
    expect(row.supported).toBe(true);
  });
});

describe('whisperCode', () => {
  it.each([
    ['my-MM', 'my'],
    ['ha-NG', 'ha'],
    ['ps-AF', 'ps'],
    // Whisper has one Chinese, not a Simplified/Traditional split.
    ['cmn-Hans-CN', 'zh'],
    ['cmn-Hant-TW', 'zh'],
    ['yue-Hant-HK', 'yue'],
    // Whisper's tokenizer predates the rename to Filipino.
    ['fil-PH', 'tl'],
    ['nb-NO', 'no'],
    // No ISO 639-1 code exists; the primary subtag is what it sends.
    ['ceb-PH', 'ceb'],
    ['ckb-IQ', 'ckb'],
    ['pa-Guru-IN', 'pa'],
  ])('%s -> %s', (code, expected) => {
    expect(whisperCode(code)).toBe(expected);
  });
});
