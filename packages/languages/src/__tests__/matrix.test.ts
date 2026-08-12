import { describe, expect, it } from 'vitest';
import { PROVIDER_MATRIX } from '../generated/registry.gen.js';
import { createRegistry } from '../registry.js';

const registry = createRegistry();

/**
 * The provider matrix is what turns this product's strategic claim into a number anyone
 * can re-derive. Probed live on 2026-08-09 against Google `chirp_2`, OpenAI `whisper-1`
 * and `gpt-4o-transcribe`, and Groq `whisper-large-v3`, with one 2-second clip per code.
 */
describe('provider matrix', () => {
  it('has a google row for every registry language', () => {
    for (const language of registry.list()) {
      expect(language.providers.google, language.code).toBeDefined();
      expect(language.providers.google!.status, language.code).toBe('accepted');
    }
  });

  /**
   * The headline: 44 languages Google handles that no OpenAI model will accept. The
   * 2026-07-30 research measured 44 and the 2026-08-09 probe reproduces it exactly.
   *
   * Both OpenAI models are probed, because the figure is the union of whisper-1's list
   * and gpt-4o-transcribe's wider one. Probing only whisper-1 would inflate this and the
   * assertion would pass for the wrong reason.
   */
  it('reproduces the 44 languages no OpenAI model accepts', () => {
    const exclusive = registry.list({ provider: 'google', notSupportedBy: 'openai' });
    expect(exclusive.length).toBe(44);
    for (const code of ['ha-NG', 'ig-NG', 'ceb-PH', 'om-ET', 'ckb-IQ', 'my-MM', 'km-KH', 'ps-AF']) {
      expect(exclusive.map((l) => l.code), code).toContain(code);
    }
  });

  /**
   * Twenty languages every Whisper-family endpoint tested rejects, plus Burmese — which is
   * here for the second time and for a better reason than before.
   *
   * The number went 21 → 20 → 21 in a day. It dropped when Phase 4b gave faster-whisper a
   * matrix column derived from the Whisper tokenizer: `my` has a token, `suspected` leaves
   * `supported: true`, and Burmese acquired a claimant on no evidence (amendment 51). It came
   * back when somebody ran it (spike S9, amendment 52): `language=my` returns Khmer script or
   * nothing at all, autodetect returns Vietnamese YouTube boilerplate at mean word
   * probability 0.892. The same weights fail the same way behind a different transport.
   *
   * **So this row now rests on a measurement rather than on nobody having looked**, which is
   * the difference the whole overrides mechanism exists to record. Two of the twenty-one are
   * now measured failures at HTTP 200 rather than honest rejections.
   */
  it('finds 21 languages no other provider covers, two of them by measurement', () => {
    const only = registry.list({ exclusiveTo: 'google' }).map((l) => l.code);
    expect(only.length).toBe(21);
    expect(only).toEqual(
      [
        'ast-ES', 'ceb-PH', 'ckb-IQ', 'ff-SN', 'ga-IE', 'ig-NG', 'kam-KE', 'kea-CV', 'ky-KG',
        'lg-UG', 'luo-KE', 'my-MM', 'nso-ZA', 'ny-MW', 'om-ET', 'or-IN', 'rup-BG', 'umb-AO',
        'wo-SN', 'xh-ZA', 'zu-ZA',
      ].sort(),
    );
    // Burmese is here because two providers were run and both mangled it — never because a
    // status code was trusted, and no longer because a column was missing.
    expect(only).toContain('my-MM');
    for (const provider of ['groq', 'faster-whisper'] as const) {
      const capability = registry.get('my-MM')!.providers[provider]!;
      expect(capability.status, provider).toBe('accepted');
      expect(capability.supported, provider).toBe(false);
      expect(capability.verdict, provider).toBe('measured-failure');
    }
  });

  it('records what faster-whisper actually returned for Burmese', () => {
    // The evidence string is the row. A `measured-failure` a reader cannot check is an
    // assertion wearing a verdict's clothes.
    const fw = registry.get('my-MM')!.providers['faster-whisper']!;
    expect(fw.evidence).toMatch(/KHMER/);
    expect(fw.evidence).toMatch(/empty transcript/);
    expect(fw.evidence).toMatch(/0\.892/);
    expect(fw.evidence).toMatch(/RESULTS\.md#s9/);
  });

  it('keeps the Groq Burmese finding through a re-probe', () => {
    const groq = registry.get('my-MM')!.providers.groq!;
    // The probe saw a 200 on 2026-08-09 and recorded it. The override still wins.
    expect(groq.status).toBe('accepted');
    expect(groq.supported).toBe(false);
    expect(groq.verdict).toBe('measured-failure');
    expect(groq.reason).toMatch(/non-words/);
    expect(groq.evidence).toMatch(/2026-07-30/);
    expect(groq.providerCode).toBe('my');
  });

  it('marks the suspected family as unverified without claiming it is broken', () => {
    // Marking a whole family unsupported on a hunch would be the same error as marking it
    // supported on a status code, in the other direction.
    for (const code of ['km-KH', 'lo-LA', 'si-LK', 'ps-AF', 'am-ET']) {
      const groq = registry.get(code)!.providers.groq!;
      expect(groq.verdict, code).toBe('suspected');
      expect(groq.reason, code).toBeTruthy();
      expect(groq.supported, code).toBe(true);
    }
  });

  it('sends each provider the code that provider understands', () => {
    expect(registry.get('my-MM')!.providers.google!.providerCode).toBe('my-MM');
    expect(registry.get('my-MM')!.providers.groq!.providerCode).toBe('my');
    // Whisper has one Chinese, not a Simplified/Traditional split.
    expect(registry.get('cmn-Hans-CN')!.providers.groq!.providerCode).toBe('zh');
    expect(registry.get('cmn-Hant-TW')!.providers.groq!.providerCode).toBe('zh');
  });

  it('never claims adaptation works on Chirp', () => {
    // Spike S1, 2026-08-09: boost 0/10/20 byte-identical, relevant keyterms produced zero
    // lexical change, and an irrelevant phrase set corrupted five occurrences of a word
    // the baseline got right. Nothing in the product may promise keyterm biasing here.
    for (const language of registry.list()) {
      expect(language.providers.google!.adaptation, language.code).toBe('none');
    }
  });

  /**
   * Overview Risk 2 says word timings are the spine of half the design and the least
   * reliable field in the response, and worries that Chirp may return a transcript with an
   * empty word array for long-tail languages.
   *
   * Measured 2026-08-09: it does not, for any of the 116 codes. Chirp returned a non-empty
   * transcript *and* word offsets for every one — it transcribes the Burmese clip as
   * something in whatever language it was asked for rather than returning silence.
   *
   * That is real evidence, not proof: one 2-second clip, one model, one day. The no-words
   * path (`wordTimingQuality`, `segments.has_words`) is still built first in Phase 1,
   * because the fallback also covers providers that genuinely lack the field. But the
   * long-tail Google languages are no longer the expected reason it will fire.
   */
  it('finds word timings available for every Google language', () => {
    const google = registry.list().map((l) => l.providers.google!);
    expect(google.every((c) => c.wordTimestamps === true)).toBe(true);
    // Nothing was inferred from an empty transcript: `null` means unknown, and the fact
    // that none appear here is a measurement, not a default.
    expect(google.some((c) => c.wordTimestamps === null)).toBe(false);
  });

  it('carries a probe date and clip hash for every probed language', () => {
    for (const row of Object.values(PROVIDER_MATRIX)) {
      for (const [provider, capability] of Object.entries(row)) {
        expect(capability.probedAt, provider).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});
