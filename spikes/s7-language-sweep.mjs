/**
 * Which of our 116 seeded languages will `gpt-4o-transcribe-diarize` even accept?
 *
 * The probe found `language=my` rejected outright — *"Language code 'my' is not
 * recognized"* — which is a stronger signal than anything Phase 4a got from Groq, where a
 * wrong-language transcript came back HTTP 200 with healthy-looking confidences. A 400 on
 * the language parameter is the provider stating its own coverage, and OpenAI does not
 * publish the list for this model.
 *
 * So enumerate it. One request per code against the committed 2 s clip, recording only
 * whether the code was accepted. **This measures acceptance, not quality** — Phase 4a's
 * central finding was that those are different things, and every 200 here means "the
 * validator recognised the code", nothing more. The rejections are the load-bearing half.
 *
 *   node spikes/s7-language-sweep.mjs OUTDIR
 *
 * Writes OUTDIR/s7-language-sweep.json.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? '.');
const ROOT = resolve(import.meta.dirname, '..');
process.loadEnvFile(resolve(ROOT, '.env'));

const KEY = process.env.OPENAI_API_KEY;
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'gpt-4o-transcribe-diarize';
const CLIP = resolve(ROOT, 'packages/languages/fixtures/probe-2s.flac');

const seeded = Object.values(
  JSON.parse(await readFile(resolve(ROOT, 'packages/languages/data/languages.json'), 'utf8'))
    .languages,
);

// The API takes ISO-639-1. Our registry is BCP-47 with a region, so the sweep is over the
// distinct 639-1 codes — `en-US`, `en-GB` and `en-IN` are one code to this endpoint, and
// asking three times would only measure our own registry's shape.
//
// The entries with a null `iso639_1` are not a gap in the sweep; they are the answer for
// those languages. There is no code to send, so no `language` can be pinned and the model
// can only be asked to autodetect — and autodetect is what returned Latin transliteration
// for Burmese. Recorded separately rather than counted as rejections.
const noIso1 = seeded.filter((l) => !l.iso639_1).map((l) => l.code);
const codes = [...new Set(seeded.map((l) => l.iso639_1).filter(Boolean))].sort();

const bytes = await readFile(CLIP);

async function probe(code, standard) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'audio/flac' }), 'probe-2s.flac');
  form.set('model', MODEL);
  form.set('response_format', 'diarized_json');
  form.set('language', code);
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  return {
    code,
    standard,
    status: response.status,
    accepted: response.status === 200,
    error: body.error?.message ?? null,
    // The clip is Burmese. For any code that is not Burmese the text is expected to be
    // wrong — it is kept so that the *accepted Burmese* codes can be read directly.
    text: body.text ?? null,
  };
}

const results = [];
async function sweep(list, standard) {
  for (const code of list) {
    try {
      results.push(await probe(code, standard));
    } catch (err) {
      results.push({ code, standard, status: 0, accepted: false, error: String(err.message), text: null });
    }
    process.stdout.write(results.at(-1).accepted ? '.' : 'x');
    await new Promise((res) => setTimeout(res, 250));
  }
  process.stdout.write('\n');
}

await sweep(codes, 'iso639-1');

// Second pass. `my` is rejected but `mya` is accepted, so the endpoint's vocabulary is not
// one standard — it is a list, and a 639-1 rejection does not mean the language is absent.
// Anything not already accepted gets its 639-3 tried, which is the only code the 13
// locales with no 639-1 have at all.
const acceptedNow = new Set(results.filter((r) => r.accepted).map((r) => r.code));
const iso3 = [
  ...new Set(
    seeded
      .filter((l) => !l.iso639_1 || !acceptedNow.has(l.iso639_1))
      .map((l) => l.iso639_3)
      .filter(Boolean),
  ),
].sort();
await sweep(iso3, 'iso639-3');

const accepted = results.filter((r) => r.accepted).map((r) => r.code);
const rejected = results.filter((r) => !r.accepted);
const acceptedSet = new Set(accepted);

// Which of the seeded locales does that leave with no code the endpoint will take at all?
const unsupported = seeded
  .filter((l) => !acceptedSet.has(l.iso639_1) && !acceptedSet.has(l.iso639_3))
  .map((l) => l.code);

await writeFile(
  resolve(OUT, 's7-language-sweep.json'),
  JSON.stringify(
    {
      model: MODEL,
      probedAt: new Date().toISOString(),
      clip: 'packages/languages/fixtures/probe-2s.flac',
      note: 'Acceptance of the `language` parameter only. A 200 is not evidence of quality.',
      iso639_1CodesProbed: codes.length,
      iso639_3CodesProbed: iso3.length,
      registryLocalesWithNoIso639_1: noIso1,
      accepted,
      rejected: rejected.map(({ code, standard, status, error }) => ({ code, standard, status, error })),
      registryLocalesWithoutSupport: unsupported,
      results,
    },
    null,
    2,
  ) + '\n',
);

console.log(`probed     ${results.length} codes (${codes.length} × 639-1, ${iso3.length} × 639-3)`);
console.log(`accepted   ${accepted.length}  ${accepted.join(' ')}`);
console.log(`rejected   ${rejected.length}  ${rejected.map((r) => r.code).join(' ')}`);
console.log(`registry locales with no ISO-639-1  ${noIso1.length}  ${noIso1.join(' ')}`);
console.log(`of our ${seeded.length} seeded locales, ${unsupported.length} have no accepted code:`);
console.log(`  ${unsupported.join(' ')}`);

// The whole point of Phase 4a, restated: acceptance is not support. The clip is Burmese,
// so every accepted Burmese code should have produced Myanmar script.
const burmese = results.filter((r) => r.accepted && ['my', 'mya'].includes(r.code));
for (const r of burmese) {
  const myanmar = [...(r.text ?? '')].filter((c) => c >= 'က' && c <= '႟').length;
  console.log(
    `burmese code '${r.code}' accepted → ${myanmar} Myanmar-script chars of ${(r.text ?? '').length}: ${JSON.stringify(r.text)}`,
  );
}
