import { LANGUAGES, PROVIDER_MATRIX, type ProviderId } from '@thibi/languages';
import { UnsupportedLanguageError } from '../../errors.js';

/**
 * Registry code → the code a Whisper endpoint actually takes.
 *
 * **The matrix is the mapping, not a function.** Every `(language, provider)` pair carries a
 * `providerCode` written by `thibi probe languages`, which is where the exceptions live:
 * `fil-PH` sends `tl` because Whisper's tokenizer predates the rename to Filipino, both
 * Chinese locales send `zh` because Whisper has one Chinese, and `nb-NO` sends `no`.
 * Deriving the code here — `code.split('-')[0]`, or reading `iso639_1` — reproduces three of
 * those wrong and is the kind of thing that looks correct until a Filipino newsroom gets a
 * 400.
 */
export function whisperLanguageCode(registryCode: string, providerId: ProviderId): string {
  const capability = PROVIDER_MATRIX[registryCode]?.[providerId];
  if (capability?.providerCode) return capability.providerCode;

  // No matrix row at all: the provider was never probed for this language. Fail before
  // spending a request, and say which command fixes it.
  const language = LANGUAGES[registryCode];
  if (!language) {
    throw new UnsupportedLanguageError(
      `${registryCode} is not in the language registry, so there is no code to send to ` +
        `${providerId}.`,
    );
  }
  throw new UnsupportedLanguageError(
    `${providerId} has never been probed for ${registryCode} (${language.nameEn}), so the ` +
      `code to send is unknown.`,
    { hint: `Run \`thibi probe languages --provider ${providerId}\`.` },
  );
}

/**
 * The five languages with no ISO 639-1 code at all.
 *
 * Whisper's `language` parameter is documented as ISO-639-1, and these have only a 639-3
 * code: Cebuano, Northern Sotho, Luo, Kabuverdianu and Umbundu. The 2026-08-09 probe
 * confirmed every Whisper endpoint rejects all five — they are `status: 'rejected'` in the
 * matrix — so this list is an explanation of *why* rather than a second gate. It exists to
 * stop someone "fixing" the matrix by sending the 639-3 code and concluding the provider is
 * broken when it 400s.
 */
export const NO_ISO_639_1: readonly string[] = ['ceb-PH', 'nso-ZA', 'luo-KE', 'kea-CV', 'umb-AO'];

export function lacksIso639_1(registryCode: string): boolean {
  return LANGUAGES[registryCode]?.iso639_1 === null;
}
