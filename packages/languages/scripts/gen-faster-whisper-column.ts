/**
 * Derive the `faster-whisper` column of `data/provider-matrix.json`.
 *
 *   pnpm --filter @thibi/languages exec tsx scripts/gen-faster-whisper-column.ts
 *
 * **This is not a probe, and that is the point.** Every other column in the matrix is
 * written by `thibi probe languages` from real HTTP responses. faster-whisper runs locally,
 * and the question "will this model accept this code" has a *better* answer than a status
 * code: the Whisper tokenizer either has a token for the language or it does not. A code
 * outside `data/whisper-language-codes.json` cannot be conditioned on at all; a code inside
 * it is guaranteed to be accepted. Probing 100 languages against a local model would have
 * cost hours and produced a weaker fact.
 *
 * What it says about *quality* is nothing whatsoever, which is why every row lands as
 * `verdict: 'probe-only'` and why Phase 5's sweep is the thing that promotes them.
 *
 * **The doubt is inherited where it was measured.** faster-whisper runs the same
 * `whisper-large-v3` weights Groq serves, so a language Groq was measured mangling is not an
 * open question here — it is a measured failure of the same model behind a different
 * transport. Those rows are marked `suspected` in `data/matrix-overrides.json` rather than
 * here, because overrides are hand-judged corrections that a regeneration must never erase.
 *
 * Idempotent: running it twice produces no diff, which `pnpm gen`'s drift test relies on.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Capability {
  status: 'accepted' | 'rejected' | 'error' | 'unknown';
  supported: boolean;
  verdict: 'probe-only' | 'measured-ok' | 'measured-failure' | 'suspected';
  providerCode: string;
  models?: string[];
  wordTimestamps: boolean | null;
  adaptation: 'none' | 'phrase-set' | 'prompt' | 'unknown';
  probedAt: string;
  reason?: string;
}

interface MatrixFile {
  _meta: unknown;
  providers: Record<string, unknown>;
  languages: Record<string, Record<string, Capability>>;
}

const EXTRACTED_AT = '2026-08-12';
const MODELS = ['large-v3'];

const whisper = JSON.parse(readFileSync('data/whisper-language-codes.json', 'utf8')) as {
  _meta: { extractedFrom: string; extractedAt: string };
  codes: string[];
};
const accepted = new Set(whisper.codes);

const matrix = JSON.parse(readFileSync('data/provider-matrix.json', 'utf8')) as MatrixFile;
const languages = JSON.parse(readFileSync('data/languages.json', 'utf8')) as {
  languages: Record<string, { iso639_1: string | null; nameEn: string }>;
};

let withRow = 0;
let withoutRow = 0;

for (const [code, row] of Object.entries(matrix.languages)) {
  // The code to send. Prefer whatever the OpenAI probe measured, because it is the same
  // model family and the mapping was confirmed against a live endpoint; fall back to the
  // registry's own ISO 639-1. Both can be absent — five registry languages have no 639-1
  // code at all — and those simply get no row.
  const providerCode = row['openai']?.providerCode ?? languages.languages[code]?.iso639_1 ?? null;

  if (!providerCode || !accepted.has(providerCode)) {
    // **No row, rather than a row saying `rejected`.** "The tokenizer has no token for this
    // language" and "we asked and it said no" are different claims, and `whisperLanguageCode`
    // already turns an absent row into a sentence naming the language and the provider.
    delete row['faster-whisper'];
    withoutRow += 1;
    continue;
  }

  row['faster-whisper'] = {
    status: 'accepted',
    supported: true,
    verdict: 'probe-only',
    providerCode,
    models: MODELS,
    // Real ones, from the decoder — the only genuine per-word confidence in the system.
    wordTimestamps: true,
    adaptation: 'prompt',
    probedAt: EXTRACTED_AT,
    reason: 'the Whisper tokenizer has a token for this language; quality is unmeasured',
  };
  withRow += 1;
}

matrix.providers['faster-whisper'] = {
  accepted: withRow,
  codesTried: Object.keys(matrix.languages).length,
  errored: 0,
  models: MODELS,
  probedAt: EXTRACTED_AT,
  rejected: 0,
  unknown: withoutRow,
  // Provenance, because this column did not come from where the others did.
  source: `${whisper._meta.extractedFrom}, tokenizer table read ${whisper._meta.extractedAt}`,
  note:
    'Derived from the Whisper tokenizer rather than probed over HTTP — see ' +
    'scripts/gen-faster-whisper-column.ts. Acceptance is certain and quality is unmeasured.',
};

writeFileSync('data/provider-matrix.json', `${JSON.stringify(matrix, null, 2)}\n`);
console.log(
  `faster-whisper column: ${withRow} languages with a row, ${withoutRow} without ` +
    '(no Whisper token for the language).',
);
